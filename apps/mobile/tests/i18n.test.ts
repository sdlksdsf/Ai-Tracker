import en from '../i18n/locales/en.js';
import es from '../i18n/locales/es.js';
import { resolveLocale, resources, SUPPORTED_LOCALES } from '../i18n/locales.js';

/**
 * Translation integrity.
 *
 * i18next falls back to English per missing key, so a gap in `es.ts` is invisible
 * at runtime — it just silently renders English inside a Spanish UI. These tests
 * turn that silent failure into a build failure.
 */

type Leaf = string | number | boolean;

/** Flatten a nested catalogue into `a.b.c` keys. */
function flatten(node: unknown, prefix = '', out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') {
    if (prefix) out.push(prefix);
    return out;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }

  return out;
}

/** Every `{{name}}` placeholder in a string, in the order they appear. */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]!);
}

/** Read a value by dotted path. */
function dig(node: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, node);
}

describe('locale registration', () => {
  it('registers every locale the settings screen offers', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(resources[locale.code], `${locale.code} is selectable but has no catalogue`).toBeTruthy();
    }
  });

  it('lists English and Spanish', () => {
    expect(SUPPORTED_LOCALES.map((locale) => locale.code).sort()).toEqual(['en', 'es']);
  });
});

describe('locale resolution', () => {
  it('matches an exact tag', () => {
    expect(resolveLocale('es')).toBe('es');
    expect(resolveLocale('en')).toBe('en');
  });

  it('matches a regional tag to its base language', () => {
    expect(resolveLocale('es-MX')).toBe('es');
    expect(resolveLocale('es-ES')).toBe('es');
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('en-US')).toBe('en');
  });

  it('is case insensitive', () => {
    expect(resolveLocale('ES-mx')).toBe('es');
  });

  it('falls back to English for an unsupported language', () => {
    expect(resolveLocale('fr-CA')).toBe('en');
    expect(resolveLocale('de')).toBe('en');
    expect(resolveLocale('zh-Hans')).toBe('en');
  });

  it('falls back to English for missing or malformed input', () => {
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
  });
});

describe('catalogue parity', () => {
  const englishKeys = flatten(en).sort();
  const spanishKeys = flatten(es).sort();

  it('has a substantial catalogue', () => {
    // A guard against someone replacing a catalogue with a stub.
    expect(englishKeys.length).toBeGreaterThan(200);
  });

  it('Spanish defines every key English does', () => {
    const missing = englishKeys.filter((key) => !spanishKeys.includes(key));
    expect(missing, `es.ts is missing: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
  });

  it('Spanish has no orphan keys English does not', () => {
    const extra = spanishKeys.filter((key) => !englishKeys.includes(key));
    expect(extra, `es.ts has keys not in en.ts: ${extra.slice(0, 20).join(', ')}`).toEqual([]);
  });

  it('every namespace exists in both', () => {
    const englishNamespaces = Object.keys(en).sort();
    const spanishNamespaces = Object.keys(es).sort();
    expect(spanishNamespaces).toEqual(englishNamespaces);
  });
});

describe('interpolation parity', () => {
  const englishKeys = flatten(en);

  it('uses the same placeholders in both languages', () => {
    const mismatches: string[] = [];

    for (const key of englishKeys) {
      const englishPlaceholders = placeholders(dig(en, key)).sort();
      const spanishPlaceholders = placeholders(dig(es, key)).sort();

      // Order may legitimately differ between languages; the SET may not.
      if (englishPlaceholders.join(',') !== spanishPlaceholders.join(',')) {
        mismatches.push(`${key}: en={${englishPlaceholders}} es={${spanishPlaceholders}}`);
      }
    }

    expect(mismatches, `Placeholder mismatch:\n${mismatches.slice(0, 10).join('\n')}`).toEqual([]);
  });

  it('declares a count placeholder wherever a plural is used', () => {
    // i18next resolves plurals from `count`; a string saying "{{n}} items" with a
    // `n` placeholder would never pluralise.
    const suspicious: string[] = [];

    for (const key of flatten(en)) {
      const value = dig(en, key);
      if (typeof value !== 'string') continue;
      const used = placeholders(value);
      if (used.includes('count') && !/\{\{\s*count\s*\}\}/.test(value)) suspicious.push(key);
    }

    expect(suspicious).toEqual([]);
  });
});

describe('catalogue hygiene', () => {
  it('has no empty strings', () => {
    const empty: string[] = [];

    for (const catalogue of [en, es]) {
      for (const key of flatten(catalogue)) {
        const value = dig(catalogue, key);
        if (typeof value === 'string' && value.trim() === '') empty.push(key);
      }
    }

    expect(empty, `Empty translations: ${empty.join(', ')}`).toEqual([]);
  });

  /**
   * Strings that are legitimately identical in both languages: unit symbols,
   * brand and product names, and measurement-system names. Everything else that
   * matches byte-for-byte is an un-started translation.
   */
  const LEGITIMATELY_IDENTICAL = new Set([
    'common.minutes', // "{{count}} min" — "min" is the Spanish abbreviation too
    'common.calories', // "{{count}} kcal" — a unit, not a word
    'achievements.points', // "{{count}} pts" — a unit
    'premium.title', // "PlateMatch Premium" — product name
    'settings.imperial', // "Imperial (oz, lb, cup)" — measurement system + units
  ]);

  it('has no untranslated copies of the English source in Spanish', () => {
    const copied: string[] = [];

    for (const key of flatten(en)) {
      if (LEGITIMATELY_IDENTICAL.has(key)) continue;

      const englishValue = dig(en, key);
      const spanishValue = dig(es, key);
      if (typeof englishValue !== 'string' || typeof spanishValue !== 'string') continue;
      if (englishValue !== spanishValue) continue;
      // Short strings and single words are often legitimately shared.
      if (englishValue.length < 12 || !englishValue.includes(' ')) continue;
      copied.push(`${key}: "${englishValue}"`);
    }

    expect(copied, `Untranslated in es.ts:\n${copied.slice(0, 10).join('\n')}`).toEqual([]);
  });

  it('keeps the allowlist honest — every entry really is identical', () => {
    // Guards against the allowlist quietly accumulating keys that SHOULD have
    // been translated.
    for (const key of LEGITIMATELY_IDENTICAL) {
      expect(dig(en, key), `${key} is not in en.ts`).toBeDefined();
      expect(dig(es, key), `${key} is not in es.ts`).toBeDefined();
      expect(dig(es, key), `${key} has since been translated — drop it from the allowlist`).toBe(dig(en, key));
    }
  });

  it('keeps app and brand names untranslated', () => {
    expect((es.common as Record<string, Leaf>).appName).toBe('PlateMatch');
    expect((en.common as Record<string, Leaf>).appName).toBe('PlateMatch');
  });

  it('leaves no leaf value that is not a string', () => {
    // Numbers and booleans in a catalogue render but never translate.
    const nonStrings: string[] = [];

    for (const [name, catalogue] of Object.entries({ en, es })) {
      for (const key of flatten(catalogue)) {
        const value = dig(catalogue, key);
        if (typeof value !== 'string') nonStrings.push(`${name}:${key} (${typeof value})`);
      }
    }

    expect(nonStrings, `Non-string leaves: ${nonStrings.join(', ')}`).toEqual([]);
  });
});
