'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createTranslator } from '../../lib/i18n';
import { formatBytes, formatDuration, formatMs } from '../../lib/utils';
import type { Locale } from '../../types';
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  FileAudio,
  FileVideo,
  Sparkles,
  Scale,
  AlertCircle,
} from 'lucide-react';

interface Artifact {
  id: string;
  type: string;
  mimeType: string;
  sizeBytes: string;
}

interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  sourceText: string;
  translatedText: string | null;
  confidence: number | null;
  segmentIndex: number;
}

interface LogEntry {
  id: string;
  stage: string;
  level: string;
  message: string;
  createdAt: string;
}

interface JobData {
  id: string;
  originalFileName: string;
  originalMimeType: string;
  originalFileSize: string;
  sourceType: string;
  sourceLanguage: string | null;
  detectedLanguage: string | null;
  targetLanguage: string | null;
  uiLanguage: string;
  processingMode: string;
  status: string;
  providerUsed: string | null;
  durationSeconds: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  artifacts: Artifact[];
  segments: Segment[];
  logs: LogEntry[];
}

interface Props {
  locale: Locale;
  dict: Record<string, unknown>;
  jobId: string;
}

const STATUS_STEPS = [
  'uploaded', 'queued', 'converting', 'transcribing',
  'post_processing', 'translating', 'generating_outputs', 'completed',
];

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-700',
  queued: 'bg-blue-100 text-blue-700',
  converting: 'bg-amber-100 text-amber-700',
  transcribing: 'bg-indigo-100 text-indigo-700',
  post_processing: 'bg-purple-100 text-purple-700',
  translating: 'bg-cyan-100 text-cyan-700',
  generating_outputs: 'bg-teal-100 text-teal-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const DOWNLOAD_LABELS: Record<string, string> = {
  mp3: 'download_mp3',
  transcript_txt: 'download_transcript_txt',
  transcript_json: 'download_transcript_json',
  translation_txt: 'download_translation_txt',
  translation_json: 'download_translation_json',
  srt: 'download_srt',
  vtt: 'download_vtt',
};

