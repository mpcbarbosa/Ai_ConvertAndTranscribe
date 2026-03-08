'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { Locale } from '../../types';
import { SUPPORTED_LOCALES } from '../../types';
import { createTranslator } from '../../lib/i18n';
import { Upload, ListTodo, Globe } from 'lucide-react';

interface HeaderProps {
  locale: Locale;
  dict: Record<string, unknown>;
}

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  pt: 'Português',
  es: 'Español',
  fr: 'Français',
};

export function Header({ locale, dict }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useMemo(() => createTranslator(dict), [dict]);

  const switchLocale = (newLocale: string) => {
    const segments = pathname.split('/');
    segments[1] = newLocale;
    const newPath = segments.join('/');
    document.cookie = `locale=${newLocale};path=/;max-age=31536000;SameSite=Lax`;
    router.push(newPath);
  };

  const isActive = (path: string) => pathname.includes(path);

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-white/80 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href={`/${locale}`}
          className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-black">
            TX
          </div>
          <span className="hidden sm:inline">TranscribeX</span>
        </Link>

        <nav className="flex items-center gap-1">
          <Link
            href={`/${locale}/upload`}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive('/upload')
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">{t('nav.upload')}</span>
          </Link>

          <Link
            href={`/${locale}/jobs`}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive('/jobs')
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <ListTodo className="h-4 w-4" />
            <span className="hidden sm:inline">{t('nav.jobs')}</span>
          </Link>

          <div className="relative ml-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-white px-2 py-1.5">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <select
                value={locale}
                onChange={(e) => switchLocale(e.target.value)}
                className="cursor-pointer appearance-none border-none bg-transparent pr-4 text-sm font-medium text-foreground outline-none"
              >
                {SUPPORTED_LOCALES.map((loc) => (
                  <option key={loc} value={loc}>
                    {LOCALE_LABELS[loc]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </nav>
      </div>
    </header>
  );
}
