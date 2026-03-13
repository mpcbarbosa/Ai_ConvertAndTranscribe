import { Worker, type BullJob, getWorkerConnection, QUEUE_NAME, type TranscriptionJobData } from '../lib/queue';
import prisma from '../lib/db/client';
import {
  getMediaInfo,
  convertToMp3,
  normalizeForTranscription,
  splitIntoChunks,
  cleanupFiles,
} from '../lib/media';
import { generateSrt, generateVtt, generateTxt, generateJson } from '../lib/media/artifacts';
import { getTranscriptionProvider } from '../lib/transcription';
import { postProcessTranscript, mergeChunkSegments, cleanupSegmentsBatch, lightCleanup } from '../lib/transcription/post-process';
import { getTranslationProvider } from '../lib/translation';
import { createJobLogger } from '../lib/utils/logger';
import type { TranscriptSegmentData, ProcessingMode } from '../types';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

function getWebUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  if (raw && !raw.startsWith('http')) return `https://${raw}`;
  return raw;
}

const WEB_URL = getWebUrl();

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function downloadChunk(url: string, start: number, end: number, maxRetries = 5): Promise<{ data: Buffer; totalSize: number; status: number }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Range': `bytes=${start}-${end}` },
      });

      if (response.status === 502 || response.status === 503) {
        console.log(`[download] Chunk ${start}-${end}: got ${response.status}, retry ${attempt + 1}/${maxRetries}`);
        await sleep((attempt + 1) * 5000);
        continue;
      }

      if (!response.ok && response.status !== 206) {
        const body = await response.text().catch(() => '');
        throw new Error(`Download failed: ${response.status} - ${body.substring(0, 200)}`);
      }

      // Read body — this is where "terminated" errors happen
      const data = Buffer.from(await response.arrayBuffer());

      let totalSize = -1;
      const contentRange = response.headers.get('content-range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) totalSize = parseInt(match[1]);
      }

      return { data, totalSize, status: response.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[download] Chunk ${start}-${end}: error "${msg}", retry ${attempt + 1}/${maxRetries}`);
      if (attempt === maxRetries - 1) throw err;
      await sleep((attempt + 1) * 3000);
    }
  }
  throw new Error('Max retries exceeded for chunk download');
}

async function downloadFileFromWeb(storageKey: string, destPath: string): Promise<void> {
  const url = `${WEB_URL}/api/internal/files/download?key=${encodeURIComponent(storageKey)}`;

  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const DOWNLOAD_CHUNK = 10 * 1024 * 1024; // 10MB per chunk
  let offset = 0;
  let totalSize = -1;
  const fileHandle = await fs.open(destPath, 'w');

  try {
    while (true) {
      const end = offset + DOWNLOAD_CHUNK - 1;
      const { data, totalSize: chunkTotal, status } = await downloadChunk(url, offset, end);

      if (chunkTotal > 0) totalSize = chunkTotal;

      await fileHandle.write(data, 0, data.length, offset);
      offset += data.length;

      console.log(`[download] ${(offset / 1024 / 1024).toFixed(1)} MB${totalSize > 0 ? ` / ${(totalSize / 1024 / 1024).toFixed(1)} MB` : ''}`);

      if (status !== 206 || data.length < DOWNLOAD_CHUNK) break;
      if (totalSize > 0 && offset >= totalSize) break;
    }
    console.log(`[download] Complete: ${(offset / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    await fileHandle.close();
  }
}

async function uploadArtifactToWeb(storageKey: string, data: Buffer): Promise<void> {
  const url = `${WEB_URL}/api/internal/files`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-storage-key': storageKey },
        body: new Uint8Array(data),
      });
      if (response.status === 502 || response.status === 503) {
        console.log(`[upload] Got ${response.status}, retry ${attempt + 1}/3`);
        await sleep((attempt + 1) * 3000);
        continue;
      }
      if (!response.ok) throw new Error(`Failed to upload artifact: ${response.status}`);
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      console.log(`[upload] Error, retry ${attempt + 1}/3`);
      await sleep((attempt + 1) * 3000);
    }
  }
}

// --- Progress & Timing Helpers ---

