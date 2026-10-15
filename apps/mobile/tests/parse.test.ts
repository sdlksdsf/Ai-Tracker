import { normalizeUnit, parseIsoDate, parseQuantity, toLocalIsoDate, toNumber } from '../lib/parse.js';

/**
 * Client-side quantity parsing.
 *
 * Used when turning a vision model's `estimated_quantity` into the payload the
 * confirm-scan endpoint expects. A wrong unit here silently corrupts the pantry,
 * so unparsable input must yield null and let the server default win.
 */

describe('parseQuantity', () => {
  it('parses a metric quantity', () => {
    expect(parseQuantity('250 g')).toEqual({ quantity: 250, unit: 'g' });
    expect(parseQuantity('1.5 kg')).toEqual({ quantity: 1.5, unit: 'kg' });
  });

  it('parses a unit glued to the number', () => {
    // Pack labels and model output both do this constantly.
    expect(parseQuantity('500ml')).toEqual({ quantity: 500, unit: 'ml' });
    expect(parseQuantity('250g')).toEqual({ quantity: 250, unit: 'g' });
  });

  it('parses fractions', () => {
    expect(parseQuantity('1/2 cup')).toEqual({ quantity: 0.5, unit: 'cups' });
    expect(parseQuantity('1/4 tsp')?.quantity).toBe(0.25);
    expect(parseQuantity('1 1/2 cups')?.quantity).toBe(1.5);
  });

  it('parses unicode vulgar fractions', () => {
    expect(parseQuantity('½ cup')?.quantity).toBe(0.5);
    expect(parseQuantity('1½ cups')?.quantity).toBe(1.5);
  });

  it('parses spelled-out numbers', () => {
    expect(parseQuantity('two eggs')?.quantity).toBe(2);
    expect(parseQuantity('a pinch')?.quantity).toBe(1);
    expect(parseQuantity('half a lemon')?.quantity).toBe(0.5);
  });

  it('ignores leading filler', () => {
    expect(parseQuantity('about 2 large onions')?.quantity).toBe(2);
  });

  it('canonicalises the unit', () => {
    expect(parseQuantity('3 pieces')?.unit).toBe('pieces');
    expect(parseQuantity('2 tablespoons')?.unit).toBe('tbsp');
    expect(parseQuantity('1 litre')?.unit).toBe('l');
  });

  it('returns nulls for unparseable input instead of guessing', () => {
    expect(parseQuantity('to taste')).toEqual({ quantity: null, unit: null });
    expect(parseQuantity('')).toEqual({ quantity: null, unit: null });
    expect(parseQuantity(null)).toEqual({ quantity: null, unit: null });
    expect(parseQuantity(undefined)).toEqual({ quantity: null, unit: null });
  });

  it('returns a null unit for a quantity with no recognisable unit', () => {
    expect(parseQuantity('3')).toEqual({ quantity: 3, unit: null });
    expect(parseQuantity('2 bananas')).toEqual({ quantity: 2, unit: null });
  });

  it('rounds to three decimals to avoid float noise', () => {
    const parsed = parseQuantity('1/3 cup');
    expect(parsed.quantity).toBe(0.333);
  });
});

describe('normalizeUnit', () => {
  it('maps aliases to canonical spellings', () => {
    expect(normalizeUnit('grams')).toBe('g');
    expect(normalizeUnit('tablespoon')).toBe('tbsp');
    expect(normalizeUnit('pcs')).toBe('pieces');
    expect(normalizeUnit('litre')).toBe('l');
  });

  it('is case and whitespace insensitive', () => {
    expect(normalizeUnit('  KG ')).toBe('kg');
  });

  it('returns null for unknown and empty units', () => {
    // Unlike the server helper, the client must not invent a unit — an unknown
    // one is dropped so the server can apply its own default.
    expect(normalizeUnit('punnet')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
  });
});

describe('toNumber', () => {
  it('passes finite numbers through', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(-3.5)).toBe(-3.5);
  });

  it('coerces numeric strings and strips stray characters', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber('$18.40')).toBe(18.4);
    expect(toNumber('  7 kg')).toBe(7);
  });

  it('falls back for junk', () => {
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber('abc', 0)).toBe(0);
  });
});

describe('parseIsoDate / toLocalIsoDate', () => {
  it('round-trips a date', () => {
    const date = parseIsoDate('2026-10-15');
    expect(date).not.toBeNull();
    expect(toLocalIsoDate(date!)).toBe('2026-10-15');
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parseIsoDate('garbage')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });

  it('accepts a full timestamp', () => {
    expect(parseIsoDate('2026-10-15T18:30:00Z')).not.toBeNull();
  });
});
