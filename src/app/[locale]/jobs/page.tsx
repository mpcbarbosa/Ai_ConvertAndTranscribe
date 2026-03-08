import type { Locale } from '@/types';
import { SUPPORTED_LOCALES } from '@/types';
import { getDictionary } from '@/lib/i18n';
import { JobsList } from '@/components/jobs/jobs-list';

interface Props {
  params: { locale: string };
}

export default function JobsPage({ params }: Props) {
  const locale = (SUPPORTED_LOCALES.includes(params.locale as Locale) ? params.locale : 'en') as Locale;
  const dict = getDictionary(locale);

  return <JobsList locale={locale} dict={dict} />;
}