const STAGE_WEIGHTS: Record<string, { start: number; end: number }> = {
  converting:        { start: 0,  end: 15 },
  transcribing:      { start: 15, end: 60 },
  post_processing:   { start: 60, end: 70 },
  translating:       { start: 70, end: 80 },
  generating_report: { start: 80, end: 90 },
  generating_outputs:{ start: 90, end: 100 },
};

async function updateJobProgress(jobId: string, status: string, progress: number, currentStage?: string) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: status as never,
      progress: Math.min(100, Math.round(progress)),
      currentStage: currentStage || status,
    },
  });
}

async function startStage(jobId: string, stage: string): Promise<Date> {
  const now = new Date();
  await prisma.stageTiming.create({
    data: { jobId, stage, startedAt: now },
  });
  return now;
}

async function endStage(jobId: string, stage: string, startedAt: Date): Promise<number> {
  const now = new Date();
  const durationMs = now.getTime() - startedAt.getTime();
  await prisma.stageTiming.updateMany({
    where: { jobId, stage, completedAt: null },
    data: { completedAt: now, durationMs },
  });
  return durationMs;
}

async function checkCancelled(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
  return job?.cancelRequested === true;
}

// --- Meeting Report Generator ---

async function generateMeetingReport(transcript: string, language: string, mode: ProcessingMode): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNames: Record<string, string> = { pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French' };
  const langName = langNames[language] || 'English';

  // Use more transcript (up to 25k chars) for better analysis
  const transcriptForAnalysis = transcript.substring(0, 25000);

  const response = await openai.chat.completions.create({
    model: mode === 'best_quality' ? 'gpt-4o' : 'gpt-4o-mini',
    temperature: 0.25,
    max_tokens: 4000,
    messages: [
      {
        role: 'system',
        content: `You are a senior business analyst and meeting intelligence specialist. Write in ${langName}.

Generate an EXTREMELY DETAILED and COMPREHENSIVE meeting report. This report should be professional enough for executive review and detailed enough for operational follow-up.

The report MUST include ALL of the following sections:

# 📋 Meeting Report

## 1. Executive Summary
- 3-4 paragraph comprehensive summary covering the full scope of the meeting
- Highlight the most critical outcomes and their business impact
- Mention key participants and their roles where identifiable from the transcript

## 2. Meeting Context & Objectives
- What was the apparent purpose/agenda of this meeting
- What context or background was established at the start
- What were the stated or implied goals

## 3. Detailed Discussion Analysis
For EACH major topic discussed:
- **Topic title**
- What was discussed in detail
- Key arguments or perspectives presented by different participants
- Technical or functional details mentioned
- Any data, metrics, or specific examples referenced
- How the discussion evolved and what conclusion was reached (if any)

## 4. Technical & Functional Insights
- Any technical systems, tools, processes, or architectures discussed
- Functional requirements or specifications mentioned
- Integration points, dependencies, or technical constraints identified
- Performance metrics, KPIs, or benchmarks referenced

## 5. Decisions Made
For each decision:
- What was decided
- Who made or approved the decision (if identifiable)
- Rationale or context behind the decision
- Expected impact or implications

## 6. Action Items & Responsibilities
For each action item (format as a clear table/list):
- Task description (specific and actionable)
- Responsible person/team (if identifiable)
- Deadline or timeline (if mentioned)
- Priority (inferred from context: High/Medium/Low)
- Dependencies (if any)

## 7. Risks & Concerns Identified
- Any risks, blockers, or concerns raised during the meeting
- Who raised them and what mitigation was discussed
- Unresolved concerns that need attention

## 8. Open Questions & Pending Items
- Questions that were raised but not fully answered
- Items that were deferred or need further investigation
- Information gaps identified during the discussion

## 9. Key Metrics & Data Points
- Any numbers, dates, budgets, timelines, or metrics mentioned
- Comparative data or benchmarks discussed
- Financial figures or resource estimates

## 10. Next Steps & Follow-up
- Agreed next steps with owners and timelines
- Follow-up meetings or checkpoints planned
- Deliverables expected before next meeting

## 11. Meeting Assessment
- Overall meeting effectiveness (were objectives met?)
- Key takeaways (3-5 bullet points)
- Recommendations for follow-up

---

IMPORTANT RULES:
- Be thorough and detailed — extract MAXIMUM value from the transcript
- Use specific quotes or references from the transcript to support key points
- If participants can be identified by name, reference them
- If something is unclear, mark it as "[requires clarification]"
- Do NOT fabricate information not present in the transcript
- Use professional, clear language with proper formatting
- Use bullet points, sub-sections, and emphasis for readability
- If technical topics are discussed, explain them with appropriate depth`,
      },
      {
        role: 'user',
        content: `Generate a comprehensive, detailed meeting report from this transcript:\n\n${transcriptForAnalysis}`,
      },
    ],
  });

  return response.choices[0]?.message?.content || 'Report generation failed.';
}

