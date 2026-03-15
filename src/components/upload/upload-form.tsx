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
  Loader2, Sparkles, Scale, ChevronUp, ChevronDown, Music,
} from 'lucide-react';
import { isVideoFile, extractAudioInBrowser } from '../../lib/browser-audio-extract';

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
  const [fileProgresses, setFileProgresses] = useState<number[]>([]);
  const [fileStatuses, setFileStatuses] = useState<string[]>([]);
  const [activeFileIdx, setActiveFileIdx] = useState(-1);
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
    setIsSubmitting(true); setError(null);
    setFileProgresses(new Array(files.length).fill(0));
    setFileStatuses(new Array(files.length).fill(''));

    try {
      // Phase 1: Extract audio from video files in browser
      const filesToUpload: File[] = [];
      const hasVideos = files.some(f => isVideoFile(f));

      if (hasVideos) {
        for (let fi = 0; fi < files.length; fi++) {
          setActiveFileIdx(fi);
          if (isVideoFile(files[fi])) {
            setFileStatuses(prev => { const n = [...prev]; n[fi] = t('upload.extracting_audio'); return n; });
            try {
              const audioFile = await extractAudioInBrowser(files[fi], (pct, status) => {
                setFileProgresses(prev => { const n = [...prev]; n[fi] = pct * 0.4; return n; }); // 0-40% for extraction
                setFileStatuses(prev => { const n = [...prev]; n[fi] = status; return n; });
              });
              filesToUpload.push(audioFile);
              setFileStatuses(prev => { const n = [...prev]; n[fi] = t('upload.audio_extracted'); return n; });
            } catch (err) {
              console.warn('[extract] Failed, uploading original:', err);
              filesToUpload.push(files[fi]); // Fallback: upload original
              setFileStatuses(prev => { const n = [...prev]; n[fi] = t('upload.extract_fallback'); return n; });
            }
          } else {
            filesToUpload.push(files[fi]); // Audio files pass through
          }
        }
      } else {
        filesToUpload.push(...files);
      }

      // Phase 2: Upload files
      const uploads: Array<{ uploadId: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number }> = [];
      const uploadTotalSize = filesToUpload.reduce((s, f) => s + f.size, 0);

      for (let fi = 0; fi < filesToUpload.length; fi++) {
        setActiveFileIdx(fi);
        setFileStatuses(prev => { const n = [...prev]; n[fi] = t('upload.uploading'); return n; });
        const baseProgress = hasVideos ? 40 : 0; // After extraction = 40%
        const uploadRange = hasVideos ? 60 : 100; // Remaining for upload
        const result = await uploadFileChunked(filesToUpload[fi], (pct) => {
          setFileProgresses(prev => { const n = [...prev]; n[fi] = baseProgress + (pct / 100) * uploadRange; return n; });
        });
        setFileProgresses(prev => { const n = [...prev]; n[fi] = 100; return n; });
        setFileStatuses(prev => { const n = [...prev]; n[fi] = t('upload.uploaded'); return n; });
        uploads.push(result);
      }

      setActiveFileIdx(-1);

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
      setSuccess(true);
      setTimeout(() => router.push(`/${locale}/jobs/${result.id}`), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('upload.error'));
    } finally {
      setIsSubmitting(false); setFileProgresses([]); setFileStatuses([]); setActiveFileIdx(-1);
    }
  };

  const sameLanguage = sourceLanguage && targetLanguage && sourceLanguage === targetLanguage;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-foreground">{t('upload.title')}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('upload.subtitle')}</p>
      </div>

      {success && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-3">
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          <p className="text-sm font-medium text-green-800">{t('upload.success')}</p>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-3">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* === TOP ROW: Dropzone (left) + File List (right) === */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Dropzone */}
        <div {...getRootProps()} className={`relative cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-all flex flex-col items-center justify-center min-h-[180px] ${
          isDragActive ? 'border-primary bg-primary/5' : files.length > 0 ? 'border-green-300 bg-green-50/50' : 'border-border hover:border-primary/50 hover:bg-muted/30'
        }`}>
          <input {...getInputProps()} />
          <Upload className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
          <p className="text-sm font-medium text-muted-foreground">{isDragActive ? t('upload.dropzone_active') : t('upload.dropzone')}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{t('upload.supported_formats')}</p>
          <p className="text-xs text-primary font-medium mt-1">{t('upload.multi_file_hint')}</p>
        </div>

        {/* File List */}
        <div className="rounded-xl border border-border bg-white p-3 min-h-[180px] flex flex-col">
          {files.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">{t('upload.no_files_yet')}</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-foreground">{t('upload.files_selected', { count: String(files.length) })}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(totalSize)}</span>
              </div>
              <div className="space-y-1 flex-1 overflow-y-auto max-h-[200px]">
                {files.map((file, i) => {
                  const pct = fileProgresses[i] || 0;
                  const status = fileStatuses[i] || '';
                  const isActive = activeFileIdx === i;
                  const isDone = pct >= 100;
                  const isVideo = isVideoFile(file);
                  return (
                    <div key={`${file.name}-${i}`} className="relative rounded-lg border border-border overflow-hidden">
                      {/* Progress background: purple for extraction, green for upload */}
                      {isSubmitting && (
                        <div className={`absolute inset-0 transition-all duration-300 ease-out ${pct <= 40 && isVideo ? 'bg-purple-100' : 'bg-green-100'}`} style={{ width: `${pct}%` }} />
                      )}
                      <div className="relative flex items-center gap-1.5 px-2 py-1.5">
                        {multi && !isSubmitting && (
                          <div className="flex flex-col -my-1">
                            <button onClick={(e) => { e.stopPropagation(); moveFile(i, 'up'); }} disabled={i === 0}
                              className="text-muted-foreground hover:text-foreground disabled:opacity-20 leading-none"><ChevronUp className="h-3 w-3" /></button>
                            <button onClick={(e) => { e.stopPropagation(); moveFile(i, 'down'); }} disabled={i === files.length - 1}
                              className="text-muted-foreground hover:text-foreground disabled:opacity-20 leading-none"><ChevronDown className="h-3 w-3" /></button>
                          </div>
                        )}
                        {multi && <span className="text-xs font-bold text-primary w-4 text-center">{i + 1}</span>}
                        {isVideo ? <FileVideo className="h-4 w-4 text-green-600 shrink-0" /> : <FileAudio className="h-4 w-4 text-green-600 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{file.name}</p>
                          {isSubmitting && status && (
                            <p className="text-[10px] text-muted-foreground truncate">{status}</p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                        {isVideo && !isSubmitting && (
                          <span className="text-[10px] text-purple-600 bg-purple-50 rounded px-1 shrink-0">{t('upload.will_extract')}</span>
                        )}
                        {isSubmitting ? (
                          isDone ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" /> :
                          isActive ? <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" /> :
                          <span className="text-xs text-muted-foreground w-3.5" />
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                            className="text-muted-foreground hover:text-foreground shrink-0"><X className="h-3.5 w-3.5" /></button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* === SETTINGS ROW === */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Source Language */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">{t('upload.source_language')}</label>
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">{t('upload.auto_detect')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
        </div>
        {/* Target Language */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">{t('upload.target_language')}</label>
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="">{t('upload.no_translation')}</option>
            <option value="en">{t('language_selector.en')}</option>
            <option value="pt">{t('language_selector.pt')}</option>
            <option value="es">{t('language_selector.es')}</option>
            <option value="fr">{t('language_selector.fr')}</option>
          </select>
          {sameLanguage && <p className="mt-0.5 text-xs text-amber-600">{t('upload.validation.same_language')}</p>}
        </div>
      </div>

      {/* Processing Mode — compact */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <button type="button" onClick={() => setProcessingMode('best_quality')}
          className={`flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-left transition-all ${processingMode === 'best_quality' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}>
          <Sparkles className={`h-4 w-4 shrink-0 ${processingMode === 'best_quality' ? 'text-primary' : 'text-muted-foreground'}`} />
          <div>
            <span className="text-sm font-semibold block">{t('upload.mode_best')}</span>
            <span className="text-xs text-muted-foreground">{t('upload.mode_best_desc')}</span>
          </div>
        </button>
        <button type="button" onClick={() => setProcessingMode('balanced')}
          className={`flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-left transition-all ${processingMode === 'balanced' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}>
          <Scale className={`h-4 w-4 shrink-0 ${processingMode === 'balanced' ? 'text-primary' : 'text-muted-foreground'}`} />
          <div>
            <span className="text-sm font-semibold block">{t('upload.mode_balanced')}</span>
            <span className="text-xs text-muted-foreground">{t('upload.mode_balanced_desc')}</span>
          </div>
        </button>
      </div>

      {/* Domain Context */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-foreground mb-1">{t('upload.domain_context')}</label>
        <input type="text" value={domainContext} onChange={(e) => setDomainContext(e.target.value)}
          placeholder={t('upload.domain_context_placeholder')}
          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
      </div>

      {/* Submit */}
      <button onClick={handleSubmit} disabled={files.length === 0 || isSubmitting || success}
        className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('upload.submitting')}
          </span>
        ) : t('upload.submit')}
      </button>
    </div>
  );
}
