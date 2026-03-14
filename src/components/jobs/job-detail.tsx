'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createTranslator } from '../../lib/i18n';
import { formatBytes, formatDuration, formatMs } from '../../lib/utils';
import type { Locale } from '../../types';
import {
  ArrowLeft, Download, RefreshCw, Loader2, CheckCircle2, XCircle,
  FileAudio, FileVideo, Sparkles, Scale, AlertCircle, Ban, Clock, Trash2,
} from 'lucide-react';

interface Artifact { id: string; type: string; mimeType: string; sizeBytes: string; }
interface Segment { id: string; startMs: number; endMs: number; speakerLabel: string | null; sourceText: string; translatedText: string | null; confidence: number | null; segmentIndex: number; }
interface LogEntry { id: string; stage: string; level: string; message: string; createdAt: string; }
interface Timing { id: string; stage: string; startedAt: string; completedAt: string | null; durationMs: number | null; }
interface ReportVersionInfo { id: string; reportType: string; label: string; version: number; createdAt: string; }
interface JobData {
  id: string; originalFileName: string; originalMimeType: string; originalFileSize: string;
  sourceType: string; sourceLanguage: string | null; detectedLanguage: string | null;
  targetLanguage: string | null; uiLanguage: string; processingMode: string;
  status: string; providerUsed: string | null; durationSeconds: number | null;
  errorMessage: string | null; meetingReport: string | null; technicalReport: string | null;
  domainContext: string | null;
  progress: number; currentStage: string | null; cancelRequested: boolean;
  createdAt: string; updatedAt: string; completedAt: string | null;
  artifacts: Artifact[]; segments: Segment[]; logs: LogEntry[]; timings: Timing[];
  reportVersions: ReportVersionInfo[];
}

interface Props { locale: Locale; dict: Record<string, unknown>; jobId: string; }

const STATUS_STEPS = ['uploaded', 'queued', 'converting', 'transcribing', 'post_processing', 'translating', 'generating_report', 'generating_outputs', 'completed'];

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-700', queued: 'bg-blue-100 text-blue-700',
  converting: 'bg-amber-100 text-amber-700', transcribing: 'bg-indigo-100 text-indigo-700',
  post_processing: 'bg-purple-100 text-purple-700', translating: 'bg-cyan-100 text-cyan-700',
  generating_report: 'bg-orange-100 text-orange-700', generating_outputs: 'bg-teal-100 text-teal-700',
  completed: 'bg-green-100 text-green-700', failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-700',
};

const DOWNLOAD_LABELS: Record<string, string> = {
  mp3: 'download_mp3', transcript_txt: 'download_transcript_txt', transcript_json: 'download_transcript_json',
  translation_txt: 'download_translation_txt', translation_json: 'download_translation_json',
  srt: 'download_srt', vtt: 'download_vtt', meeting_report: 'download_report',
};

function formatTimingMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function JobDetail({ locale, dict, jobId }: Props) {
  const t = useMemo(() => createTranslator(dict), [dict]);
  const router = useRouter();
  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error('Not found');
      setJob(await res.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { fetchJob(); }, [fetchJob]);

  const jobStatus = job?.status;
  useEffect(() => {
    const isProcessing = jobStatus && !['completed', 'failed', 'cancelled'].includes(jobStatus);
    if (isProcessing) {
      const interval = setInterval(fetchJob, 2000);
      return () => clearInterval(interval);
    }
  }, [fetchJob, jobStatus]);

  const handleRetry = async () => {
    if (!confirm(t('job_detail.retry_confirm'))) return;
    setRetrying(true);
    try { const res = await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' }); if (res.ok) await fetchJob(); }
    catch { /* ignore */ } finally { setRetrying(false); }
  };

  const handleCancel = async () => {
    if (!confirm(t('job_detail.cancel_confirm'))) return;
    setCancelling(true);
    try { await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }); await fetchJob(); }
    catch { /* ignore */ } finally { setCancelling(false); }
  };

  const handleDelete = async () => {
    if (!confirm(t('job_detail.delete_confirm'))) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}/delete`, { method: 'POST' });
      if (res.ok) router.push(`/${locale}/jobs`);
    } catch { /* ignore */ }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <span className="ml-2 text-sm text-muted-foreground">{t('job_detail.loading')}</span>
    </div>
  );

  if (!job) return (
    <div className="text-center py-20">
      <XCircle className="mx-auto h-12 w-12 text-muted-foreground/30" />
      <p className="mt-3 text-muted-foreground">{t('common.error')}</p>
    </div>
  );

  const currentStepIndex = STATUS_STEPS.indexOf(job.status);
  const downloadableArtifacts = job.artifacts.filter(a => a.type !== 'original');
  const hasTranslation = job.segments.some(s => s.translatedText);
  const effectiveSource = job.detectedLanguage || job.sourceLanguage;
  const translationRequested = job.targetLanguage && job.targetLanguage !== effectiveSource;
  const isActive = !['completed', 'failed', 'cancelled'].includes(job.status);
  const totalTimingMs = job.timings.reduce((sum, t) => sum + (t.durationMs || 0), 0);

  const tabs = [
    { key: 'overview', label: t('job_detail.overview') },
    { key: 'transcript', label: t('job_detail.transcript') },
    ...(hasTranslation || translationRequested ? [{ key: 'translation', label: t('job_detail.translation') }] : []),
    ...(job.meetingReport ? [{ key: 'report', label: t('job_detail.report') }] : []),
    { key: 'segments', label: t('job_detail.segments') },
    { key: 'downloads', label: t('job_detail.downloads') },
    { key: 'logs', label: t('job_detail.logs') },
  ];

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link href={`/${locale}/jobs`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" />{t('job_detail.back')}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              {job.sourceType === 'video' ? <FileVideo className="h-5 w-5 text-muted-foreground" /> : <FileAudio className="h-5 w-5 text-muted-foreground" />}
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{job.originalFileName}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] || STATUS_COLORS.uploaded}`}>
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
          <div className="flex items-center gap-2">
            {isActive && (
              <button onClick={handleCancel} disabled={cancelling || job.cancelRequested}
                className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50 transition-colors disabled:opacity-50">
                <Ban className="h-4 w-4" />{job.cancelRequested ? t('job_detail.cancelling') : t('job_detail.cancel')}
              </button>
            )}
            {(job.status === 'failed' || job.status === 'completed' || job.status === 'cancelled') && (
              <button onClick={handleRetry} disabled={retrying}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted transition-colors disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />{t('job_detail.retry')}
              </button>
            )}
            <button onClick={handleDelete}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50 transition-colors">
              <Trash2 className="h-4 w-4" />{t('job_detail.delete')}
            </button>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      {isActive && (
        <div className="mb-6 rounded-xl border border-border/60 bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground">{job.currentStage || t(`status.${job.status}`)}</span>
            <span className="text-sm font-semibold text-primary">{job.progress}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
            <div className="bg-primary h-3 rounded-full transition-all duration-700 ease-out" style={{ width: `${job.progress}%` }} />
          </div>
          {/* Stage pills */}
          <div className="flex items-center gap-1 mt-3 overflow-x-auto">
            {STATUS_STEPS.filter(s => s !== 'uploaded' && s !== 'queued').map((step, i) => {
              const isStepActive = step === job.status;
              const isComplete = STATUS_STEPS.indexOf(step) < currentStepIndex;
              return (
                <div key={step} className="flex items-center gap-1 shrink-0">
                  <div className={`flex h-6 items-center rounded-full px-2 text-xs font-medium transition-all ${
                    isStepActive ? 'bg-primary text-primary-foreground' : isComplete ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground/50'
                  }`}>
                    {isComplete ? <CheckCircle2 className="h-3 w-3 mr-1" /> : isStepActive ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    {t(`status.${step}`)}
                  </div>
                  {i < STATUS_STEPS.length - 3 && <div className={`h-0.5 w-3 ${isComplete ? 'bg-green-300' : 'bg-muted'}`} />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error / Cancelled Banner */}
      {(job.status === 'failed' || job.status === 'cancelled') && job.errorMessage && (
        <div className={`mb-6 flex items-start gap-3 rounded-xl border p-4 ${job.status === 'cancelled' ? 'border-gray-200 bg-gray-50' : 'border-red-200 bg-red-50'}`}>
          {job.status === 'cancelled' ? <Ban className="h-5 w-5 text-gray-500 shrink-0 mt-0.5" /> : <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />}
          <div>
            <p className={`font-medium ${job.status === 'cancelled' ? 'text-gray-700' : 'text-red-800'}`}>{t(`status.${job.status}`)}</p>
            <p className={`mt-1 text-sm ${job.status === 'cancelled' ? 'text-gray-600' : 'text-red-700'}`}>{job.errorMessage}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-xl bg-muted p-1 overflow-x-auto">
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="rounded-xl border border-border/60 bg-white p-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid sm:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold text-foreground mb-3">{t('job_detail.file_info')}</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.filename')}</dt><dd className="font-medium truncate ml-4">{job.originalFileName}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.file_size')}</dt><dd className="font-medium">{formatBytes(parseInt(job.originalFileSize))}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.file_type')}</dt><dd className="font-medium">{job.originalMimeType}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.source_type')}</dt><dd className="font-medium capitalize">{t(`common.${job.sourceType}`)}</dd></div>
                  {job.durationSeconds && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.audio_duration')}</dt><dd className="font-medium">{formatDuration(job.durationSeconds)}</dd></div>}
                </dl>
              </div>
              <div>
                <h3 className="font-semibold text-foreground mb-3">{t('job_detail.processing_info')}</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.status')}</dt><dd><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status]}`}>{t(`status.${job.status}`)}</span></dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.mode')}</dt><dd className="font-medium">{t(`mode.${job.processingMode}`)}</dd></div>
                  {job.detectedLanguage && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.detected_language')}</dt><dd className="font-medium uppercase">{job.detectedLanguage}</dd></div>}
                  {job.targetLanguage && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.target_language')}</dt><dd className="font-medium uppercase">{job.targetLanguage}</dd></div>}
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.created_at')}</dt><dd className="font-medium">{new Date(job.createdAt).toLocaleString(locale)}</dd></div>
                  {job.completedAt && <div className="flex justify-between"><dt className="text-muted-foreground">{t('job_detail.completed_at')}</dt><dd className="font-medium">{new Date(job.completedAt).toLocaleString(locale)}</dd></div>}
                </dl>
              </div>
            </div>

            {/* Stage Timings */}
            {job.timings.length > 0 && (
              <div>
                <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4" />{t('job_detail.timings')}
                </h3>
                <div className="space-y-2">
                  {job.timings.map(timing => (
                    <div key={timing.id} className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground w-40">{t(`status.${timing.stage}`)}</span>
                      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                        <div className={`h-2 rounded-full ${timing.completedAt ? 'bg-green-400' : 'bg-primary animate-pulse'}`}
                          style={{ width: timing.durationMs && totalTimingMs > 0 ? `${(timing.durationMs / totalTimingMs) * 100}%` : timing.completedAt ? '100%' : '50%' }} />
                      </div>
                      <span className="text-sm font-mono font-medium text-foreground w-20 text-right">
                        {timing.durationMs ? formatTimingMs(timing.durationMs) : '...'}
                      </span>
                    </div>
                  ))}
                  {totalTimingMs > 0 && (
                    <div className="flex items-center gap-3 pt-2 border-t border-border/40">
                      <span className="text-sm font-semibold text-foreground w-40">{t('job_detail.timing_total')}</span>
                      <div className="flex-1" />
                      <span className="text-sm font-mono font-bold text-primary w-20 text-right">{formatTimingMs(totalTimingMs)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'transcript' && (
          <div>
            {job.segments.length > 0 ? (
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">{job.segments.map(s => s.sourceText).join(' ')}</p>
              </div>
            ) : <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_transcript')}</p>}
          </div>
        )}

        {activeTab === 'translation' && (
          <div>
            {hasTranslation ? (
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">{job.segments.map(s => s.translatedText || s.sourceText).join(' ')}</p>
              </div>
            ) : <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_translation')}</p>}
          </div>
        )}

        {activeTab === 'report' && (
          <ReportTab job={job} locale={locale} t={t} onReportUpdated={fetchJob} />
        )}

        {activeTab === 'segments' && (
          <div>
            {job.segments.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.time')}</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.source_text')}</th>
                      {hasTranslation && <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('job_detail.segment_table.translated_text')}</th>}
                      <th className="pb-2 font-medium text-muted-foreground">{t('job_detail.segment_table.confidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.segments.map(seg => (
                      <tr key={seg.id} className="border-b border-border/40 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground whitespace-nowrap">{formatMs(seg.startMs)}</td>
                        <td className="py-2 pr-4">{seg.sourceText}</td>
                        {hasTranslation && <td className="py-2 pr-4 text-muted-foreground">{seg.translatedText || '—'}</td>}
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
            ) : <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_segments')}</p>}
          </div>
        )}

        {activeTab === 'downloads' && (
          <div>
            {downloadableArtifacts.length > 0 ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {downloadableArtifacts.map(artifact => (
                  <a key={artifact.id} href={`/api/jobs/${job.id}/artifacts/${artifact.id}`} download
                    className="flex items-center gap-3 rounded-xl border border-border/60 p-3 hover:bg-muted/30 hover:border-primary/30 transition-colors">
                    <Download className="h-5 w-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{t(`job_detail.${DOWNLOAD_LABELS[artifact.type] || 'download'}`)}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(parseInt(artifact.sizeBytes))}</p>
                    </div>
                  </a>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_transcript')}</p>}
          </div>
        )}

        {activeTab === 'logs' && (
          <div>
            {job.logs.length > 0 ? (
              <div className="space-y-1 font-mono text-xs">
                {job.logs.map(log => (
                  <div key={log.id} className={`flex gap-2 py-1 ${log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-600' : 'text-muted-foreground'}`}>
                    <span className="text-muted-foreground/50 shrink-0">{new Date(log.createdAt).toLocaleTimeString(locale)}</span>
                    <span className="uppercase font-bold w-12 shrink-0">{log.level}</span>
                    <span className="text-primary/60 shrink-0">[{log.stage}]</span>
                    <span className="text-foreground">{log.message}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_logs')}</p>}
          </div>
        )}
      </div>
    </div>
  );
}


// --- Report Tab with Enrichment + Dual Reports + Versioning ---

function renderMarkdown(md: string): string {
  return md
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.*$)/gm, '<h3 class="text-lg font-semibold mt-4 mb-2 text-foreground">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 class="text-xl font-bold mt-6 mb-3 text-foreground border-b border-border/40 pb-1">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 class="text-2xl font-bold mt-6 mb-3 text-foreground">$1</h1>')
    .replace(/^- (.*$)/gm, '<li class="ml-4 mb-1">• $1</li>')
    .replace(/^\d+\. (.*$)/gm, '<li class="ml-4 mb-1">$1</li>')
    .replace(/\n\n/g, '</p><p class="mt-3">')
    .replace(/\n/g, '<br />');
}

const PRESET_INSTRUCTIONS: Record<string, string> = {
  enrich_technical: 'Enrich the report with deep technical analysis. Act as a senior technical architect and analyze all technical aspects discussed: systems, integrations, architectures, data flows, technical requirements, and constraints. Add technical recommendations and best practices.',
  enrich_executive: 'Rewrite the executive summary to be more strategic and impactful. Add business impact analysis, ROI considerations, strategic alignment assessment, and key performance indicators. Make it suitable for C-level presentation.',
  enrich_actions: 'Expand the action items section significantly. For each action item, add detailed task breakdown, success criteria, estimated effort, dependencies, and suggested milestones. Create a prioritized action plan with a timeline.',
  enrich_risks: 'Add a comprehensive risk analysis. Identify all explicit and implicit risks from the discussion. For each risk, provide: severity assessment, probability, impact analysis, mitigation strategy, and contingency plan.',
  enrich_recommendations: 'Add a detailed recommendations section. Based on everything discussed, provide expert recommendations organized by priority. Include quick wins, medium-term improvements, and long-term strategic recommendations with estimated impact and effort.',
};

function ReportTab({ job, locale, t, onReportUpdated }: {
  job: JobData; locale: Locale; t: (key: string, params?: Record<string, string>) => string; onReportUpdated: () => void;
}) {
  const hasTechnical = !!job.technicalReport;
  const [activeReport, setActiveReport] = useState<'meeting' | 'technical'>(hasTechnical ? 'technical' : 'meeting');
  const [enriching, setEnriching] = useState(false);
  const [customInstruction, setCustomInstruction] = useState('');
  const [domainContext, setDomainContext] = useState(job.domainContext || '');
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null);

  const currentReport = activeReport === 'technical' ? job.technicalReport : job.meetingReport;
  const versions = (job.reportVersions || []).filter(v => v.reportType === activeReport);

  const handleEnrich = async (instruction: string, label?: string) => {
    setEnriching(true);
    setEnrichError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction,
          context: domainContext,
          reportType: activeReport,
          label: label || instruction.substring(0, 50),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Enrichment failed');
      onReportUpdated();
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setEnriching(false);
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    setRestoringVersion(versionId);
    try {
      const res = await fetch(`/api/jobs/${job.id}/report-versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId, reportType: activeReport }),
      });
      if (!res.ok) throw new Error('Failed to restore');
      onReportUpdated();
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : 'Failed to restore version');
    } finally {
      setRestoringVersion(null);
    }
  };

  const [translating, setTranslating] = useState(false);
  const [translateLang, setTranslateLang] = useState('');

  const handleTranslate = async (lang: string) => {
    if (!lang) return;
    setTranslating(true);
    setEnrichError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/translate-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: lang, reportType: activeReport }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Translation failed');
      setTranslateLang('');
      onReportUpdated();
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : 'Failed to translate');
    } finally {
      setTranslating(false);
    }
  };

  const presets = [
    { key: 'enrich_technical', icon: '🔧' },
    { key: 'enrich_executive', icon: '📊' },
    { key: 'enrich_actions', icon: '✅' },
    { key: 'enrich_risks', icon: '⚠️' },
    { key: 'enrich_recommendations', icon: '💡' },
  ];

  if (!job.meetingReport && !job.technicalReport) {
    return <p className="text-sm text-muted-foreground text-center py-8">{t('job_detail.no_report')}</p>;
  }

  return (
    <div className="space-y-6">
      {/* Report Type Tabs */}
      <div className="flex items-center gap-1 border-b border-border/60">
        <button onClick={() => setActiveReport('meeting')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeReport === 'meeting' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {t('job_detail.report_meeting')}
        </button>
        {hasTechnical && (
          <button onClick={() => setActiveReport('technical')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeReport === 'technical' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t('job_detail.report_technical')}
          </button>
        )}

        {/* Version History Toggle */}
        {versions.length > 1 && (
          <button onClick={() => setShowVersions(!showVersions)}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {t('job_detail.versions', { count: String(versions.length) })}
          </button>
        )}
      </div>

      {/* Version History Panel */}
      {showVersions && versions.length > 1 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
          <p className="text-xs font-medium text-foreground mb-2">{t('job_detail.version_history')}</p>
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">v{v.version}</span>
                <span className="text-foreground">{v.label}</span>
                <span className="text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
              <button onClick={() => handleRestoreVersion(v.id)}
                disabled={restoringVersion === v.id}
                className="text-primary hover:underline disabled:opacity-50">
                {restoringVersion === v.id ? '...' : t('job_detail.restore')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Report Content */}
      {currentReport ? (
        <div className="prose prose-sm max-w-none">
          <div className="leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: renderMarkdown(currentReport) }} />
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground">{t('job_detail.no_technical_report')}</p>
          {!job.domainContext && (
            <p className="text-xs text-muted-foreground mt-2">{t('job_detail.no_technical_report_hint')}</p>
          )}
        </div>
      )}

      {/* Translate Report */}
      {currentReport && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{t('job_detail.translate_report')}</span>
          {['en', 'pt', 'es', 'fr', 'de', 'it'].map(lang => (
            <button key={lang} onClick={() => handleTranslate(lang)}
              disabled={translating || enriching}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-2.5 py-1 text-xs font-medium text-foreground hover:bg-primary/5 hover:border-primary/30 transition-colors disabled:opacity-50">
              {translating ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t(`job_detail.lang_${lang}`)}
            </button>
          ))}
        </div>
      )}

      {/* Enrichment Section */}
      <div className="border-t border-border/60 pt-6">
        <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          {t('job_detail.enrich_title')}
        </h3>

        <div className="mb-4">
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('job_detail.enrich_context')}</label>
          <input type="text" value={domainContext} onChange={(e) => setDomainContext(e.target.value)}
            placeholder={t('job_detail.enrich_context_placeholder')}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            disabled={enriching} />
          <p className="mt-1 text-xs text-muted-foreground">{t('job_detail.enrich_context_help')}</p>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-foreground mb-2">{t('job_detail.enrich_presets')}</label>
          <div className="flex flex-wrap gap-2">
            {presets.map(({ key, icon }) => (
              <button key={key} onClick={() => handleEnrich(PRESET_INSTRUCTIONS[key], t(`job_detail.${key}`))} disabled={enriching}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/5 hover:border-primary/30 transition-colors disabled:opacity-50">
                <span>{icon}</span>{t(`job_detail.${key}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-foreground mb-1.5">{t('job_detail.enrich_custom')}</label>
          <div className="flex gap-2">
            <textarea value={customInstruction} onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder={t('job_detail.enrich_custom_placeholder')} rows={2}
              className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary resize-none"
              disabled={enriching} />
            <button onClick={() => { if (customInstruction.trim()) handleEnrich(customInstruction); }}
              disabled={enriching || !customInstruction.trim()}
              className="self-end rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 shrink-0">
              {enriching ? <Loader2 className="h-4 w-4 animate-spin" /> : t('job_detail.enrich_send')}
            </button>
          </div>
        </div>

        {enriching && (
          <div className="flex items-center gap-2 text-sm text-primary">
            <Loader2 className="h-4 w-4 animate-spin" />{t('job_detail.enrich_processing')}
          </div>
        )}
        {enrichError && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertCircle className="h-4 w-4" />{enrichError}
          </div>
        )}
      </div>
    </div>
  );
}
