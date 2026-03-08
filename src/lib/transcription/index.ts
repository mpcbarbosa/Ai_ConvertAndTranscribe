import OpenAI from 'openai';
import fs from 'fs';
import type { TranscriptSegmentData, TranscriptionResult, ProcessingMode } from '@/types';

export interface TranscriptionProvider {
  transcribe(
    audioPath: string,
    options: TranscriptionOptions
  ): Promise<TranscriptionResult>;
  readonly name: string;
}

export interface TranscriptionOptions {
  language?: string; // ISO 639-1 code, or undefined for auto-detect
  mode: ProcessingMode;
  prompt?: string; // Context hint for better accuracy
}

/**
 * OpenAI Whisper transcription provider.
 * - Best quality: uses verbose_json format with detailed timestamps
 * - Balanced: uses standard json format
 */
class OpenAIWhisperProvider implements TranscriptionProvider {
  private client: OpenAI;
  readonly name = 'openai-whisper';

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async transcribe(
    audioPath: string,
    options: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const file = fs.createReadStream(audioPath);
    const isBestQuality = options.mode === 'best_quality';

    const response = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      language: options.language || undefined,
      prompt: options.prompt || (isBestQuality
        ? 'Transcribe accurately with proper punctuation, capitalization, and paragraph breaks. Mark unclear sections with [inaudible].'
        : undefined
      ),
    });

    const segments: TranscriptSegmentData[] = [];
    const rawSegments = (response as unknown as { segments?: Array<{
      start: number;
      end: number;
      text: string;
      avg_logprob?: number;
      no_speech_prob?: number;
    }> }).segments || [];

    for (const seg of rawSegments) {
      // Skip high no-speech probability segments
      if (seg.no_speech_prob && seg.no_speech_prob > 0.8) continue;

      segments.push({
        startMs: Math.round(seg.start * 1000),
        endMs: Math.round(seg.end * 1000),
        text: seg.text.trim(),
        confidence: seg.avg_logprob
          ? Math.min(1, Math.max(0, 1 + seg.avg_logprob)) // Convert logprob to 0-1 range
          : undefined,
      });
    }

    const detectedLanguage = (response as unknown as { language?: string }).language;
    const fullText = segments.map(s => s.text).join(' ');

    return {
      segments,
      detectedLanguage: detectedLanguage || undefined,
      fullText,
      provider: this.name,
    };
  }
}

// Singleton provider
let provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!provider) {
    provider = new OpenAIWhisperProvider();
  }
  return provider;
}
