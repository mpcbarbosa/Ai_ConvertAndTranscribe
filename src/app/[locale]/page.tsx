import Link from 'next/link';
import type { Locale } from '@/types';
import { SUPPORTED_LOCALES } from '@/types';
import { getDictionary, createTranslator } from '@/lib/i18n';
import { Upload, ListTodo, Languages, FileAudio } from 'lucide-react';

interface Props {
  params: { locale: string };
}

export default function HomePage({ params }: Props) {
  const locale = (SUPPORTED_LOCALES.includes(params.locale as Locale) ? params.locale : 'en') as Locale;
  const dict = getDictionary(locale);
  const t = createTranslator(dict);

  return (
    <div className="flex flex-col items-center pt-12 pb-16">
      {/* Hero */}
      <div className="text-center max-w-2xl mb-16">
        <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary mb-6">
          <FileAudio className="h-4 w-4" />
          {t('app.tagline')}
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground mb-4">
          TranscribeX
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          {t('app.description')}
        </p>
      </div>

      {/* Action Cards */}
      <div className="grid sm:grid-cols-2 gap-6 w-full max-w-2xl">
        <Link
          href={`/${locale}/upload`}
          className="group flex flex-col items-center gap-4 rounded-2xl border border-border/60 bg-white p-8 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
            <Upload className="h-7 w-7" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-foreground">{t('nav.upload')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('upload.subtitle')}</p>
          </div>
        </Link>

        <Link
          href={`/${locale}/jobs`}
          className="group flex flex-col items-center gap-4 rounded-2xl border border-border/60 bg-white p-8 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
            <ListTodo className="h-7 w-7" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-foreground">{t('nav.jobs')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('jobs.subtitle')}</p>
          </div>
        </Link>
      </div>

      {/* Features */}
      <div className="mt-16 grid sm:grid-cols-3 gap-6 w-full max-w-3xl">
        {[
          { icon: FileAudio, label: 'MP4, MOV, MKV, MP3, WAV...' },
          { icon: Languages, label: 'EN, PT, ES, FR' },
          { icon: ListTodo, label: 'SRT, VTT, TXT, JSON' },
        ].map((feature, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl bg-white/60 border border-border/40 px-4 py-3">
            <feature.icon className="h-5 w-5 text-primary/70 shrink-0" />
            <span className="text-sm font-medium text-muted-foreground">{feature.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
