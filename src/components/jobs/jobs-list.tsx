'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createTranslator } from '@/lib/i18n';
import { formatBytes, formatDuration } from '@/lib/utils';
import type { Locale } from '@/types';
import {
  Search,
  FileAudio,
  FileVideo,
  Loader2,
  ChevronRight,
  Sparkles,
  Scale,
  Inbox,
} from 'lucide-react';

interface JobSummary {
  id: string;
  originalFileName: string;
  originalFileSize: string;
  sourceType: string;
  sourceLanguage: string | null;
  detectedLanguage: string | null;
  targetLanguage: string | null;
  processingMode: string;
  status: string;
  durationSeconds: number | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

interface Props {
  locale: Locale;
  dict: Record<string, unknown>;
}

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

export function JobsList({ locale, dict }: Props) {
  const t = createTranslator(dict);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const fetchJobs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (search) params.set('search', search);

      const res = await fetch(`/api/jobs?${params}`);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      console.error('Failed to fetch jobs');
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    fetchJobs();
    // Poll every 5 seconds for status updates
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const filters = [
    { key: 'all', label: t('jobs.filter_all') },
    { key: 'completed', label: t('jobs.filter_completed') },
    { key: 'processing', label: t('jobs.filter_processing') },
    { key: 'failed', label: t('jobs.filter_failed') },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">{t('jobs.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('jobs.subtitle')}</p>
      </div>

      {/* Filters and Search */}
      <div className="mb-6 flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.key
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('jobs.search_placeholder')}
            className="w-full rounded-xl border border-border bg-white pl-9 pr-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
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
        <div className="space-y-3">
          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/${locale}/jobs/${job.id}`}
              className="group flex items-center gap-4 rounded-xl border border-border/60 bg-white p-4 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
            >
              {/* Icon */}
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                {job.sourceType === 'video' ? (
                  <FileVideo className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <FileAudio className="h-5 w-5 text-muted-foreground" />
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground truncate">{job.originalFileName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatBytes(parseInt(job.originalFileSize))}</span>
                  <span>·</span>
                  <span>{new Date(job.createdAt).toLocaleDateString(locale)}</span>
                  {job.durationSeconds && (
                    <>
                      <span>·</span>
                      <span>{formatDuration(job.durationSeconds)}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Badges */}
              <div className="hidden sm:flex items-center gap-2">
                {/* Mode badge */}
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {job.processingMode === 'best_quality' ? (
                    <Sparkles className="h-3 w-3" />
                  ) : (
                    <Scale className="h-3 w-3" />
                  )}
                  {t(`mode.${job.processingMode}`)}
                </span>

                {/* Language badge */}
                {(job.detectedLanguage || job.sourceLanguage) && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground uppercase">
                    {job.detectedLanguage || job.sourceLanguage}
                  </span>
                )}

                {/* Status badge */}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] || STATUS_COLORS.uploaded}`}>
                  {t(`status.${job.status}`)}
                </span>
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