export function JobDetail({ locale, dict, jobId }: Props) {
  const t = createTranslator(dict);
  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [retrying, setRetrying] = useState(false);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setJob(data);
    } catch {
      console.error('Failed to fetch job');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  useEffect(() => {
    const isProcessing = job && !['completed', 'failed'].includes(job.status);
    if (isProcessing) {
      const interval = setInterval(fetchJob, 3000);
      return () => clearInterval(interval);
    }
  }, [fetchJob, job?.status]);

  const handleRetry = async () => {
    if (!confirm(t('job_detail.retry_confirm'))) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      if (res.ok) {
        await fetchJob();
      }
    } catch {
      console.error('Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ml-2 text-sm text-muted-foreground">{t('job_detail.loading')}</span>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-center py-20">
        <XCircle className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-3 text-muted-foreground">{t('common.error')}</p>
      </div>
    );
  }

  const currentStepIndex = STATUS_STEPS.indexOf(job.status);
  const downloadableArtifacts = job.artifacts.filter(a => a.type !== 'original');

  const tabs = [
    { key: 'overview', label: t('job_detail.overview') },
    { key: 'transcript', label: t('job_detail.transcript') },
    ...(job.targetLanguage ? [{ key: 'translation', label: t('job_detail.translation') }] : []),
    { key: 'segments', label: t('job_detail.segments') },
    { key: 'downloads', label: t('job_detail.downloads') },
    { key: 'logs', label: t('job_detail.logs') },
  ];

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href={`/${locale}/jobs`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('job_detail.back')}
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              {job.sourceType === 'video' ? (
                <FileVideo className="h-5 w-5 text-muted-foreground" />
              ) : (
                <FileAudio className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{job.originalFileName}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status]}`}>
                  {t(`status.${job.status}`)}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {job.processingMode === 'best_quality' ? <Sparkles className="h-3 w-3" /> : <Scale className="h-3 w-3" />}
                  {t(`mode.${job.processingMode}`)}
                </span>
                {(job.detectedLanguage || job.sourceLanguage) && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground uppercase">
                    {job.detectedLanguage || job.sourceLanguage}
                  </span>
                )}
              </div>
            </div>
          </div>

          {(job.status === 'failed' || job.status === 'completed') && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
              {t('job_detail.retry')}
            </button>
          )}
        </div>
      </div>

      {/* Progress Timeline */}
      {job.status !== 'completed' && job.status !== 'failed' && (
        <div className="mb-6 rounded-xl border border-border/60 bg-white p-4">
          <div className="flex items-center gap-1 overflow-x-auto">
            {STATUS_STEPS.map((step, i) => {
              const isActive = i === currentStepIndex;
              const isComplete = i < currentStepIndex;
              return (
                <div key={step} className="flex items-center gap-1 shrink-0">
                  <div className={`flex h-7 items-center rounded-full px-2.5 text-xs font-medium transition-all ${
                    isActive ? 'bg-primary text-primary-foreground' :
                    isComplete ? 'bg-green-100 text-green-700' :
                    'bg-muted text-muted-foreground/50'
                  }`}>
                    {isComplete ? <CheckCircle2 className="h-3 w-3 mr-1" /> : isActive ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    {t(`status.${step}`)}
                  </div>
                  {i < STATUS_STEPS.length - 1 && (
                    <div className={`h-0.5 w-4 ${isComplete ? 'bg-green-300' : 'bg-muted'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Banner */}
      {job.status === 'failed' && job.errorMessage && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-red-800">{t('job_detail.error')}</p>
            <p className="mt-1 text-sm text-red-700">{job.errorMessage}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-xl bg-muted p-1 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? 'bg-white text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="rounded-xl border border-border/60 bg-white p-6">
        {activeTab === 'overview' && (
          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-foreground mb-3">{t('job_detail.file_info')}</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.filename')}</dt><dd className="font-medium truncate ml-4">{job.originalFileName}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.file_size')}</dt><dd className="font-medium">{formatBytes(parseInt(job.originalFileSize))}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.file_type')}</dt><dd className="font-medium">{job.originalMimeType}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.source_type')}</dt><dd className="font-medium capitalize">{t(`common.${job.sourceType}`)}</dd></div>
                {job.durationSeconds && (
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.audio_duration')}</dt><dd className="font-medium">{formatDuration(job.durationSeconds)}</dd></div>
                )}
              </dl>
            </div>
            <div>
              <h3 className="font-semibold text-foreground mb-3">{t('job_detail.processing_info')}</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.status')}</dt><dd><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status]}`}>{t(`status.${job.status}`)}</span></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.mode')}</dt><dd className="font-medium">{t(`mode.${job.processingMode}`)}</dd></div>
                {job.providerUsed && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.provider')}</dt><dd className="font-medium">{job.providerUsed}</dd></div>}
                {job.sourceLanguage && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.source_language')}</dt><dd className="font-medium uppercase">{job.sourceLanguage}</dd></div>}
                {job.detectedLanguage && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.detected_language')}</dt><dd className="font-medium uppercase">{job.detectedLanguage}</dd></div>}
                {job.targetLanguage && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.target_language')}</dt><dd className="font-medium uppercase">{job.targetLanguage}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.created_at')}</dt><dd className="font-medium">{new Date(job.createdAt).toLocaleString(locale)}</dd></div>
                {job.completedAt && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.completed_at')}</dt><dd className="font-medium">{new Date(job.completedAt).toLocaleString(locale)}</dd></div>}
              </dl>
            </div>
          </div>
        )}

        {activeTab === 'transcript' && (
          <div>
            {job.segments.length > 0 ? (
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                  {job.segments.map(s => s.sourceText).join(' ')}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_transcript')}</p>
            )}
          </div>
        )}

        {activeTab === 'translation' && (
          <div>
            {job.segments.some(s => s.translatedText) ? (
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                  {job.segments.map(s => s.translatedText || s.sourceText).join(' ')}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_translation')}</p>
            )}
          </div>
        )}

        {activeTab === 'segments' && (
          <div>
            {job.segments.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.time')}</th>
                      {job.segments.some(s => s.speakerLabel) && (
                        <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.speaker')}</th>
                      )}
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.source_text')}</th>
                      {job.segments.some(s => s.translatedText) && (
                        <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.translated_text')}</th>
                      )}
                      <th className="pb-2 font-medium text-muted-foreground">{t('job_detail.segment_table.confidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.segments.map((seg) => (
                      <tr key={seg.id} className="border-b border-border/40 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {formatMs(seg.startMs)}
                        </td>
                        {job.segments.some(s => s.speakerLabel) && (
                          <td className="py-2 pr-4 text-muted-foreground">{seg.speakerLabel || '—'}</td>
                        )}
                        <td className="py-2 pr-4">{seg.sourceText}</td>
                        {job.segments.some(s => s.translatedText) && (
                          <td className="py-2 pr-4 text-muted-foreground">{seg.translatedText || '—'}</td>
                        )}
                        <td className="py-2">
                          {seg.confidence !== null ? (
                            <span className={`text-xs font-medium ${seg.confidence > 0.8 ? 'text-green-600' : seg.confidence > 0.5 ? 'text-amber-600' : 'text-red-600'}`}>
                              {(seg.confidence * 100).toFixed(0)}%
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_segments')}</p>
            )}
          </div>
        )}

        {activeTab === 'downloads' && (
          <div>
            {downloadableArtifacts.length > 0 ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {downloadableArtifacts.map((artifact) => (
                  <a
                    key={artifact.id}
                    href={`/api/jobs/${job.id}/artifacts/${artifact.id}`}
                    download
                    className="flex items-center gap-3 rounded-xl border border-border/60 p-3 hover:bg-muted/30 hover:border-primary/30 transition-colors"
                  >
                    <Download className="h-5 w-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(`job_detail.${DOWNLOAD_LABELS[artifact.type] || 'download'}`)}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatBytes(parseInt(artifact.sizeBytes))}</p>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_transcript')}</p>
            )}
          </div>
        )}

        {activeTab === 'logs' && (
          <div>
            {job.logs.length > 0 ? (
              <div className="space-y-1 font-mono text-xs">
                {job.logs.map((log) => (
                  <div key={log.id} className={`flex gap-2 py-1 ${log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-600' : 'text-muted-foreground'}`}>
                    <span className="text-muted-foreground/50 shrink-0">
                      {new Date(log.createdAt).toLocaleTimeString(locale)}
                    </span>
                    <span className="uppercase font-bold w-12 shrink-0">{log.level}</span>
                    <span className="text-primary/60 shrink-0">[{log.stage}]</span>
                    <span className="text-foreground">{log.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_logs')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
