export const SUPPORTED_LOCALES = ['en', 'pt', 'es', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const SUPPORTED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
] as const;

export const SUPPORTED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
] as const;

export const SUPPORTED_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.mp3', '.wav', '.m4a', '.ogg',
] as const;

export type ProcessingMode = 'best_quality' | 'balanced';

export type JobStatus =
  | 'uploaded'
  | 'queued'
  | 'converting'
  | 'transcribing'
  | 'post_processing'
  | 'translating'
  | 'generating_outputs'
  | 'completed'
  | 'failed';

export interface TranscriptSegmentData {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  confidence?: number;
}

export interface TranscriptionResult {
  segments: TranscriptSegmentData[];
  detectedLanguage?: string;
  fullText: string;
  provider: string;
}

export interface TranslationResult {
  translatedText: string;
  segments: Array<{
    sourceText: string;
    translatedText: string;
    startMs: number;
    endMs: number;
  }>;
}

export const LANGUAGE_NAMES: Record<Locale, Record<Locale, string>> = {
  en: { en: 'English', pt: 'Portuguese', es: 'Spanish', fr: 'French' },
  pt: { en: 'Inglês', pt: 'Português', es: 'Espanhol', fr: 'Francês' },
  es: { en: 'Inglés', pt: 'Portugués', es: 'Español', fr: 'Francés' },
  fr: { en: 'Anglais', pt: 'Portugais', es: 'Espagnol', fr: 'Français' },
};
