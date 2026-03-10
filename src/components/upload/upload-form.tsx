'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { createTranslator } from '../../lib/i18n';
import { formatBytes } from '../../lib/utils';
import type { Locale } from '../../types';
import { CloudPickers } from './cloud-pickers';
import {
  Upload,
  FileAudio,
  FileVideo,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  Scale,
} from 'lucide-react';

interface Props {
  locale: Locale;
  dict: Record<string, unknown>;
}

const SUPPORTED_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.mp3', '.wav', '.m4a', '.ogg',
];

const MAX_SIZE = parseInt(process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE_MB || '500') * 1024 * 1024 || 500 * 1024 * 1024;

export function UploadForm({ locale, dict }: Props) {
  const t = useMemo(() => createTranslator(dict), [dict]);
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('');
  const [processingMode, setProcessingMode] = useState<'balanced' | 'best_quality'>('balanced');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setError(null);
    const f = acceptedFiles[0];
    if (f) {
      if (f.size > MAX_SIZE) {
        setError(t('upload.validation.file_too_large', { size: formatBytes(MAX_SIZE) }));
        return;
      }
      setFile(f);
    }
  }, [t]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: {
      'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
      'audio/*': ['.mp3', '.wav', '.m4a', '.ogg'],
    },
  });

  const CHUNK_SIZE = 45 * 1024 * 1024; // 45 MB per chunk (under Render's 100MB limit)

  const handleSubmit = async () => {
    if (!file) {
      setError(t('upload.validation.file_required'));
      return;
    }

    setIsSubmitting(true);
    setUploadProgress(0);
    setError(null);

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Step 1: Initialize upload session
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          totalChunks,
        }),
      });
      if (!initRes.ok) {
        const data = await initRes.json();
        throw new Error(data.error || 'Failed to initialize upload');
      }
      const { uploadId } = await initRes.json();

      // Step 2: Upload chunks with progress
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const chunkForm = new FormData();
        chunkForm.append('chunk', chunkBlob);
        chunkForm.append('uploadId', uploadId);
        chunkForm.append('chunkIndex', String(i));

        // Use XHR for per-chunk progress
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const chunkProgress = (e.loaded / e.total);
              const overallProgress = ((i + chunkProgress) / totalChunks) * 95; // 95% for upload, 5% for assembly
              setUploadProgress(Math.round(overallProgress));
            }
          });

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else {
              try { reject(new Error(JSON.parse(xhr.responseText).error)); }
              catch { reject(new Error(`Chunk ${i + 1} upload failed (${xhr.status})`)); }
            }
          });

          xhr.addEventListener('error', () => reject(new Error(`Network error on chunk ${i + 1}`)));
          xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

          xhr.open('POST', '/api/upload/chunk');
          xhr.send(chunkForm);
        });
      }

      // Step 3: Complete upload — reassemble and create job
      setUploadProgress(97);
      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          totalChunks,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: (targetLanguage && targetLanguage !== sourceLanguage) ? targetLanguage : null,
          processingMode,
          uiLanguage: locale,
        }),
      });

      if (!completeRes.ok) {
        const data = await completeRes.json();
        throw new Error(data.error || 'Failed to complete upload');
      }

      const result = await completeRes.json();
      setUploadProgress(100);
      setSuccess(true);

      setTimeout(() => {
        router.push(`/${locale}/jobs/${result.id}`);
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('upload.error'));
    } finally {
      setIsSubmitting(false);
      setUploadProgress(0);
    }
  };

  const isVideo = file?.type?.startsWith('video/');
  const sameLanguage = sourceLanguage && targetLanguage && sourceLanguage === targetLanguage;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t('upload.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('upload.subtitle')}</p>
      </div>

      {/* Success message */}
      {success && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
          <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
          <p className="text-sm font-medium text-green-800">{t('upload.success')}</p>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {/* Dropzone */}
        <div
          {...getRootProps()}
          className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
            isDragActive
              ? 'border-primary bg-primary/5'
              : file
              ? 'border-green-300 bg-green-50/50'
              : 'border-border hover:border-primary/50 hover:bg-muted/30'
          }`}
        >
          <input {...getInputProps()} />

          {file ? (
            <div className="flex items-center justify-center gap-4">
              {isVideo ? (
                <FileVideo className="h-10 w-10 text-green-600" />
              ) : (
                <FileAudio className="h-10 w-10 text-green-600" />
              )}
              <div className="text-left">
                <p className="font-medium text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">
                  {t('upload.file_size', { size: formatBytes(file.size) })}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="ml-auto rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <Upload className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm font-medium text-muted-foreground">
                {isDragActive ? t('upload.dropzone_active') : t('upload.dropzone')}
              </p>
              <p className="text-xs text-muted-foreground/70">{t('upload.supported_formats')}</p>
              <p className="text-xs text-muted-foreground/70">
                {t('upload.max_size', { size: formatBytes(MAX_SIZE) })}
              </p>
            </div>
          )}
        </div>

        {/* Cloud Import */}
        <CloudPickers
          onFileSelected={(f) => { setError(null); setFile(f); }}
          onError={(err) => setError(err)}
          disabled={isSubmitting || success}
          t={t}
        />

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border/60" /></div>
          <div className="relative flex justify-center"><span className="bg-gradient-to-br from-slate-50 to-blue-50/30 px-3 text-xs text-muted-foreground">{t('upload.or_configure')}</span></div>
        </div>

        {/* Source Language */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('upload.source_language')}
          </label>
          <select
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
            className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            <option value="">{t('upload.auto_detect')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{t('upload.source_language_help')}</p>
        </div>

        {/* Target Language */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('upload.target_language')}
          </label>
          <select
            value={targetLanguage}
            onChange={(e) => setTargetLanguage(e.target.value)}
            className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            <option value="">{t('upload.no_translation')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{t('upload.target_language_help')}</p>
          {sameLanguage && (
            <p className="mt-1 text-xs text-amber-600">{t('upload.validation.same_language')}</p>
          )}
        </div>

        {/* Processing Mode */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('upload.processing_mode')}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setProcessingMode('best_quality')}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${
                processingMode === 'best_quality'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/30'
              }`}
            >
              <Sparkles className={`h-6 w-6 ${processingMode === 'best_quality' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm font-semibold">{t('upload.mode_best')}</span>
              <span className="text-xs text-muted-foreground">{t('upload.mode_best_desc')}</span>
            </button>
            <button
              type="button"
              onClick={() => setProcessingMode('balanced')}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${
                processingMode === 'balanced'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/30'
              }`}
            >
              <Scale className={`h-6 w-6 ${processingMode === 'balanced' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm font-semibold">{t('upload.mode_balanced')}</span>
              <span className="text-xs text-muted-foreground">{t('upload.mode_balanced_desc')}</span>
            </button>
          </div>
        </div>

        {/* Submit */}
        <div className="space-y-2">
          <button
            onClick={handleSubmit}
            disabled={!file || isSubmitting || success}
            className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('upload.submitting')} {uploadProgress > 0 && `${uploadProgress}%`}
              </span>
            ) : (
              t('upload.submit')
            )}
          </button>

          {/* Upload progress bar */}
          {isSubmitting && uploadProgress > 0 && (
            <div className="space-y-1">
              <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-primary h-2.5 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {t('upload.uploading_progress', { percent: String(uploadProgress) })}
              </p>
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <p className="text-center text-xs text-muted-foreground/70">
          {t('upload.disclaimer')}
        </p>
      </div>
    </div>
  );
}
