import { msToSrtTime, msToVttTime } from '@/lib/utils';

export interface SegmentForArtifact {
  startMs: number;
  endMs: number;
  text: string;
  translatedText?: string;
  speakerLabel?: string;
  confidence?: number;
}

/**
 * Generate SRT subtitle content
 */
export function generateSrt(segments: SegmentForArtifact[], useTranslated = false): string {
  return segments
    .map((seg, i) => {
      const text = useTranslated && seg.translatedText ? seg.translatedText : seg.text;
      return `${i + 1}\n${msToSrtTime(seg.startMs)} --> ${msToSrtTime(seg.endMs)}\n${text}\n`;
    })
    .join('\n');
}

/**
 * Generate VTT subtitle content
 */
export function generateVtt(segments: SegmentForArtifact[], useTranslated = false): string {
  const header = 'WEBVTT\n\n';
  const body = segments
    .map((seg, i) => {
      const text = useTranslated && seg.translatedText ? seg.translatedText : seg.text;
      return `${i + 1}\n${msToVttTime(seg.startMs)} --> ${msToVttTime(seg.endMs)}\n${text}\n`;
    })
    .join('\n');
  return header + body;
}

/**
 * Generate plain text transcript
 */
export function generateTxt(segments: SegmentForArtifact[], useTranslated = false): string {
  const lines: string[] = [];
  let currentParagraph: string[] = [];

  for (const seg of segments) {
    const text = useTranslated && seg.translatedText ? seg.translatedText : seg.text;
    currentParagraph.push(text);

    // Create paragraph breaks at natural sentence boundaries
    if (text.endsWith('.') || text.endsWith('!') || text.endsWith('?')) {
      if (currentParagraph.length >= 3) {
        lines.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
    }
  }

  if (currentParagraph.length > 0) {
    lines.push(currentParagraph.join(' '));
  }

  return lines.join('\n\n');
}

/**
 * Generate structured JSON transcript
 */
export function generateJson(
  segments: SegmentForArtifact[],
  metadata: {
    sourceLanguage?: string;
    detectedLanguage?: string;
    targetLanguage?: string;
    durationSeconds?: number;
    processingMode?: string;
  }
): string {
  const output = {
    metadata: {
      ...metadata,
      generatedAt: new Date().toISOString(),
      segmentCount: segments.length,
    },
    segments: segments.map((seg, i) => ({
      index: i,
      startMs: seg.startMs,
      endMs: seg.endMs,
      startTime: msToVttTime(seg.startMs),
      endTime: msToVttTime(seg.endMs),
      text: seg.text,
      translatedText: seg.translatedText || undefined,
      speaker: seg.speakerLabel || undefined,
      confidence: seg.confidence || undefined,
    })),
    fullText: segments.map(s => s.text).join(' '),
    fullTranslatedText: segments.some(s => s.translatedText)
      ? segments.map(s => s.translatedText || s.text).join(' ')
      : undefined,
  };

  return JSON.stringify(output, null, 2);
}
