import OpenAI from 'openai';
import Groq from 'groq-sdk';
import fs from 'fs';
import type { TranscriptSegmentData, TranscriptionResult, ProcessingMode } from '../../types';

export interface TranscriptionProvider {
  transcribe(audioPath: string, options: TranscriptionOptions): Promise<TranscriptionResult>;
  readonly name: string;
}

export interface TranscriptionOptions {
  language?: string;
  mode: ProcessingMode;
  prompt?: string;
}

/**
 * Groq Whisper — 10x faster than OpenAI Whisper, same model quality.
 * Uses whisper-large-v3-turbo for best speed/quality balance.
 */
class GroqWhisperProvider implements TranscriptionProvider {
  private client: Groq;
  readonly name = 'groq-whisper';

  constructor() {
    this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  async transcribe(audioPath: string, options: TranscriptionOptions): Promise<TranscriptionResult> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const file = fs.createReadStream(audioPath);

        const langCode = options.language || undefined;
        
        // Build a strong prompt to prevent hallucinations and language switching
        const langName = langCode ? { pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French' }[langCode] || langCode : null;
        const basePrompt = langName
          ? `This is a ${langName} meeting recording. Transcribe in ${langName} only. Do not switch languages. Mark unclear parts as [inaudible].`
          : options.prompt || 'Transcribe accurately with proper punctuation and capitalization. Mark unclear parts as [inaudible].';

        const response = await this.client.audio.transcriptions.create({
          file,
          model: 'whisper-large-v3-turbo',
          response_format: 'verbose_json',
          timestamp_granularities: ['segment'],
          language: langCode,
          prompt: basePrompt,
        });

        const segments: TranscriptSegmentData[] = [];
        const rawSegments = (response as unknown as { segments?: Array<{
          start: number; end: number; text: string;
          avg_logprob?: number; no_speech_prob?: number;
        }> }).segments || [];

        for (const seg of rawSegments) {
          // Aggressive filtering: skip high no-speech probability
          if (seg.no_speech_prob && seg.no_speech_prob > 0.6) continue;
          // Skip very low confidence segments (likely hallucinations)
          if (seg.avg_logprob && seg.avg_logprob < -1.0) continue;
          // Skip very short or suspiciously repetitive text
          const text = seg.text.trim();
          if (text.length < 2) continue;
          
          segments.push({
            startMs: Math.round(seg.start * 1000),
            endMs: Math.round(seg.end * 1000),
            text,
            confidence: seg.avg_logprob ? Math.min(1, Math.max(0, 1 + seg.avg_logprob)) : undefined,
          });
        }

        const detectedLanguage = (response as unknown as { language?: string }).language;
        return {
          segments,
          detectedLanguage: detectedLanguage || undefined,
          fullText: segments.map(s => s.text).join(' '),
          provider: this.name,
        };
      } catch (err: unknown) {
        const error = err as { status?: number; headers?: { get?: (k: string) => string | null } };
        if (error.status === 429 && attempt < MAX_RETRIES) {
          // Parse retry-after from headers or error message
          let waitSec = 60; // default wait
          try {
            const retryAfter = error.headers?.get?.('retry-after');
            if (retryAfter) waitSec = parseInt(retryAfter) || 60;
          } catch { /* use default */ }

          // Also try to parse from error message "Please try again in 4m9s"
          const msg = String(err);
          const timeMatch = msg.match(/try again in (\d+)m(\d+)s/);
          if (timeMatch) waitSec = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);

          console.log(`[groq] Rate limited. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Max retries exceeded for Groq transcription');
  }
}

/**
 * OpenAI Whisper — fallback if Groq is not configured.
 */
class OpenAIWhisperProvider implements TranscriptionProvider {
  private client: OpenAI;
  readonly name = 'openai-whisper';

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async transcribe(audioPath: string, options: TranscriptionOptions): Promise<TranscriptionResult> {
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
      start: number; end: number; text: string;
      avg_logprob?: number; no_speech_prob?: number;
    }> }).segments || [];

    for (const seg of rawSegments) {
      if (seg.no_speech_prob && seg.no_speech_prob > 0.6) continue;
      if (seg.avg_logprob && seg.avg_logprob < -1.0) continue;
      const text = seg.text.trim();
      if (text.length < 2) continue;
      segments.push({
        startMs: Math.round(seg.start * 1000),
        endMs: Math.round(seg.end * 1000),
        text,
        confidence: seg.avg_logprob ? Math.min(1, Math.max(0, 1 + seg.avg_logprob)) : undefined,
      });
    }

    const detectedLanguage = (response as unknown as { language?: string }).language;
    return {
      segments,
      detectedLanguage: detectedLanguage || undefined,
      fullText: segments.map(s => s.text).join(' '),
      provider: this.name,
    };
  }
}

// Singleton
let provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!provider) {
    // Use Groq if API key is set, otherwise OpenAI
    if (process.env.GROQ_API_KEY) {
      provider = new GroqWhisperProvider();
      console.log('[transcription] Using Groq Whisper (fast mode)');
    } else {
      provider = new OpenAIWhisperProvider();
      console.log('[transcription] Using OpenAI Whisper (fallback)');
    }
  }
  return provider;
}
