import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export interface MediaInfo {
  durationSeconds: number;
  format: string;
  codec: string;
  sampleRate?: number;
  channels?: number;
}

/**
 * Get media file information using ffprobe
 */
export function getMediaInfo(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const audio = metadata.streams.find(s => s.codec_type === 'audio');
      resolve({
        durationSeconds: metadata.format.duration || 0,
        format: metadata.format.format_name || 'unknown',
        codec: audio?.codec_name || 'unknown',
        sampleRate: audio?.sample_rate ? parseInt(String(audio.sample_rate)) : undefined,
        channels: audio?.channels,
      });
    });
  });
}

/**
 * Convert video to MP3 with audio normalization
 */
export function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .audioFrequency(44100)
      .audioChannels(2)
      // Normalize audio levels
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Normalize audio for better transcription accuracy
 * Output as WAV 16kHz mono (optimal for Whisper)
 */
export function normalizeForTranscription(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioFilters([
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        'highpass=f=80',
        'lowpass=f=8000',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

export interface ChunkInfo {
  index: number;
  path: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

/**
 * Split audio into chunks with overlap for transcription.
 * Uses 10-minute chunks with 15-second overlap for context continuity.
 */
export async function splitIntoChunks(
  inputPath: string,
  outputDir: string,
  options: {
    chunkDurationSeconds?: number;
    overlapSeconds?: number;
    maxChunks?: number;
  } = {}
): Promise<ChunkInfo[]> {
  const {
    chunkDurationSeconds = 600, // 10 minutes
    overlapSeconds = 15,
    maxChunks = 50,
  } = options;

  const info = await getMediaInfo(inputPath);
  const totalDuration = info.durationSeconds;

  // If short enough, no splitting needed
  if (totalDuration <= chunkDurationSeconds + overlapSeconds) {
    return [{
      index: 0,
      path: inputPath,
      startSeconds: 0,
      endSeconds: totalDuration,
      durationSeconds: totalDuration,
    }];
  }

  await fs.mkdir(outputDir, { recursive: true });

  const chunks: ChunkInfo[] = [];
  let start = 0;
  let index = 0;

  while (start < totalDuration && index < maxChunks) {
    const end = Math.min(start + chunkDurationSeconds + overlapSeconds, totalDuration);
    const chunkPath = path.join(outputDir, `chunk_${String(index).padStart(3, '0')}.wav`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(start)
        .duration(end - start)
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .output(chunkPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    chunks.push({
      index,
      path: chunkPath,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: end - start,
    });

    start += chunkDurationSeconds; // Advance by chunk size (overlap handled by extension)
    index++;
  }

  return chunks;
}

/**
 * Clean up temporary files
 */
export async function cleanupFiles(...paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          await fs.rm(p, { recursive: true, force: true });
        } else {
          await fs.unlink(p);
        }
      }
    } catch {
      // Best effort cleanup
    }
  }
}
