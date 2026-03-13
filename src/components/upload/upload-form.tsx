'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { createTranslator } from '../../lib/i18n';
import { formatBytes } from '../../lib/utils';
import type { Locale } from '../../types';
import { CloudPickers } from './cloud-pickers';
import {
  Upload, FileAudio, FileVideo, X, CheckCircle2, AlertCircle,
  Loader2, Sparkles, Scale, ChevronUp, ChevronDown,
} from 'lucide-react';

interface Props { locale: Locale; dict: Record<string, unknown>; }

const MAX_SIZE = parseInt(process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE_MB || '500') * 1024 * 1024 || 500 * 1024 * 1024;
const CHUNK_SIZE = 45 * 1024 * 1024;

async function uploadFileChunked(
  file: File,
  onProgress: (pct: number) => void
): Promise<{ uploadId: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number }> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const initRes = await fetch('/api/upload/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, mimeType: file.type, totalChunks }),
  });
  if (!initRes.ok) throw new Error((await initRes.json()).error || 'Init failed');
  const { uploadId } = await initRes.json();

  for (let i = 0; i < totalChunks; i++) {
    const chunkBlob = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size));
    const form = new FormData();
    form.append('chunk', chunkBlob);
    form.append('uploadId', uploadId);
    form.append('chunkIndex', String(i));

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(((i + e.loaded / e.total) / totalChunks) * 100);
      });
      xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Chunk ${i+1} failed`)));
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.open('POST', '/api/upload/chunk');
      xhr.send(form);
    });
  }
  return { uploadId, fileName: file.name, fileSize: file.size, mimeType: file.type, totalChunks };
}

export function UploadForm({ locale, dict }: Props) {
  const t = useMemo(() => createTranslator(dict), [dict]);
  const router = useRouter();

  const [files, setFiles] = useState<File[]>([]);
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('');
  const [processingMode, setProcessingMode] = useState<'balanced' | 'best_quality'>('balanced');
  const [domainContext, setDomainContext] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setError(null);
    const valid = acceptedFiles.filter(f => {
      if (f.size > MAX_SIZE) { setError(t('upload.validation.file_too_large', { size: formatBytes(MAX_SIZE) })); return false; }
      return true;
    });
    if (valid.length > 0) setFiles(prev => [...prev, ...valid]);
  }, [t]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
      'audio/*': ['.mp3', '.wav', '.m4a', '.ogg'],
    },
  });

  const removeFile = (i: number) => setFiles(prev => prev.filter((_, idx) => idx !== i));
  const moveFile = (i: number, dir: 'up' | 'down') => {
    setFiles(prev => {
      const a = [...prev]; const t = dir === 'up' ? i - 1 : i + 1;
      if (t < 0 || t >= a.length) return prev;
      [a[i], a[t]] = [a[t], a[i]]; return a;
    });
  };

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const multi = files.length > 1;

  const handleSubmit = async () => {
    if (files.length === 0) { setError(t('upload.validation.file_required')); return; }
    setIsSubmitting(true); setUploadProgress(0); setError(null);

    try {
      const uploads: Array<{ uploadId: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number }> = [];
      const progresses = new Array(files.length).fill(0);
      const updateOverall = () => {
        let done = 0; files.forEach((f, i) => { done += f.size * (progresses[i] / 100); });
        setUploadProgress(Math.round((done / totalSize) * 92));
      };

      for (let fi = 0; fi < files.length; fi++) {
        setUploadStatus(files.length > 1
          ? t('upload.uploading_file', { current: String(fi + 1), total: String(files.length) })
          : t('upload.submitting'));
        const result = await uploadFileChunked(files[fi], (pct) => { progresses[fi] = pct; updateOverall(); });
        uploads.push(result);
      }

      setUploadProgress(95);
      setUploadStatus(t('upload.assembling'));

      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploads,
          uploadId: uploads[0].uploadId, fileName: uploads[0].fileName, fileSize: uploads[0].fileSize,
          mimeType: uploads[0].mimeType, totalChunks: uploads[0].totalChunks,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: (targetLanguage && targetLanguage !== sourceLanguage) ? targetLanguage : null,
          processingMode, uiLanguage: locale,
          domainContext: domainContext || null,
        }),
      });

      if (!completeRes.ok) throw new Error((await completeRes.json()).error || 'Failed');
      const result = await completeRes.json();
      setUploadProgress(100); setSuccess(true);
      setTimeout(() => router.push(`/${locale}/jobs/${result.id}`), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('upload.error'));
    } finally {
      setIsSubmitting(false); setUploadProgress(0); setUploadStatus('');
    }
  };

  const sameLanguage = sourceLanguage && targetLanguage && sourceLanguage === targetLanguage;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t('upload.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('upload.subtitle')}</p>
      </div>

      {success && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
          <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
          <p className="text-sm font-medium text-green-800">{t('upload.success')}</p>
        </div>
      )}

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {/* Dropzone */}
        <div {...getRootProps()} className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
          isDragActive ? 'border-primary bg-primary/5' : files.length > 0 ? 'border-green-300 bg-green-50/50' : 'border-border hover:border-primary/50 hover:bg-muted/30'
        }`}>
          <input {...getInputProps()} />
          <div className="space-y-3">
            <Upload className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm font-medium text-muted-foreground">{isDragActive ? t('upload.dropzone_active') : t('upload.dropzone')}</p>
            <p className="text-xs text-muted-foreground/70">{t('upload.supported_formats')}</p>
            <p className="text-xs text-muted-foreground/70">{t('upload.max_size', { size: formatBytes(MAX_SIZE) })}</p>
            <p className="text-xs text-primary font-medium">{t('upload.multi_file_hint')}</p>
          </div>
        </div>

        {/* File List */}
        {files.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('upload.files_selected', { count: String(files.length) })}</span>
              <span className="text-xs text-muted-foreground">{t('upload.total_size', { size: formatBytes(totalSize) })}</span>
            </div>
            {multi && <p className="text-xs text-primary">{t('upload.reorder_hint')}</p>}
            <div className="space-y-1.5">
              {files.map((file, i) => (
                <div key={`${file.name}-${i}`} className="flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2">
                  {multi && (
                    <div className="flex flex-col">
                      <button onClick={(e) => { e.stopPropagation(); moveFile(i, 'up'); }} disabled={i === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0.5"><ChevronUp className="h-3.5 w-3.5" /></button>
                      <button onClick={(e) => { e.stopPropagation(); moveFile(i, 'down'); }} disabled={i === files.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0.5"><ChevronDown className="h-3.5 w-3.5" /></button>
                    </div>
                  )}
                  {multi && <span className="text-xs font-bold text-primary min-w-[20px]">{i + 1}</span>}
                  {file.type?.startsWith('video/') ? <FileVideo className="h-5 w-5 text-green-600 shrink-0" /> : <FileAudio className="h-5 w-5 text-green-600 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                    className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"><X className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cloud Import */}
        <CloudPickers onFileSelected={(f) => { setError(null); setFiles(prev => [...prev, f]); }} onError={(err) => setError(err)} disabled={isSubmitting || success} t={t} />

        <div className="relative">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border/60" /></div>
          <div className="relative flex justify-center"><span className="bg-gradient-to-br from-slate-50 to-blue-50/30 px-3 text-xs text-muted-foreground">{t('upload.or_configure')}</span></div>
        </div>

        {/* Source Language */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('upload.source_language')}</label>
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)}
            className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">{t('upload.auto_detect')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
        </div>

        {/* Target Language */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('upload.target_language')}</label>
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}
            className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">{t('upload.no_translation')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
          {sameLanguage && <p className="mt-1 text-xs text-amber-600">{t('upload.validation.same_language')}</p>}
        </div>

        {/* Processing Mode */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">{t('upload.processing_mode')}</label>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setProcessingMode('best_quality')}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${processingMode === 'best_quality' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}>
              <Sparkles className={`h-6 w-6 ${processingMode === 'best_quality' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm font-semibold">{t('upload.mode_best')}</span>
              <span className="text-xs text-muted-foreground">{t('upload.mode_best_desc')}</span>
            </button>
            <button type="button" onClick={() => setProcessingMode('balanced')}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${processingMode === 'balanced' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}>
              <Scale className={`h-6 w-6 ${processingMode === 'balanced' ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm font-semibold">{t('upload.mode_balanced')}</span>
              <span className="text-xs text-muted-foreground">{t('upload.mode_balanced_desc')}</span>
            </button>
          </div>
        </div>

        {/* Domain Context (optional) */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('upload.domain_context')}</label>
          <input type="text" value={domainContext} onChange={(e) => setDomainContext(e.target.value)}
            placeholder={t('upload.domain_context_placeholder')}
            className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          <p className="mt-1 text-xs text-muted-foreground">{t('upload.domain_context_help')}</p>
        </div>

        {/* Submit */}
        <div className="space-y-2">
          <button onClick={handleSubmit} disabled={files.length === 0 || isSubmitting || success}
            className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {uploadStatus || t('upload.submitting')} {uploadProgress > 0 && `${uploadProgress}%`}
              </span>
            ) : t('upload.submit')}
          </button>
          {isSubmitting && uploadProgress > 0 && (
            <div className="space-y-1">
              <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                <div className="bg-primary h-2.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="text-xs text-muted-foreground text-center">{t('upload.uploading_progress', { percent: String(uploadProgress) })}</p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground/70">{t('upload.disclaimer')}</p>
      </div>
    </div>
  );
}