// --- Main Job Processor ---

async function processJob(bullJob: BullJob<TranscriptionJobData>) {
  const { jobId } = bullJob.data;
  const log = createJobLogger(jobId);
  const tmpDir = path.join(os.tmpdir(), 'transcribex', jobId);
  const jobStartTime = Date.now();

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} not found`);

    await log.info('start', `Processing job: ${job.originalFileName}`);

    const originalArtifact = await prisma.jobArtifact.findFirst({
      where: { jobId, type: 'original' },
    });
    if (!originalArtifact) throw new Error('Original file artifact not found');

    const originalLocalPath = path.join(tmpDir, 'original_input' + path.extname(job.originalFileName || '.bin'));
    await log.info('start', 'Downloading file from web service...');
    await downloadFileFromWeb(originalArtifact.storagePath, originalLocalPath);
    await log.info('start', 'File downloaded to worker');

    const mode = job.processingMode as ProcessingMode;

    // ===== STAGE: CONVERTING =====
    const convertStart = await startStage(jobId, 'converting');
    await updateJobProgress(jobId, 'converting', 2, 'Extracting and converting audio...');
    await log.info('converting', 'Generating MP3 from original...');

    const mp3Path = path.join(tmpDir, 'output.mp3');
    await convertToMp3(originalLocalPath, mp3Path);

    // Check cancellation
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');

    await updateJobProgress(jobId, 'converting', 8, 'Uploading MP3...');
    const mp3StorageKey = `jobs/${jobId}/output.mp3`;
    const mp3Data = await fs.readFile(mp3Path);
    await uploadArtifactToWeb(mp3StorageKey, mp3Data);
    await prisma.jobArtifact.create({
      data: { jobId, type: 'mp3', storagePath: mp3StorageKey, mimeType: 'audio/mpeg', sizeBytes: mp3Data.length },
    });
    await cleanupFiles(mp3Path);
    await log.info('converting', `MP3 generated: ${(mp3Data.length / 1024 / 1024).toFixed(1)} MB`);

    await updateJobProgress(jobId, 'converting', 10, 'Normalizing audio...');
    const normalizedPath = path.join(tmpDir, 'normalized.wav');
    await normalizeForTranscription(originalLocalPath, normalizedPath);
    await cleanupFiles(originalLocalPath);

    const mediaInfo = await getMediaInfo(normalizedPath);
    await prisma.job.update({ where: { id: jobId }, data: { durationSeconds: mediaInfo.durationSeconds } });
    await log.info('converting', `Audio duration: ${mediaInfo.durationSeconds}s`);

    const convertMs = await endStage(jobId, 'converting', convertStart);
    await log.info('converting', `Converting completed in ${(convertMs / 1000).toFixed(1)}s`);

    // ===== STAGE: TRANSCRIBING + POST-PROCESSING (PIPELINED) =====
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
    const transcribeStart = await startStage(jobId, 'transcribing');
    await updateJobProgress(jobId, 'transcribing', 16, 'Splitting audio into chunks...');

    const chunkDir = path.join(tmpDir, 'chunks');
    const chunkDuration = mode === 'best_quality' ? 480 : 600;
    const overlapSeconds = mode === 'best_quality' ? 20 : 10;
    const chunks = await splitIntoChunks(normalizedPath, chunkDir, {
      chunkDurationSeconds: chunkDuration, overlapSeconds,
    });
    await log.info('transcribing', `Split into ${chunks.length} chunk(s)`);

    const transcriber = getTranscriptionProvider();
    const TRANSCRIBE_CONCURRENCY = 6;
    const CLEANUP_BATCH_SIZE = 80;
    const isBestQuality = mode === 'best_quality';
    const cleanupModel = isBestQuality ? 'gpt-4o' : 'gpt-4o-mini';
    let detectedLanguage: string | undefined;
    let completedTranscribe = 0;
    let completedCleanup = 0;
    const totalSteps = chunks.length * 2; // transcribe + cleanup per chunk

    // Pre-allocate results: each chunk's cleaned segments
    const cleanedChunkResults: Array<{
      segments: TranscriptSegmentData[];
      offsetMs: number;
      overlapMs: number;
    } | null> = new Array(chunks.length).fill(null);

    // Pipeline: transcribe chunk → immediately cleanup its segments
    // Run TRANSCRIBE_CONCURRENCY chunk pipelines in parallel
    for (let batchStart = 0; batchStart < chunks.length; batchStart += TRANSCRIBE_CONCURRENCY) {
      if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');

      const batch = chunks.slice(batchStart, batchStart + TRANSCRIBE_CONCURRENCY);
      await log.info('transcribing', `Pipeline batch ${batchStart + 1}-${Math.min(batchStart + TRANSCRIBE_CONCURRENCY, chunks.length)}/${chunks.length} (transcribe+cleanup parallel)...`);

      const pipelinePromises = batch.map(async (chunk) => {
        // Step A: Transcribe this chunk
        const result = await transcriber.transcribe(chunk.path, {
          language: job.sourceLanguage || undefined, mode,
          prompt: isBestQuality
            ? 'Transcribe with proper punctuation, casing, and paragraph breaks. Mark unclear audio as [inaudible].'
            : undefined,
        });

        if (!detectedLanguage && result.detectedLanguage) detectedLanguage = result.detectedLanguage;
        completedTranscribe++;

        const progress = ((completedTranscribe + completedCleanup) / totalSteps) * 55 + 15;
        await updateJobProgress(jobId, 'transcribing', progress, `Transcribed ${completedTranscribe}/${chunks.length}, cleaned ${completedCleanup}/${chunks.length}...`);
        await log.info('transcribing', `Chunk ${chunk.index + 1} transcribed: ${result.segments.length} segments`);

        // Step B: Immediately cleanup this chunk's segments (pipelined)
        let cleanedSegments: TranscriptSegmentData[];
        if (isBestQuality && result.segments.length > 0) {
          // Split into sub-batches for cleanup
          const subBatches: TranscriptSegmentData[][] = [];
          for (let i = 0; i < result.segments.length; i += CLEANUP_BATCH_SIZE) {
            subBatches.push(result.segments.slice(i, i + CLEANUP_BATCH_SIZE));
          }
          const cleanedSubs = await Promise.all(
            subBatches.map(sub => cleanupSegmentsBatch(sub, job.sourceLanguage || undefined, cleanupModel))
          );
          cleanedSegments = cleanedSubs.flat();
        } else {
          cleanedSegments = result.segments.map(s => ({ ...s, text: lightCleanup(s.text) }));
        }

        completedCleanup++;
        const progress2 = ((completedTranscribe + completedCleanup) / totalSteps) * 55 + 15;
        await updateJobProgress(jobId, 'transcribing', progress2, `Transcribed ${completedTranscribe}/${chunks.length}, cleaned ${completedCleanup}/${chunks.length}...`);
        await log.info('transcribing', `Chunk ${chunk.index + 1} cleaned: ${cleanedSegments.length} segments`);

        cleanedChunkResults[chunk.index] = {
          segments: cleanedSegments,
          offsetMs: Math.round(chunk.startSeconds * 1000),
          overlapMs: Math.round(overlapSeconds * 1000),
        };
      });

      await Promise.all(pipelinePromises);
    }

    const validResults = cleanedChunkResults.filter((r): r is NonNullable<typeof r> => r !== null);

    const langCodeMap: Record<string, string> = {
      'portuguese': 'pt', 'english': 'en', 'spanish': 'es', 'french': 'fr',
      'pt': 'pt', 'en': 'en', 'es': 'es', 'fr': 'fr',
    };
    const effectiveLanguage = langCodeMap[(detectedLanguage || '').toLowerCase()]
      || langCodeMap[(job.sourceLanguage || '').toLowerCase()]
      || job.sourceLanguage || detectedLanguage || 'en';

    await prisma.job.update({ where: { id: jobId }, data: { detectedLanguage: effectiveLanguage, providerUsed: transcriber.name } });

    await log.info('transcribing', 'Merging chunk results...');
    let mergedSegments = mergeChunkSegments(validResults);
    await log.info('transcribing', `Merged: ${mergedSegments.length} total segments`);

    const transcribeMs = await endStage(jobId, 'transcribing', transcribeStart);
    await log.info('transcribing', `Transcription+cleanup pipeline completed in ${(transcribeMs / 1000).toFixed(1)}s`);

    // Save segments to DB
    await updateJobProgress(jobId, 'post_processing' as never, 72, 'Saving segments...');
    const ppStart = await startStage(jobId, 'post_processing');

    for (let i = 0; i < mergedSegments.length; i++) {
      await prisma.transcriptSegment.create({
        data: {
          jobId, startMs: mergedSegments[i].startMs, endMs: mergedSegments[i].endMs,
          sourceText: mergedSegments[i].text, speakerLabel: mergedSegments[i].speakerLabel,
          confidence: mergedSegments[i].confidence, chunkIndex: 0, segmentIndex: i,
        },
      });
    }

    const ppMs = await endStage(jobId, 'post_processing', ppStart);
    await log.info('post_processing', `Segments saved in ${(ppMs / 1000).toFixed(1)}s`);

    // ===== STAGE: TRANSLATION =====
    let translatedSegments: Array<{ sourceText: string; translatedText: string; startMs: number; endMs: number }> | null = null;
    const shouldTranslate = job.targetLanguage && job.targetLanguage !== effectiveLanguage && job.targetLanguage !== job.sourceLanguage;

    if (shouldTranslate) {
      if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
      const translateStart = await startStage(jobId, 'translating');
      await updateJobProgress(jobId, 'translating', 71, `Translating to ${job.targetLanguage}...`);
      await log.info('translating', `Translating to ${job.targetLanguage}...`);

      const translator = getTranslationProvider();
      const translationResult = await translator.translate(mergedSegments, effectiveLanguage, job.targetLanguage!, mode);
      translatedSegments = translationResult.segments;

      const dbSegments = await prisma.transcriptSegment.findMany({ where: { jobId }, orderBy: { segmentIndex: 'asc' } });
      for (let i = 0; i < Math.min(dbSegments.length, translatedSegments.length); i++) {
        await prisma.transcriptSegment.update({
          where: { id: dbSegments[i].id },
          data: { translatedText: translatedSegments[i].translatedText },
        });
      }

      const translateMs = await endStage(jobId, 'translating', translateStart);
      await log.info('translating', `Translation completed in ${(translateMs / 1000).toFixed(1)}s`);
    } else {
      await log.info('translating', 'Translation skipped — same language or no target set');
    }

    // ===== STAGE: MEETING REPORT =====
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
    const reportStart = await startStage(jobId, 'generating_report');
    await updateJobProgress(jobId, 'generating_report' as never, 81, 'Generating meeting report...');
    await log.info('generating_report', 'Generating meeting report...');

    const fullTranscript = mergedSegments.map(s => s.text).join(' ');
    const meetingReport = await generateMeetingReport(fullTranscript, effectiveLanguage, mode);

    await prisma.job.update({ where: { id: jobId }, data: { meetingReport } });

    // Save report as artifact
    const reportKey = `jobs/${jobId}/meeting_report.md`;
    await uploadArtifactToWeb(reportKey, Buffer.from(meetingReport, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'meeting_report', storagePath: reportKey, mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(meetingReport) },
    });

    const reportMs = await endStage(jobId, 'generating_report', reportStart);
    await log.info('generating_report', `Meeting report generated in ${(reportMs / 1000).toFixed(1)}s`);

    // ===== STAGE: GENERATING OUTPUTS =====
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
    const outputStart = await startStage(jobId, 'generating_outputs');
    await updateJobProgress(jobId, 'generating_outputs', 91, 'Generating output files...');
    await log.info('generating_outputs', 'Generating output files...');

    const segmentsForArtifact = mergedSegments.map((s, i) => ({
      ...s, translatedText: translatedSegments?.[i]?.translatedText,
    }));

    const metadata = {
      sourceLanguage: job.sourceLanguage || undefined,
      detectedLanguage: effectiveLanguage,
      targetLanguage: job.targetLanguage || undefined,
      durationSeconds: mediaInfo.durationSeconds,
      processingMode: mode,
    };

    // Transcript TXT
    const transcriptTxt = generateTxt(segmentsForArtifact, false);
    const txtKey = `jobs/${jobId}/transcript.txt`;
    await uploadArtifactToWeb(txtKey, Buffer.from(transcriptTxt, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'transcript_txt', storagePath: txtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(transcriptTxt) } });

    // Transcript JSON
    const transcriptJson = generateJson(segmentsForArtifact, metadata);
    const jsonKey = `jobs/${jobId}/transcript.json`;
    await uploadArtifactToWeb(jsonKey, Buffer.from(transcriptJson, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'transcript_json', storagePath: jsonKey, mimeType: 'application/json', sizeBytes: Buffer.byteLength(transcriptJson) } });

    // SRT + VTT
    const srtContent = generateSrt(segmentsForArtifact, false);
    const srtKey = `jobs/${jobId}/subtitles.srt`;
    await uploadArtifactToWeb(srtKey, Buffer.from(srtContent, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'srt', storagePath: srtKey, mimeType: 'application/x-subrip', sizeBytes: Buffer.byteLength(srtContent) } });

    const vttContent = generateVtt(segmentsForArtifact, false);
    const vttKey = `jobs/${jobId}/subtitles.vtt`;
    await uploadArtifactToWeb(vttKey, Buffer.from(vttContent, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'vtt', storagePath: vttKey, mimeType: 'text/vtt', sizeBytes: Buffer.byteLength(vttContent) } });

    // Translation files
    if (translatedSegments) {
      const translationTxt = generateTxt(segmentsForArtifact, true);
      const tTxtKey = `jobs/${jobId}/translation.txt`;
      await uploadArtifactToWeb(tTxtKey, Buffer.from(translationTxt, 'utf-8'));
      await prisma.jobArtifact.create({ data: { jobId, type: 'translation_txt', storagePath: tTxtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(translationTxt) } });

      const translationJson = generateJson(segmentsForArtifact, { ...metadata, targetLanguage: job.targetLanguage || undefined });
      const tJsonKey = `jobs/${jobId}/translation.json`;
      await uploadArtifactToWeb(tJsonKey, Buffer.from(translationJson, 'utf-8'));
      await prisma.jobArtifact.create({ data: { jobId, type: 'translation_json', storagePath: tJsonKey, mimeType: 'application/json', sizeBytes: Buffer.byteLength(translationJson) } });
    }

    await updateJobProgress(jobId, 'generating_outputs', 98, 'Finalizing...');
    const outputMs = await endStage(jobId, 'generating_outputs', outputStart);
    await log.info('generating_outputs', `Output generation completed in ${(outputMs / 1000).toFixed(1)}s`);

    // ===== COMPLETED =====
    const totalMs = Date.now() - jobStartTime;
    await updateJobProgress(jobId, 'completed', 100, 'Completed');
    await prisma.job.update({ where: { id: jobId }, data: { completedAt: new Date() } });
    await log.info('complete', `Job completed successfully in ${(totalMs / 1000).toFixed(1)}s total`);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Job ${jobId} failed:`, err);

    if (errorMessage === 'Job cancelled by user') {
      await prisma.job.update({ where: { id: jobId }, data: { status: 'cancelled' as never, errorMessage: 'Cancelled by user' } });
      await createJobLogger(jobId).info('cancelled', 'Job cancelled by user');
      return; // Don't retry cancelled jobs
    }

    await prisma.job.update({ where: { id: jobId }, data: { status: 'failed' as never, errorMessage, progress: 0 } });
    await createJobLogger(jobId).error('failed', errorMessage);
    throw err;
  } finally {
    await cleanupFiles(tmpDir);
  }
}

// Start the worker
console.log('Starting TranscribeX worker...');

const worker = new Worker<TranscriptionJobData>(
  QUEUE_NAME, processJob,
  { connection: getWorkerConnection(), concurrency: 1, limiter: { max: 2, duration: 60000 } }
);

worker.on('completed', (job) => console.log(`Job ${job.data.jobId} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.data.jobId} failed:`, err.message));
worker.on('error', (err) => console.error('Worker error:', err));

process.on('SIGTERM', async () => { await worker.close(); process.exit(0); });
process.on('SIGINT', async () => { await worker.close(); process.exit(0); });

console.log('Worker is ready and listening for jobs.');
