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

/**
 * Download file directly from R2 storage to local disk.
 * Streams the file — no full-file memory allocation.
 */
async function downloadFromR2(storageKey: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  const bucket = process.env.R2_BUCKET_NAME || 'aiconverttranscribe';
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));

  const stream = response.Body as import('stream').Readable;
  const fileHandle = await fs.open(destPath, 'w');
  let offset = 0;

  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      await fileHandle.write(buf, 0, buf.length, offset);
      offset += buf.length;
    }
  } finally {
    await fileHandle.close();
  }

  console.log(`[download] R2 direct: ${(offset / 1024 / 1024).toFixed(1)} MB downloaded`);
}

/**
 * Download file — uses R2 direct if configured, otherwise HTTP from web service.
 */
async function downloadFile(storageKey: string, destPath: string): Promise<void> {
  const useR2 = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ID);

  if (useR2) {
    console.log(`[download] Direct R2 download: ${storageKey}`);
    await downloadFromR2(storageKey, destPath);
    return;
  }

  // Fallback: HTTP chunked download from web service
  console.log(`[download] HTTP download from web service: ${storageKey}`);
  const url = `${WEB_URL}/api/internal/files/download?key=${encodeURIComponent(storageKey)}`;
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const DOWNLOAD_CHUNK = 10 * 1024 * 1024;
  let offset = 0;
  let totalSize = -1;
  const fileHandle = await fs.open(destPath, 'w');

  try {
    while (true) {
      const end = offset + DOWNLOAD_CHUNK - 1;

      let data: Buffer, chunkTotal: number, status: number;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await fetch(url, { headers: { 'Range': `bytes=${offset}-${end}` } });
          if (response.status === 502 || response.status === 503) {
            await sleep((attempt + 1) * 5000);
            continue;
          }
          if (!response.ok && response.status !== 206) {
            throw new Error(`Download failed: ${response.status}`);
          }
          data = Buffer.from(await response.arrayBuffer());
          const cr = response.headers.get('content-range');
          chunkTotal = cr ? parseInt(cr.match(/\/(\d+)/)?.[1] || '-1') : -1;
          status = response.status;
          break;
        } catch (err) {
          if (attempt === 4) throw err;
          await sleep((attempt + 1) * 3000);
        }
      }

      if (chunkTotal! > 0) totalSize = chunkTotal!;
      await fileHandle.write(data!, 0, data!.length, offset);
      offset += data!.length;

      if (status! !== 206 || data!.length < DOWNLOAD_CHUNK) break;
      if (totalSize > 0 && offset >= totalSize) break;
    }
  } finally {
    await fileHandle.close();
  }
}

