import type { Locale } from '@/types';
import { SUPPORTED_LOCALES } from '@/types';
import { getDictionary } from '@/lib/i18n';
import { UploadForm } from '@/components/upload/upload-form';

interface Props {
  params: { locale: string };
}

export default function UploadPage({ params }: Props) {
  const locale = (SUPPORTED_LOCALES.includes(params.locale as Locale) ? params.locale : 'en') as Locale;
  const dict = getDictionary(locale);

  return <UploadForm locale={locale} dict={dict} />;
}
