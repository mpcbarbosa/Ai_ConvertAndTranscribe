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
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

function getWebUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  // If it's just a hostname (from Render's fromService.host), add https://
  if (raw && !raw.startsWith('http')) {
    return `https://${raw}`;
  }
  return raw;
}

const WEB_URL = getWebUrl();

/**
 * Download a file from the web service's internal API.
 * On Render, the worker and web service have separate disks,
 * so we transfer files via HTTP.
 */
async function downloadFileFromWeb(storageKey: string, destPath: string): Promise<void> {
  const encodedKey = encodeURIComponent(storageKey);
  const url = `${WEB_URL}/api/internal/files/${encodedKey}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file from web service: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buffer);
}

/**
 * Upload a generated artifact back to the web service storage via HTTP.
 */
async function uploadArtifactToWeb(storageKey: string, data: Buffer): Promise<void> {
  const url = `${WEB_URL}/api/internal/files`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-storage-key': storageKey,
    },
    body: new Uint8Array(data),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload artifact to web service: ${response.status} ${response.statusText}`);
  }
}

async function updateJobStatus(jobId: string, status: string, extra?: Record<string, unknown>) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: status as never, ...extra },
  });
}

async function processJob(bullJob: BullJob<TranscriptionJobData>) {
  const { jobId } = bullJob.data;
  const log = createJobLogger(jobId);
  const tmpDir = path.join(os.tmpdir(), 'transcribex', jobId);

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // Load job from DB
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} not found`);

    await log.info('start', `Processing job: ${job.originalFileName}`);

    // Get original file artifact reference
    const originalArtifact = await prisma.jobArtifact.findFirst({
      where: { jobId, type: 'original' },
    });
    if (!originalArtifact) throw new Error('Original file artifact not found');

    // Download original file from web service to worker tmp
    const originalLocalPath = path.join(tmpDir, 'original_input' + path.extname(job.originalFileName || '.bin'));
    await log.info('start', `Downloading file from web service...`);
    await downloadFileFromWeb(originalArtifact.storagePath, originalLocalPath);
    await log.info('start', `File downloaded to worker`);

    const mode = job.processingMode as ProcessingMode;

    // Step 1: Generate MP3 directly from original file (preserves quality, proper compression)
    await updateJobStatus(jobId, 'converting');
    await log.info('converting', 'Generating MP3 from original...');

    const mp3Path = path.join(tmpDir, 'output.mp3');
    await convertToMp3(originalLocalPath, mp3Path);

    // Save MP3 artifact
    const mp3StorageKey = `jobs/${jobId}/output.mp3`;
    const mp3Data = await fs.readFile(mp3Path);
    await uploadArtifactToWeb(mp3StorageKey, mp3Data);
    await prisma.jobArtifact.create({
      data: {
        jobId,
        type: 'mp3',
        storagePath: mp3StorageKey,
        mimeType: 'audio/mpeg',
        sizeBytes: mp3Data.length,
      },
    });
    await cleanupFiles(mp3Path);
    await log.info('converting', `MP3 generated: ${(mp3Data.length / 1024 / 1024).toFixed(1)} MB`);

    // Step 2: Normalize audio for transcription (16kHz mono WAV)
    await log.info('converting', 'Normalizing audio for transcription...');
    const normalizedPath = path.join(tmpDir, 'normalized.wav');
    await normalizeForTranscription(originalLocalPath, normalizedPath);

    // Delete original to free disk space
    await cleanupFiles(originalLocalPath);

    // Get audio duration
    const mediaInfo = await getMediaInfo(normalizedPath);
    await prisma.job.update({
      where: { id: jobId },
      data: { durationSeconds: mediaInfo.durationSeconds },
    });
    await log.info('converting', `Audio duration: ${mediaInfo.durationSeconds}s`);

    // Step 3: Transcribe
    await updateJobStatus(jobId, 'transcribing');
    await log.info('transcribing', 'Starting transcription...');

    // Step 3: Split into chunks if needed
    const chunkDir = path.join(tmpDir, 'chunks');
    const chunkDuration = mode === 'best_quality' ? 480 : 600; // 8min vs 10min chunks
    const overlapSeconds = mode === 'best_quality' ? 20 : 10;

    const chunks = await splitIntoChunks(normalizedPath, chunkDir, {
      chunkDurationSeconds: chunkDuration,
      overlapSeconds,
    });

    await log.info('transcribing', `Split into ${chunks.length} chunk(s)`);

    // Step 4: Transcribe each chunk
    const transcriber = getTranscriptionProvider();
    const chunkResults: Array<{
      segments: TranscriptSegmentData[];
      offsetMs: number;
      overlapMs: number;
    }> = [];

    let detectedLanguage: string | undefined;

    for (const chunk of chunks) {
      await log.info('transcribing', `Transcribing chunk ${chunk.index + 1}/${chunks.length}`);

      const result = await transcriber.transcribe(chunk.path, {
        language: job.sourceLanguage || undefined,
        mode,
        prompt: mode === 'best_quality'
          ? 'Transcribe with proper punctuation, casing, and paragraph breaks. Mark unclear audio as [inaudible].'
          : undefined,
      });

      if (!detectedLanguage && result.detectedLanguage) {
        detectedLanguage = result.detectedLanguage;
      }

      chunkResults.push({
        segments: result.segments,
        offsetMs: Math.round(chunk.startSeconds * 1000),
        overlapMs: Math.round(overlapSeconds * 1000),
      });

      await log.info('transcribing', `Chunk ${chunk.index + 1}: ${result.segments.length} segments`);
    }

    // Update detected language
    if (detectedLanguage) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          detectedLanguage,
          providerUsed: transcriber.name,
        },
      });
    }

    // Step 5: Merge chunks
    await log.info('transcribing', 'Merging chunk results...');
    let mergedSegments = mergeChunkSegments(chunkResults);
    await log.info('transcribing', `Merged: ${mergedSegments.length} total segments`);

    // Step 6: Post-process transcript
    await updateJobStatus(jobId, 'post_processing');
    await log.info('post_processing', 'Post-processing transcript...');

    // Normalize detected language to 2-letter code
    const langCodeMap: Record<string, string> = {
      'portuguese': 'pt', 'english': 'en', 'spanish': 'es', 'french': 'fr',
      'pt': 'pt', 'en': 'en', 'es': 'es', 'fr': 'fr',
    };
    const effectiveLanguage = langCodeMap[(detectedLanguage || '').toLowerCase()]
      || langCodeMap[(job.sourceLanguage || '').toLowerCase()]
      || job.sourceLanguage
      || detectedLanguage
      || 'en';
    mergedSegments = await postProcessTranscript(mergedSegments, mode, effectiveLanguage);

    // Update detected language in DB with normalized code
    await prisma.job.update({
      where: { id: jobId },
      data: { detectedLanguage: effectiveLanguage },
    });

    // Save segments to database
    for (let i = 0; i < mergedSegments.length; i++) {
      await prisma.transcriptSegment.create({
        data: {
          jobId,
          startMs: mergedSegments[i].startMs,
          endMs: mergedSegments[i].endMs,
          sourceText: mergedSegments[i].text,
          speakerLabel: mergedSegments[i].speakerLabel,
          confidence: mergedSegments[i].confidence,
          chunkIndex: 0,
          segmentIndex: i,
        },
      });
    }

    await log.info('post_processing', 'Transcript post-processing complete');

    // Step 7: Translation (only if target language is set AND different from source)
    let translatedSegments: Array<{ sourceText: string; translatedText: string; startMs: number; endMs: number }> | null = null;

    const shouldTranslate = job.targetLanguage
      && job.targetLanguage !== effectiveLanguage
      && job.targetLanguage !== job.sourceLanguage;

    if (shouldTranslate) {
      await updateJobStatus(jobId, 'translating');
      await log.info('translating', `Translating to ${job.targetLanguage}...`);

      const translator = getTranslationProvider();
      const translationResult = await translator.translate(
        mergedSegments,
        effectiveLanguage,
        job.targetLanguage!
      );

      translatedSegments = translationResult.segments;

      // Update segments with translations
      const dbSegments = await prisma.transcriptSegment.findMany({
        where: { jobId },
        orderBy: { segmentIndex: 'asc' },
      });

      for (let i = 0; i < Math.min(dbSegments.length, translatedSegments.length); i++) {
        await prisma.transcriptSegment.update({
          where: { id: dbSegments[i].id },
          data: { translatedText: translatedSegments[i].translatedText },
        });
      }

      await log.info('translating', 'Translation complete');
    } else {
      await log.info('translating', 'Translation skipped — source and target language are the same or no target set');
    }

    // Step 8: Generate output artifacts
    await updateJobStatus(jobId, 'generating_outputs');
    await log.info('generating_outputs', 'Generating output files...');

    const segmentsForArtifact = mergedSegments.map((s, i) => ({
      ...s,
      translatedText: translatedSegments?.[i]?.translatedText,
    }));

    const metadata = {
      sourceLanguage: job.sourceLanguage || undefined,
      detectedLanguage: detectedLanguage || undefined,
      targetLanguage: job.targetLanguage || undefined,
      durationSeconds: mediaInfo.durationSeconds,
      processingMode: mode,
    };

    // Transcript TXT
    const transcriptTxt = generateTxt(segmentsForArtifact, false);
    const txtKey = `jobs/${jobId}/transcript.txt`;
    await uploadArtifactToWeb(txtKey, Buffer.from(transcriptTxt, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'transcript_txt', storagePath: txtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(transcriptTxt) },
    });

    // Transcript JSON
    const transcriptJson = generateJson(segmentsForArtifact, metadata);
    const jsonKey = `jobs/${jobId}/transcript.json`;
    await uploadArtifactToWeb(jsonKey, Buffer.from(transcriptJson, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'transcript_json', storagePath: jsonKey, mimeType: 'application/json', sizeBytes: Buffer.byteLength(transcriptJson) },
    });

    // SRT
    const srtContent = generateSrt(segmentsForArtifact, false);
    const srtKey = `jobs/${jobId}/subtitles.srt`;
    await uploadArtifactToWeb(srtKey, Buffer.from(srtContent, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'srt', storagePath: srtKey, mimeType: 'application/x-subrip', sizeBytes: Buffer.byteLength(srtContent) },
    });

    // VTT
    const vttContent = generateVtt(segmentsForArtifact, false);
    const vttKey = `jobs/${jobId}/subtitles.vtt`;
    await uploadArtifactToWeb(vttKey, Buffer.from(vttContent, 'utf-8'));
    await prisma.jobArtifact.create({
      data: { jobId, type: 'vtt', storagePath: vttKey, mimeType: 'text/vtt', sizeBytes: Buffer.byteLength(vttContent) },
    });

    // Translation files (if translated)
    if (translatedSegments) {
      const translationTxt = generateTxt(segmentsForArtifact, true);
      const tTxtKey = `jobs/${jobId}/translation.txt`;
      await uploadArtifactToWeb(tTxtKey, Buffer.from(translationTxt, 'utf-8'));
      await prisma.jobArtifact.create({
        data: { jobId, type: 'translation_txt', storagePath: tTxtKey, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(translationTxt) },
      });

      const translationJson = generateJson(segmentsForArtifact, { ...metadata, targetLanguage: job.targetLanguage || undefined });
      const tJsonKey = `jobs/${jobId}/translation.json`;
      await uploadArtifactToWeb(tJsonKey, Buffer.from(translationJson, 'utf-8'));
      await prisma.jobArtifact.create({
        data: { jobId, type: 'translation_json', storagePath: tJsonKey, mimeType: 'application/json', sizeBytes: Buffer.byteLength(translationJson) },
      });
    }

    // Done!
    await updateJobStatus(jobId, 'completed', { completedAt: new Date() });
    await log.info('complete', 'Job completed successfully');

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Job ${jobId} failed:`, err);

    await updateJobStatus(jobId, 'failed', { errorMessage });
    await createJobLogger(jobId).error('failed', errorMessage);

    throw err; // Re-throw for BullMQ retry logic
  } finally {
    // Cleanup temp files
    await cleanupFiles(tmpDir);
  }
}

// Start the worker
console.log('Starting TranscribeX worker...');

const worker = new Worker<TranscriptionJobData>(
  QUEUE_NAME,
  processJob,
  {
    connection: getWorkerConnection(),
    concurrency: 1,
    limiter: {
      max: 2,
      duration: 60000,
    },
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.data.jobId} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.data.jobId} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('Worker error:', err);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
});

console.log('Worker is ready and listening for jobs.');
