import OpenAI from 'openai';
import type { TranslationResult, TranscriptSegmentData } from '@/types';

const LANGUAGE_MAP: Record<string, string> = {
  en: 'English',
  pt: 'Portuguese',
  es: 'Spanish',
  fr: 'French',
};

export interface TranslationProvider {
  translate(
    segments: TranscriptSegmentData[],
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult>;
}

class OpenAITranslationProvider implements TranslationProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async translate(
    segments: TranscriptSegmentData[],
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const srcLang = LANGUAGE_MAP[sourceLanguage] || sourceLanguage;
    const tgtLang = LANGUAGE_MAP[targetLanguage] || targetLanguage;

    if (sourceLanguage === targetLanguage) {
      return {
        translatedText: segments.map(s => s.text).join(' '),
        segments: segments.map(s => ({
          sourceText: s.text,
          translatedText: s.text,
          startMs: s.startMs,
          endMs: s.endMs,
        })),
      };
    }

    const batchSize = 40;
    const allTranslated: TranslationResult['segments'] = [];

    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      const numbered = batch.map((s, idx) => `[${idx}] ${s.text}`).join('\n');

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are a professional translator from ${srcLang} to ${tgtLang}. Translate each numbered line accurately while preserving meaning, tone, and formatting. Keep [inaudible] and [unclear] markers as-is. Return ONLY the translated lines, each prefixed with the original index [N]. Do NOT add explanations.`,
          },
          {
            role: 'user',
            content: numbered,
          },
        ],
      });

      const content = response.choices[0]?.message?.content || '';
      const lines = content.split('\n').filter(l => l.trim());
      const translatedMap = new Map<number, string>();

      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(.+)/);
        if (match) {
          translatedMap.set(parseInt(match[1]), match[2].trim());
        }
      }

      for (let j = 0; j < batch.length; j++) {
        allTranslated.push({
          sourceText: batch[j].text,
          translatedText: translatedMap.get(j) || batch[j].text,
          startMs: batch[j].startMs,
          endMs: batch[j].endMs,
        });
      }
    }

    return {
      translatedText: allTranslated.map(s => s.translatedText).join(' '),
      segments: allTranslated,
    };
  }
}

let provider: TranslationProvider | null = null;

export function getTranslationProvider(): TranslationProvider {
  if (!provider) {
    provider = new OpenAITranslationProvider();
  }
  return provider;
}
