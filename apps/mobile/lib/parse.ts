/**
 * Client-side parsing helpers.
 *
 * These mirror the server's `utils/food.ts` for the narrow cases where the UI
 * needs a number before it has talked to the API — chiefly turning a vision
 * model's `estimated_quantity` string ("about 250 g", "1/2 cup") into a number
 * and a canonical unit for the confirm-scan payload.
 *
 * They are deliberately conservative: when a string cannot be parsed the caller
 * gets `null` and falls back to the server-side default, rather than a wrong
 * number that would quietly corrupt the pantry.
 */

export interface ParsedQuantity {
  quantity: number | null;
  unit: string | null;
}

/** Canonical unit spellings, matching the API's `UNIT_ALIASES`. */
const UNIT_ALIASES: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gm: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg',
  mg: 'mg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', pound: 'lb', pounds: 'lb',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  cup: 'cups', cups: 'cups',
  piece: 'pieces', pieces: 'pieces', pcs: 'pieces', pc: 'pieces', unit: 'pieces', units: 'pieces', count: 'pieces',
  clove: 'cloves', cloves: 'cloves',
  slice: 'slices', slices: 'slices',
  can: 'cans', cans: 'cans', tin: 'cans',
  bunch: 'bunches', bunches: 'bunches',
  head: 'heads', heads: 'heads',
  pinch: 'pinch', dash: 'dash', handful: 'handful',
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  half: 0.5, quarter: 0.25,
};

/** Normalise a free-form unit to its canonical spelling, or null if unknown. */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase();
  if (!key) return null;
  return UNIT_ALIASES[key] ?? null;
}

/**
 * Parse a free-text quantity.
 *
 * Handles the forms a vision model actually emits:
 *   "250 g" · "500ml" · "1/2 cup" · "about 2 large" · "3 pieces" · "a pinch"
 */
export function parseQuantity(raw: string | null | undefined): ParsedQuantity {
  if (!raw) return { quantity: null, unit: null };

  const text = String(raw).trim().toLowerCase();
  if (!text) return { quantity: null, unit: null };

  let quantity: number | null = null;

  // Fractions, including mixed ("1 1/2").
  const fraction = text.match(/(\d+\s+)?(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const whole = fraction[1] ? Number(fraction[1].trim()) : 0;
    const numerator = Number(fraction[2]);
    const denominator = Number(fraction[3]);
    if (denominator > 0) quantity = whole + numerator / denominator;
  }

  // Unicode vulgar fractions a label might contain.
  if (quantity === null) {
    const vulgar: Record<string, number> = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅛': 0.125 };
    for (const [glyph, value] of Object.entries(vulgar)) {
      if (text.includes(glyph)) {
        const leading = text.match(/(\d+)\s*\u00a0?\s*/);
        quantity = (leading ? Number(leading[1]) : 0) + value;
        break;
      }
    }
  }

  if (quantity === null) {
    const numeric = text.match(/\d+(?:\.\d+)?/);
    if (numeric) quantity = Number(numeric[0]);
  }

  if (quantity === null) {
    for (const [word, value] of Object.entries(WORD_NUMBERS)) {
      if (text === word || text.startsWith(`${word} `)) {
        quantity = value;
        break;
      }
    }
  }

  // Unit: split digit/letter boundaries so "500ml" still yields "ml".
  let unit: string | null = null;
  const tokens = text
    .replace(/[^a-z0-9/\s]/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    if (/^\d/.test(token) || token.includes('/')) continue;
    const canonical = normalizeUnit(token);
    if (canonical) {
      unit = canonical;
      break;
    }
  }

  return {
    quantity: quantity === null || !Number.isFinite(quantity) ? null : Math.round(quantity * 1000) / 1000,
    unit,
  };
}

/** Coerce a value that may arrive as a string or number from a form field. */
export function toNumber(value: unknown, fallback: number | null = null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const digits = value.replace(/[^0-9.\-]/g, '');
    // Stripping a non-numeric string leaves "", and Number("") is 0 — which would
    // silently turn a typo into a zero quantity rather than "no value".
    if (digits.trim() === '' || digits === '-' || digits === '.') return fallback;
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Parse an ISO date string, returning null rather than an Invalid Date. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a Date as YYYY-MM-DD in local time, for date inputs. */
export function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
