import OpenAI from 'openai';
import type { TranscriptSegmentData, ProcessingMode } from '../../types';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Clean up a batch of segments using GPT.
 * Exported so the pipeline can call it per-chunk as they complete.
 */
export async function cleanupSegmentsBatch(
  segments: TranscriptSegmentData[],
  language?: string,
  model: string = 'gpt-4o-mini'
): Promise<TranscriptSegmentData[]> {
  if (segments.length === 0) return segments;

  const langHint = language ? ` The transcript is in ${language}.` : '';

  try {
    const textsWithIdx = segments.map((s, idx) => `[${idx}] ${s.text}`).join('\n');

    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a professional transcript editor.${langHint} Your ONLY job is to clean up a raw speech-to-text transcript. Rules:
1. Fix punctuation, capitalization, and obvious spelling errors
2. Remove repeated words/phrases that appear at segment boundaries
3. Keep [inaudible] or [unclear] markers — NEVER invent content
4. Do NOT add, remove, or change the meaning of any spoken content
5. Do NOT merge or split segments — keep the same number and order
6. Return ONLY the cleaned text for each segment, one per line, prefixed with the original index [N]
7. Preserve the original language — do NOT translate`,
        },
        { role: 'user', content: `Clean up these transcript segments:\n\n${textsWithIdx}` },
      ],
    });

    const content = response.choices[0]?.message?.content || '';
    const lines = content.split('\n').filter(l => l.trim());
    const cleanedMap = new Map<number, string>();

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\]\s*(.+)/);
      if (match) cleanedMap.set(parseInt(match[1]), match[2].trim());
    }

    return segments.map((s, i) => ({
      ...s,
      text: cleanedMap.get(i) || lightCleanup(s.text),
    }));
  } catch {
    return segments.map(s => ({ ...s, text: lightCleanup(s.text) }));
  }
}

/**
 * Post-process an entire transcript. Used when pipeline mode is not active.
 */
export async function postProcessTranscript(
  segments: TranscriptSegmentData[],
  mode: ProcessingMode,
  language?: string
): Promise<TranscriptSegmentData[]> {
  if (segments.length === 0) return segments;

  if (mode === 'balanced') {
    return segments.map(s => ({ ...s, text: lightCleanup(s.text) }));
  }

  // Split into batches and process in parallel
  const batchSize = 80; // Larger batches = fewer API calls
  const CONCURRENCY = 8;
  const model = 'gpt-4o';

  const batches: TranscriptSegmentData[][] = [];
  for (let i = 0; i < segments.length; i += batchSize) {
    batches.push(segments.slice(i, i + batchSize));
  }

  const results: TranscriptSegmentData[][] = new Array(batches.length);

  for (let g = 0; g < batches.length; g += CONCURRENCY) {
    const group = batches.slice(g, g + CONCURRENCY);
    const promises = group.map((batch, idx) =>
      cleanupSegmentsBatch(batch, language, model).then(cleaned => {
        results[g + idx] = cleaned;
      })
    );
    await Promise.all(promises);
  }

  return results.flat();
}

/**
 * Lightweight local text cleanup (no API calls)
 */
export function lightCleanup(text: string): string {
  return text
    .trim()
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\.\s+([a-z])/g, (_, c) => `. ${c.toUpperCase()}`)
    .replace(/^[a-z]/, c => c.toUpperCase());
}

/**
 * Merge chunk transcripts, removing overlapping content at boundaries.
 */
export function mergeChunkSegments(
  chunks: Array<{
    segments: TranscriptSegmentData[];
    offsetMs: number;
    overlapMs: number;
  }>
): TranscriptSegmentData[] {
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return chunks[0].segments;

  const merged: TranscriptSegmentData[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    const nextChunk = isLast ? null : chunks[i + 1];

    for (const seg of chunk.segments) {
      const adjustedSeg: TranscriptSegmentData = {
        ...seg,
        startMs: seg.startMs + chunk.offsetMs,
        endMs: seg.endMs + chunk.offsetMs,
      };

      if (!isLast && nextChunk) {
        const overlapStart = chunk.offsetMs + (chunk.segments[chunk.segments.length - 1]?.endMs || 0) - chunk.overlapMs;
        if (adjustedSeg.startMs >= overlapStart) {
          const nextFirstMs = nextChunk.offsetMs + (nextChunk.segments[0]?.startMs || 0);
          if (adjustedSeg.startMs >= nextFirstMs - 2000) continue;
        }
      }

      const lastMerged = merged[merged.length - 1];
      if (lastMerged && isSimilarText(lastMerged.text, adjustedSeg.text)) continue;

      merged.push(adjustedSeg);
    }
  }

  return merged;
}

function isSimilarText(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length > 10 && nb.length > 10) return na.includes(nb) || nb.includes(na);
  return false;
}
