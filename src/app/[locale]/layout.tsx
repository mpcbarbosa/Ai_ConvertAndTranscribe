import type { Metadata } from 'next';
import type { Locale } from '@/types';
import { SUPPORTED_LOCALES } from '@/types';
import { getDictionary, createTranslator } from '@/lib/i18n';
import { Header } from '@/components/layout/header';

export const metadata: Metadata = {
  title: 'TranscribeX — Video & Audio Transcription',
  description: 'Upload video or audio files to get high-quality transcriptions with translation support.',
};

interface Props {
  children: React.ReactNode;
  params: { locale: string };
}

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map(locale => ({ locale }));
}

export default function LocaleLayout({ children, params }: Props) {
  const locale = (SUPPORTED_LOCALES.includes(params.locale as Locale) ? params.locale : 'en') as Locale;
  const dict = getDictionary(locale);
  const t = createTranslator(dict);

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50/30 antialiased">
        <Header locale={locale} t={t} />
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-border/40 mt-16 py-6 text-center text-sm text-muted-foreground">
          <p>{t('upload.disclaimer')}</p>
        </footer>
      </body>
    </html>
  );
}
