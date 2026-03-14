'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createTranslator } from '../../lib/i18n';
import { formatBytes, formatDuration } from '../../lib/utils';
import type { Locale } from '../../types';
import {
  Search, FileAudio, FileVideo, Loader2, ChevronRight,
  Sparkles, Scale, Inbox, Trash2, CheckSquare, Square, XSquare,
} from 'lucide-react';

interface JobSummary {
  id: string; originalFileName: string; originalFileSize: string;
  sourceType: string; sourceLanguage: string | null; detectedLanguage: string | null;
  targetLanguage: string | null; processingMode: string; status: string;
  durationSeconds: number | null; createdAt: string; completedAt: string | null;
  errorMessage: string | null;
}

interface Props { locale: Locale; dict: Record<string, unknown>; }

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-700', queued: 'bg-blue-100 text-blue-700',
  converting: 'bg-amber-100 text-amber-700', transcribing: 'bg-indigo-100 text-indigo-700',
  post_processing: 'bg-purple-100 text-purple-700', translating: 'bg-cyan-100 text-cyan-700',
  generating_outputs: 'bg-teal-100 text-teal-700', completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-700',
};

export function JobsList({ locale, dict }: Props) {
  const t = createTranslator(dict);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (search) params.set('search', search);
      const res = await fetch(`/api/jobs?${params}`);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const selectMode = selected.size > 0;

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === jobs.length) setSelected(new Set());
    else setSelected(new Set(jobs.map(j => j.id)));
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!confirm(t('jobs.bulk_delete_confirm', { count: String(count) }))) return;

    setDeleting(true);
    try {
      const ids = Array.from(selected);
      await Promise.all(ids.map(id =>
        fetch(`/api/jobs/${id}/delete`, { method: 'POST' })
      ));
      setSelected(new Set());
      await fetchJobs();
    } catch { /* ignore */ } finally { setDeleting(false); }
  };

  const filters = [
    { key: 'all', label: t('jobs.filter_all') },
    { key: 'completed', label: t('jobs.filter_completed') },
    { key: 'processing', label: t('jobs.filter_processing') },
    { key: 'failed', label: t('jobs.filter_failed') },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">{t('jobs.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('jobs.subtitle')}</p>
      </div>

      {/* Filters, Search, and Bulk Actions */}
      <div className="mb-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {filters.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.key ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t('jobs.search_placeholder')}
            className="w-full rounded-xl border border-border bg-white pl-9 pr-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </div>

        {/* Bulk actions */}
        <div className="flex items-center gap-2 ml-auto">
          {jobs.length > 0 && (
            <button onClick={selectAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
              {selected.size === jobs.length ? <XSquare className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
              {selected.size === jobs.length ? t('jobs.deselect_all') : t('jobs.select_all')}
            </button>
          )}

          {selectMode && (
            <button onClick={handleBulkDelete} disabled={deleting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {t('jobs.delete_selected', { count: String(selected.size) })}
            </button>
          )}
        </div>
      </div>

      {/* Jobs List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-2 text-sm text-muted-foreground">{t('jobs.loading')}</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
          <Inbox className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('jobs.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="group flex items-center gap-3 rounded-xl border border-border/60 bg-white p-3 shadow-sm transition-all hover:border-primary/30 hover:shadow-md">
              {/* Checkbox */}
              <button onClick={(e) => toggleSelect(job.id, e)}
                className="shrink-0 text-muted-foreground hover:text-primary transition-colors">
                {selected.has(job.id) ? (
                  <CheckSquare className="h-5 w-5 text-primary" />
                ) : (
                  <Square className="h-5 w-5" />
                )}
              </button>

              {/* Rest is a link */}
              <Link href={`/${locale}/jobs/${job.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {job.sourceType === 'video' ? <FileVideo className="h-4 w-4 text-muted-foreground" /> : <FileAudio className="h-4 w-4 text-muted-foreground" />}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{job.originalFileName}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatBytes(parseInt(job.originalFileSize))}</span>
                    <span>·</span>
                    <span>{new Date(job.createdAt).toLocaleDateString(locale)}</span>
                    {job.durationSeconds && (<><span>·</span><span>{formatDuration(job.durationSeconds)}</span></>)}
                  </div>
                </div>

                <div className="hidden sm:flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {job.processingMode === 'best_quality' ? <Sparkles className="h-3 w-3" /> : <Scale className="h-3 w-3" />}
                    {t(`mode.${job.processingMode}`)}
                  </span>
                  {(job.detectedLanguage || job.sourceLanguage) && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground uppercase">
                      {job.detectedLanguage || job.sourceLanguage}
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] || STATUS_COLORS.uploaded}`}>
                    {t(`status.${job.status}`)}
                  </span>
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors shrink-0" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
