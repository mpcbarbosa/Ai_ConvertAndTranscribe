import OpenAI from 'openai';
import type { TranslationResult, TranscriptSegmentData } from '../../types';

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
    targetLanguage: string,
    mode?: 'best_quality' | 'balanced'
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
    targetLanguage: string,
    mode: 'best_quality' | 'balanced' = 'balanced'
  ): Promise<TranslationResult> {
    const srcLang = LANGUAGE_MAP[sourceLanguage] || sourceLanguage;
    const tgtLang = LANGUAGE_MAP[targetLanguage] || targetLanguage;
    const model = mode === 'best_quality' ? 'gpt-4o' : 'gpt-4o-mini';

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
    const TRANSLATE_CONCURRENCY = 4;

    // Create all batches
    const batches: Array<{ startIdx: number; segments: TranscriptSegmentData[] }> = [];
    for (let i = 0; i < segments.length; i += batchSize) {
      batches.push({ startIdx: i, segments: segments.slice(i, i + batchSize) });
    }

    // Pre-allocate results
    const allTranslated: TranslationResult['segments'] = new Array(segments.length);

    for (let g = 0; g < batches.length; g += TRANSLATE_CONCURRENCY) {
      const group = batches.slice(g, g + TRANSLATE_CONCURRENCY);

      const groupPromises = group.map(async ({ startIdx, segments: batch }) => {
        const numbered = batch.map((s, idx) => `[${idx}] ${s.text}`).join('\n');

        const response = await this.client.chat.completions.create({
          model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: `You are a professional translator from ${srcLang} to ${tgtLang}. Translate each numbered line accurately while preserving meaning, tone, and formatting. Keep [inaudible] and [unclear] markers as-is. Return ONLY the translated lines, each prefixed with the original index [N]. Do NOT add explanations.`,
            },
            { role: 'user', content: numbered },
          ],
        });

        const content = response.choices[0]?.message?.content || '';
        const lines = content.split('\n').filter(l => l.trim());
        const translatedMap = new Map<number, string>();

        for (const line of lines) {
          const match = line.match(/^\[(\d+)\]\s*(.+)/);
          if (match) translatedMap.set(parseInt(match[1]), match[2].trim());
        }

        for (let j = 0; j < batch.length; j++) {
          allTranslated[startIdx + j] = {
            sourceText: batch[j].text,
            translatedText: translatedMap.get(j) || batch[j].text,
            startMs: batch[j].startMs,
            endMs: batch[j].endMs,
          };
        }
      });

      await Promise.all(groupPromises);
    }

    return {
      translatedText: allTranslated.filter(Boolean).map(s => s.translatedText).join(' '),
      segments: allTranslated.filter(Boolean),
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
