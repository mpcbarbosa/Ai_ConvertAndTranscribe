import OpenAI from 'openai';
import type { TranscriptSegmentData, ProcessingMode } from '../../types';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Post-process transcript for quality improvement.
 * - Fix punctuation, casing, paragraphing
 * - Remove repeated tokens from chunk boundaries
 * - Keep [inaudible] markers
 * - Do NOT hallucinate content
 */
export async function postProcessTranscript(
  segments: TranscriptSegmentData[],
  mode: ProcessingMode,
  language?: string
): Promise<TranscriptSegmentData[]> {
  if (segments.length === 0) return segments;

  // For balanced mode, do lightweight local cleanup only
  if (mode === 'balanced') {
    return segments.map(s => ({
      ...s,
      text: lightCleanup(s.text),
    }));
  }

  // For best quality, use GPT to clean up in batches
  const batchSize = 50;
  const processed: TranscriptSegmentData[] = [];

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const textsWithTimestamps = batch.map((s, idx) => `[${idx}] ${s.text}`).join('\n');

    const langHint = language ? ` The transcript is in ${language}.` : '';

    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',  // Best quality mode uses GPT-4o for superior cleanup
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
          {
            role: 'user',
            content: `Clean up these transcript segments:\n\n${textsWithTimestamps}`,
          },
        ],
      });

      const content = response.choices[0]?.message?.content || '';
      const lines = content.split('\n').filter(l => l.trim());
      const cleanedMap = new Map<number, string>();

      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(.+)/);
        if (match) {
          cleanedMap.set(parseInt(match[1]), match[2].trim());
        }
      }

      for (let j = 0; j < batch.length; j++) {
        processed.push({
          ...batch[j],
          text: cleanedMap.get(j) || lightCleanup(batch[j].text),
        });
      }
    } catch {
      // If GPT cleanup fails, fall back to light cleanup
      for (const seg of batch) {
        processed.push({ ...seg, text: lightCleanup(seg.text) });
      }
    }
  }

  return processed;
}

/**
 * Lightweight local text cleanup (no API calls)
 */
function lightCleanup(text: string): string {
  return text
    // Remove leading/trailing whitespace
    .trim()
    // Fix double spaces
    .replace(/\s{2,}/g, ' ')
    // Fix space before punctuation
    .replace(/\s+([.,!?;:])/g, '$1')
    // Capitalize first letter after period
    .replace(/\.\s+([a-z])/g, (_, c) => `. ${c.toUpperCase()}`)
    // Ensure first character is capitalized
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
      // Adjust timestamps by chunk offset
      const adjustedSeg: TranscriptSegmentData = {
        ...seg,
        startMs: seg.startMs + chunk.offsetMs,
        endMs: seg.endMs + chunk.offsetMs,
      };

      // For non-last chunks, skip segments in the overlap zone if next chunk covers them
      if (!isLast && nextChunk) {
        const overlapStart = chunk.offsetMs + (chunk.segments[chunk.segments.length - 1]?.endMs || 0) - chunk.overlapMs;
        if (adjustedSeg.startMs >= overlapStart) {
          // Check if next chunk has a similar segment — skip if so
          const nextFirstMs = nextChunk.offsetMs + (nextChunk.segments[0]?.startMs || 0);
          if (adjustedSeg.startMs >= nextFirstMs - 2000) {
            continue; // Skip overlap
          }
        }
      }

      // Deduplicate: skip if last merged segment has very similar text
      const lastMerged = merged[merged.length - 1];
      if (lastMerged && isSimilarText(lastMerged.text, adjustedSeg.text)) {
        continue;
      }

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
  // Check if one contains most of the other
  if (na.length > 10 && nb.length > 10) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}