async function uploadArtifact(storageKey: string, data: Buffer): Promise<void> {
  const useR2 = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ID);

  if (useR2) {
    // Direct R2 upload
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    });
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME || 'aiconverttranscribe',
      Key: storageKey,
      Body: data,
    }));
    return;
  }

  // Fallback: HTTP upload to web service
  const url = `${WEB_URL}/api/internal/files`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-storage-key': storageKey },
        body: new Uint8Array(data),
      });
      if (response.status === 502 || response.status === 503) {
        await sleep((attempt + 1) * 3000);
        continue;
      }
      if (!response.ok) throw new Error(`Failed to upload artifact: ${response.status}`);
      return;
    } catch (err) {
      if (attempt === 2) throw err;
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

async function generateTechnicalReport(transcript: string, language: string, mode: ProcessingMode, domainContext: string): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNames: Record<string, string> = { pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French' };
  const langName = langNames[language] || 'English';
  const transcriptForAnalysis = transcript.substring(0, 30000);

  const response = await openai.chat.completions.create({
    model: mode === 'best_quality' ? 'gpt-4o' : 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `You are a senior technical consultant and domain expert in ${domainContext}. Write in ${langName}.

Generate a COMPREHENSIVE TECHNICAL AND FUNCTIONAL ANALYSIS DOCUMENT based on the meeting transcript. This is NOT a meeting summary — it is a professional deliverable document that a consultant would produce after attending this meeting.

Act as the world's leading expert in ${domainContext}. Use industry-specific terminology, frameworks, methodologies, and best practices.

The document MUST include ALL of these sections:

# Technical & Functional Analysis Document

## 1. Executive Overview
- Project context and objectives identified
- Stakeholders and their roles
- Scope boundaries discussed

## 2. Requirements Matrix
Create a detailed table/list of all requirements discussed:
- Requirement description
- Functional area
- Priority (Critical/High/Medium/Low) — infer from discussion emphasis
- Coverage level (Standard/Partial/Gap/Custom)
- Notes and observations

## 3. Functional Analysis
For each major functional area discussed:
- Current state (as-is) — what was described about current processes
- Desired state (to-be) — what was requested or envisioned
- Gap analysis — what needs to change
- Specific features, configurations, or customizations discussed
- Data and integration requirements

## 4. Technical Gaps & Challenges
For each identified gap:
- Description of the gap
- Business impact
- Recommended solution approach
- Estimated complexity (Low/Medium/High)
- Dependencies

## 5. Solution Architecture
Based on the discussion:
- Proposed solution components
- Integration points
- Third-party tools or extensions needed
- Technical architecture considerations
- Data flow and process flow

## 6. Implementation Roadmap
- Recommended project phases
- Estimated effort per phase
- Key milestones
- Critical path items
- Risk factors

## 7. Business Process Mapping
For each business process discussed:
- Process name and description
- Key steps identified
- Automation opportunities
- Roles involved
- KPIs or metrics mentioned

## 8. Data & Integration Requirements
- Data migration needs
- System integrations discussed
- API or interface requirements
- Data quality considerations

## 9. Risk Assessment
- Technical risks
- Functional risks
- Organizational risks
- Mitigation strategies

## 10. Recommendations & Next Steps
- Priority recommendations (quick wins, medium-term, long-term)
- Suggested project approach
- Required resources
- Success criteria

## 11. Open Items & Clarifications Needed
- Questions requiring follow-up
- Decisions pending
- Information gaps

IMPORTANT RULES:
- This is a TECHNICAL DOCUMENT, not a meeting summary
- Use your expert knowledge of ${domainContext} to ADD VALUE beyond what was explicitly said
- Cross-reference requirements against standard capabilities where applicable
- Be specific with technical terminology and product features
- Create tables and structured data where appropriate
- If you identify requirements that weren't explicitly stated but are typically needed, flag them as "implied requirements"
- Write in ${langName}`,
      },
      {
        role: 'user',
        content: `Generate a comprehensive technical and functional analysis document from this meeting about ${domainContext}:\n\n${transcriptForAnalysis}`,
      },
    ],
  });

  return response.choices[0]?.message?.content || 'Technical report generation failed.';
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

    // Get all original artifacts (supports multi-file upload)
    const originalArtifacts = await prisma.jobArtifact.findMany({
      where: { jobId, type: 'original' },
      orderBy: { createdAt: 'asc' },
    });
    if (originalArtifacts.length === 0) throw new Error('Original file artifact not found');

    const isMultiFile = originalArtifacts.length > 1;
    if (isMultiFile) await log.info('start', `Multi-file job: ${originalArtifacts.length} files to concatenate`);

    // Download all original files
    const originalPaths: string[] = [];
    for (let fi = 0; fi < originalArtifacts.length; fi++) {
      const ext = path.extname(originalArtifacts[fi].storagePath || '.bin');
      const localPath = path.join(tmpDir, `original_${fi}${ext}`);
      await log.info('start', `Downloading file ${fi + 1}/${originalArtifacts.length} from web service...`);
      await downloadFile(originalArtifacts[fi].storagePath, localPath);
      originalPaths.push(localPath);
    }
    await log.info('start', `${originalArtifacts.length} file(s) downloaded to worker`);

    const mode = job.processingMode as ProcessingMode;

    // ===== STAGE: CONVERTING =====
    const convertStart = await startStage(jobId, 'converting');
    await updateJobProgress(jobId, 'converting', 2, 'Extracting and converting audio...');

    // Convert each file to MP3, then concatenate if multi-file
    const mp3Parts: string[] = [];
    for (let fi = 0; fi < originalPaths.length; fi++) {
      const partMp3 = path.join(tmpDir, `part_${fi}.mp3`);
      await log.info('converting', `Converting file ${fi + 1}/${originalPaths.length} to MP3...`);
      await convertToMp3(originalPaths[fi], partMp3);
      mp3Parts.push(partMp3);
      await cleanupFiles(originalPaths[fi]);
    }

    let mp3Path: string;
    if (isMultiFile) {
      // Concatenate MP3s using FFmpeg concat filter
      mp3Path = path.join(tmpDir, 'output.mp3');
      const concatList = path.join(tmpDir, 'concat_list.txt');
      const listContent = mp3Parts.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(concatList, listContent);

      await log.info('converting', `Concatenating ${mp3Parts.length} MP3 files...`);
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('ffmpeg', [
        '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy', '-y', mp3Path,
      ]);

      // Cleanup parts
      for (const part of mp3Parts) await cleanupFiles(part);
      await cleanupFiles(concatList);
      await log.info('converting', 'MP3 files concatenated');
    } else {
      mp3Path = mp3Parts[0];
    }

    // Check cancellation
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');

    // Upload MP3 artifact
    await updateJobProgress(jobId, 'converting', 8, 'Uploading MP3...');
    const mp3StorageKey = `jobs/${jobId}/output.mp3`;
    const mp3Data = await fs.readFile(mp3Path);
    await uploadArtifact(mp3StorageKey, mp3Data);
    await prisma.jobArtifact.create({
      data: { jobId, type: 'mp3', storagePath: mp3StorageKey, mimeType: 'audio/mpeg', sizeBytes: mp3Data.length },
    });
    await log.info('converting', `MP3 ready: ${(mp3Data.length / 1024 / 1024).toFixed(1)} MB`);

    // Normalize MP3 to WAV for transcription (BEFORE cleaning up the MP3)
    await updateJobProgress(jobId, 'converting', 10, 'Normalizing audio...');
    const normalizedPath = path.join(tmpDir, 'normalized.wav');
    await normalizeForTranscription(mp3Path, normalizedPath);
    await cleanupFiles(mp3Path);

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
    const TRANSCRIBE_CONCURRENCY = 4; // 4 parallel — balances speed vs rate limits
    const CLEANUP_BATCH_SIZE = 80;
    const isBestQuality = mode === 'best_quality';
    const cleanupModel = 'gpt-4o-mini'; // Fast cleanup — quality diff minimal
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

    // Generate meeting report (always)
    const meetingReport = await generateMeetingReport(fullTranscript, effectiveLanguage, mode);

    // Save version 1 of meeting report
    await prisma.reportVersion.create({
      data: { jobId, reportType: 'meeting', content: meetingReport, label: 'Original', version: 1 },
    });

    // Generate technical report if domain context was specified
    let technicalReport: string | null = null;
    if (job.domainContext) {
      await updateJobProgress(jobId, 'generating_report' as never, 86, 'Generating technical analysis...');
      await log.info('generating_report', `Generating technical report for domain: ${job.domainContext}...`);
      technicalReport = await generateTechnicalReport(fullTranscript, effectiveLanguage, mode, job.domainContext);

      // Save version 1 of technical report
      await prisma.reportVersion.create({
        data: { jobId, reportType: 'technical', content: technicalReport, label: 'Original', version: 1 },
      });
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { meetingReport, technicalReport },
    });

    // Save reports as artifacts
    const reportKey = `jobs/${jobId}/meeting_report.md`;
    await uploadArtifact(reportKey, Buffer.from(meetingReport, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'meeting_report', storagePath: reportKey, mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(meetingReport) },
    });

    if (technicalReport) {
      const techReportKey = `jobs/${jobId}/technical_report.md`;
      await uploadArtifact(techReportKey, Buffer.from(technicalReport, 'utf-8'));
      await prisma.jobArtifact.create({
        data: { jobId, type: 'meeting_report', storagePath: techReportKey, mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(technicalReport) },
      });
    }

    const reportMs = await endStage(jobId, 'generating_report', reportStart);
    await log.info('generating_report', `Reports generated in ${(reportMs / 1000).toFixed(1)}s`);

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
    await uploadArtifact(txtKey, Buffer.from(transcriptTxt, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'transcript_txt', storagePath: txtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(transcriptTxt) } });

    // Transcript JSON
    const transcriptJson = generateJson(segmentsForArtifact, metadata);
    const jsonKey = `jobs/${jobId}/transcript.json`;
    await uploadArtifact(jsonKey, Buffer.from(transcriptJson, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'transcript_json', storagePath: jsonKey, mimeType: 'application/json', sizeBytes: Buffer.byteLength(transcriptJson) } });

    // SRT + VTT
    const srtContent = generateSrt(segmentsForArtifact, false);
    const srtKey = `jobs/${jobId}/subtitles.srt`;
    await uploadArtifact(srtKey, Buffer.from(srtContent, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'srt', storagePath: srtKey, mimeType: 'application/x-subrip', sizeBytes: Buffer.byteLength(srtContent) } });

    const vttContent = generateVtt(segmentsForArtifact, false);
    const vttKey = `jobs/${jobId}/subtitles.vtt`;
    await uploadArtifact(vttKey, Buffer.from(vttContent, 'utf-8'));
    await prisma.jobArtifact.create({ data: { jobId, type: 'vtt', storagePath: vttKey, mimeType: 'text/vtt', sizeBytes: Buffer.byteLength(vttContent) } });

    // Translation files
    if (translatedSegments) {
      const translationTxt = generateTxt(segmentsForArtifact, true);
      const tTxtKey = `jobs/${jobId}/translation.txt`;
      await uploadArtifact(tTxtKey, Buffer.from(translationTxt, 'utf-8'));
      await prisma.jobArtifact.create({ data: { jobId, type: 'translation_txt', storagePath: tTxtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(translationTxt) } });

      const translationJson = generateJson(segmentsForArtifact, { ...metadata, targetLanguage: job.targetLanguage || undefined });
      const tJsonKey = `jobs/${jobId}/translation.json`;
      await uploadArtifact(tJsonKey, Buffer.from(translationJson, 'utf-8'));
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
