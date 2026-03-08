import type { Locale } from '@/types';
import { SUPPORTED_LOCALES } from '@/types';
import { getDictionary } from '@/lib/i18n';
import { JobDetail } from '@/components/jobs/job-detail';

interface Props {
  params: { locale: string; id: string };
}

export default function JobDetailPage({ params }: Props) {
  const locale = (SUPPORTED_LOCALES.includes(params.locale as Locale) ? params.locale : 'en') as Locale;
  const dict = getDictionary(locale);

  return <JobDetail locale={locale} dict={dict} jobId={params.id} />;
}
