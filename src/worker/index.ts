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
import { postProcessTranscript, mergeChunkSegments } from '../lib/transcription/post-process';
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

async function downloadFileFromWeb(storageKey: string, destPath: string): Promise<void> {
  const encodedKey = encodeURIComponent(storageKey);
  const url = `${WEB_URL}/api/internal/files/${encodedKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buffer);
}

async function uploadArtifactToWeb(storageKey: string, data: Buffer): Promise<void> {
  const url = `${WEB_URL}/api/internal/files`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-storage-key': storageKey },
    body: new Uint8Array(data),
  });
  if (!response.ok) throw new Error(`Failed to upload artifact: ${response.status}`);
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

async function generateMeetingReport(transcript: string, language: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNames: Record<string, string> = { pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French' };
  const langName = langNames[language] || 'English';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `You are a professional meeting analyst. Generate a structured meeting report in ${langName} from the transcript provided. The report must include:

1. **Meeting Summary** — 2-3 paragraph executive summary
2. **Key Topics Discussed** — bullet list of main topics
3. **Decisions Made** — specific decisions reached during the meeting
4. **Action Items** — tasks assigned with responsible person (if identifiable) and deadlines (if mentioned)
5. **Open Questions** — unresolved items that need follow-up
6. **Next Steps** — agreed next steps or follow-up meetings

Use clear professional language. If something is unclear from the transcript, note it as "[unclear from transcript]". Do NOT invent information not present in the transcript.`,
      },
      {
        role: 'user',
        content: `Generate a meeting report from this transcript:\n\n${transcript.substring(0, 15000)}`,
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

    // ===== STAGE: TRANSCRIBING =====
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
    const chunkResults: Array<{ segments: TranscriptSegmentData[]; offsetMs: number; overlapMs: number }> = [];
    let detectedLanguage: string | undefined;

    for (const chunk of chunks) {
      if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');

      const chunkProgress = STAGE_WEIGHTS.transcribing.start +
        ((chunk.index + 1) / chunks.length) * (STAGE_WEIGHTS.transcribing.end - STAGE_WEIGHTS.transcribing.start);
      await updateJobProgress(jobId, 'transcribing', chunkProgress, `Transcribing chunk ${chunk.index + 1}/${chunks.length}...`);
      await log.info('transcribing', `Transcribing chunk ${chunk.index + 1}/${chunks.length}`);

      const result = await transcriber.transcribe(chunk.path, {
        language: job.sourceLanguage || undefined, mode,
        prompt: mode === 'best_quality'
          ? 'Transcribe with proper punctuation, casing, and paragraph breaks. Mark unclear audio as [inaudible].'
          : undefined,
      });

      if (!detectedLanguage && result.detectedLanguage) detectedLanguage = result.detectedLanguage;

      chunkResults.push({
        segments: result.segments,
        offsetMs: Math.round(chunk.startSeconds * 1000),
        overlapMs: Math.round(overlapSeconds * 1000),
      });
      await log.info('transcribing', `Chunk ${chunk.index + 1}: ${result.segments.length} segments`);
    }

    const langCodeMap: Record<string, string> = {
      'portuguese': 'pt', 'english': 'en', 'spanish': 'es', 'french': 'fr',
      'pt': 'pt', 'en': 'en', 'es': 'es', 'fr': 'fr',
    };
    const effectiveLanguage = langCodeMap[(detectedLanguage || '').toLowerCase()]
      || langCodeMap[(job.sourceLanguage || '').toLowerCase()]
      || job.sourceLanguage || detectedLanguage || 'en';

    await prisma.job.update({ where: { id: jobId }, data: { detectedLanguage: effectiveLanguage, providerUsed: transcriber.name } });

    await log.info('transcribing', 'Merging chunk results...');
    let mergedSegments = mergeChunkSegments(chunkResults);
    await log.info('transcribing', `Merged: ${mergedSegments.length} total segments`);

    const transcribeMs = await endStage(jobId, 'transcribing', transcribeStart);
    await log.info('transcribing', `Transcription completed in ${(transcribeMs / 1000).toFixed(1)}s`);

    // ===== STAGE: POST-PROCESSING =====
    if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
    const ppStart = await startStage(jobId, 'post_processing');
    await updateJobProgress(jobId, 'post_processing', 61, 'Post-processing transcript...');
    await log.info('post_processing', 'Post-processing transcript...');

    mergedSegments = await postProcessTranscript(mergedSegments, mode, effectiveLanguage);

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
    await log.info('post_processing', `Post-processing completed in ${(ppMs / 1000).toFixed(1)}s`);

    // ===== STAGE: TRANSLATION =====
    let translatedSegments: Array<{ sourceText: string; translatedText: string; startMs: number; endMs: number }> | null = null;
    const shouldTranslate = job.targetLanguage && job.targetLanguage !== effectiveLanguage && job.targetLanguage !== job.sourceLanguage;

    if (shouldTranslate) {
      if (await checkCancelled(jobId)) throw new Error('Job cancelled by user');
      const translateStart = await startStage(jobId, 'translating');
      await updateJobProgress(jobId, 'translating', 71, `Translating to ${job.targetLanguage}...`);
      await log.info('translating', `Translating to ${job.targetLanguage}...`);

      const translator = getTranslationProvider();
      const translationResult = await translator.translate(mergedSegments, effectiveLanguage, job.targetLanguage!);
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
    const meetingReport = await generateMeetingReport(fullTranscript, effectiveLanguage);

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
