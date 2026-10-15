import en from './locales/en.js';
import es from './locales/es.js';

/**
 * Locale catalogue and tag resolution — the platform-independent half of i18n.
 *
 * Split out from `i18n/index.ts` on purpose. That module initialises i18next and
 * reads the device locale, so it transitively imports `expo-localization` and
 * `lib/kv` (which imports React Native's `Platform`). None of that is loadable in
 * a plain Node test runner, which meant the catalogue-parity test could not run in
 * CI — a test nothing executes is a test that silently stops protecting anything.
 *
 * Everything here is pure data and pure functions, so it runs anywhere.
 */

export const resources = { en, es } as const;

export type SupportedLocale = keyof typeof resources;

export const SUPPORTED_LOCALES: Array<{ code: SupportedLocale; label: string; nativeLabel: string }> = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
];

/** The locale to fall back to when nothing better matches. */
export const FALLBACK_LOCALE: SupportedLocale = 'en';

/**
 * Best supported match for a BCP-47 tag.
 *
 * `es-MX` → `es`, `en-GB` → `en`, `fr-CA` → `en`. Matching on the base subtag
 * means a regional variant gets its language rather than silently dropping to
 * English, which is the difference between a usable and an unusable app for a
 * large share of Spanish speakers.
 */
export function resolveLocale(tag: string | null | undefined): SupportedLocale {
  if (!tag) return FALLBACK_LOCALE;

  const normalized = tag.toLowerCase().trim();
  if (!normalized) return FALLBACK_LOCALE;

  const base = normalized.split('-')[0] ?? '';
  if (base && base in resources) return base as SupportedLocale;

  return FALLBACK_LOCALE;
}

/** Every namespace declared across the catalogues. */
export const LOCALE_NAMESPACES: string[] = Object.keys(en);
