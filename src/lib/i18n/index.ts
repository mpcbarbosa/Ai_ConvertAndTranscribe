import type { Locale } from '../../types';

// Import all locale dictionaries statically
import en from '../../locales/en/common.json';
import pt from '../../locales/pt/common.json';
import es from '../../locales/es/common.json';
import fr from '../../locales/fr/common.json';

const dictionaries: Record<Locale, Record<string, unknown>> = { en, pt, es, fr };

export function getDictionary(locale: Locale): Record<string, unknown> {
  return dictionaries[locale] || dictionaries.en;
}

/**
 * Get a nested value from a dictionary using dot notation.
 * e.g., t('upload.title') returns the value at dict.upload.title
 */
export function getTranslation(dict: Record<string, unknown>, key: string): string {
  const keys = key.split('.');
  let current: unknown = dict;
  for (const k of keys) {
    if (current && typeof current === 'object' && k in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[k];
    } else {
      return key; // Return key as fallback
    }
  }
  return typeof current === 'string' ? current : key;
}

/**
 * Create a translation function bound to a dictionary.
 * Supports simple interpolation with {variable} syntax.
 */
export function createTranslator(dict: Record<string, unknown>) {
  return function t(key: string, params?: Record<string, string>): string {
    let value = getTranslation(dict, key);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replace(`{${k}}`, v);
      });
    }
    return value;
  };
}

export const SUPPORTED_LOCALES: Locale[] = ['en', 'pt', 'es', 'fr'];
export const DEFAULT_LOCALE: Locale = 'en';

export function isValidLocale(locale: string): locale is Locale {
  return SUPPORTED_LOCALES.includes(locale as Locale);
}

export function getLocaleFromPath(pathname: string): Locale {
  const segment = pathname.split('/')[1];
  return isValidLocale(segment) ? segment : DEFAULT_LOCALE;
}
