import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { kv, StorageKeys } from '../lib/kv.js';
import { FALLBACK_LOCALE, resources, resolveLocale, SUPPORTED_LOCALES, type SupportedLocale } from './locales.js';
import { createLogger } from '../lib/logger.js';

/**
 * Internationalisation.
 *
 * The device locale is used on first launch and the user's explicit choice is
 * persisted afterwards, so changing the OS language never silently overrides a
 * preference set inside the app.
 *
 * Every user-facing string in the app goes through `t()`. Ingredient and recipe
 * names come from the API and are never translated here — translating a food name
 * client-side would break the normalised keys the pantry matcher relies on.
 */

const log = createLogger('i18n');

// Re-exported so existing imports from 'i18n/index.js' keep working, while the
// pure definitions live in ./locales.js where any test runner can reach them.
export { resources, resolveLocale, SUPPORTED_LOCALES, FALLBACK_LOCALE };
export type { SupportedLocale };

function deviceLocale(): SupportedLocale {
  try {
    const locales = getLocales();
    for (const locale of locales) {
      const resolved = resolveLocale(locale.languageTag);
      // Only accept an explicit match; the resolver falls back on its own.
      if (resolved !== FALLBACK_LOCALE) return resolved;
    }
    return resolveLocale(locales[0]?.languageTag);
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** The locale to boot with: the saved choice, else the device locale. */
export function initialLocale(): SupportedLocale {
  const saved = kv.get(StorageKeys.locale);
  if (saved && saved in resources) return saved as SupportedLocale;
  return deviceLocale();
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale(),
  fallbackLng: FALLBACK_LOCALE,
  // Keys are grouped by screen; a missing key should be visible, not silent.
  interpolation: { escapeValue: false },
  returnNull: false,
  compatibilityJSON: 'v4',
  defaultNS: 'common',
  ns: ['common', 'home', 'scan', 'pantry', 'recipes', 'plan', 'grocery', 'waste', 'achievements', 'profile', 'premium', 'settings', 'auth'],
});

/** Persist a language choice and apply it immediately. */
export async function changeLocale(locale: SupportedLocale): Promise<void> {
  kv.set(StorageKeys.locale, locale);
  try {
    await i18n.changeLanguage(locale);
  } catch (err) {
    log.warn('Failed to change language', err);
  }
}

/** Convenience for code outside React (stores, hooks, API error mapping). */
export function translate(key: string, options?: Record<string, unknown>): string {
  // i18next's overloaded `t` returns TFunctionDetailedResult for some
  // signatures; we only ever use the plain-string form.
  return i18n.t(key, options as never) as unknown as string;
}

export { i18n };
export default i18n;
