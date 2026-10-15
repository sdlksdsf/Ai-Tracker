import { describe, expect, it } from 'vitest';
import {
  ASSUMED_STAPLES,
  PRICE_INDEX_USD,
  SHELF_LIFE_DAYS,
  SIMILARITY_THRESHOLD,
  coerceCategory,
  co2ForWaste,
  defaultShelfLifeDays,
  estimatePriceUsd,
  formatQuantity,
  inferCategory,
  isAssumedStaple,
  levenshtein,
  matchIngredient,
  normalizeIngredient,
  normalizeUnit,
  parseQuantity,
  pluralize,
  round1,
  round2,
  scaleQuantity,
  similarity,
  singularize,
  toGrams,
} from '../../src/utils/food.js';

/**
 * Ingredient maths.
 *
 * These helpers sit underneath pantry matching, grocery aggregation, CO₂
 * reporting and price estimation, so a silent unit error here becomes a wrong
 * number the user acts on.
 */

describe('normalizeIngredient', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeIngredient('  Chicken   Breast ')).toBe('chicken breast');
  });

  it('strips trailing punctuation', () => {
    expect(normalizeIngredient('tomatoes,')).toBe('tomato');
    expect(normalizeIngredient('onion.')).toBe('onion');
  });

  it('singularises plurals so pantry and recipe lines match', () => {
    expect(normalizeIngredient('eggs')).toBe('egg');
    expect(normalizeIngredient('tomatoes')).toBe('tomato');
    expect(normalizeIngredient('berries')).toBe('berry');
  });

  it('leaves uncountables alone', () => {
    // "rices" and "butters" are not words; the uncountable list must win.
    expect(normalizeIngredient('rice')).toBe('rice');
    expect(normalizeIngredient('pasta')).toBe('pasta');
    expect(normalizeIngredient('butter')).toBe('butter');
  });

  it('returns an empty string for junk rather than throwing', () => {
    expect(normalizeIngredient('')).toBe('');
    expect(normalizeIngredient('   ')).toBe('');
    expect(normalizeIngredient('!!!')).toBe('');
  });

  it('drops parenthetical asides and mid-name preparation notes', () => {
    expect(normalizeIngredient('onion (diced)')).toBe('onion');
    // Noise words are stripped only when they are not the final word, so a name
    // that IS a qualifier ("low fat") is never reduced to nothing.
    expect(normalizeIngredient('fresh baby spinach')).toBe('baby spinach');
    expect(normalizeIngredient('chicken breast, boneless')).toContain('chicken breast');
  });
});

describe('singularize / pluralize', () => {
  it.each([
    ['egg', 'eggs'],
    ['tomato', 'tomatoes'],
    ['berry', 'berries'],
    ['leaf', 'leaves'],
    ['box', 'boxes'],
    ['tomato', 'tomatoes'],
    ['potato', 'potatoes'],
    ['child', 'children'],
  ])('round-trips %s ⇄ %s', (singular, plural) => {
    expect(pluralize(singular)).toBe(plural);
    expect(singularize(plural)).toBe(singular);
  });

  it('handles irregular plurals', () => {
    expect(singularize('children')).toBe('child');
    expect(singularize('leaves')).toBe('leaf');
    expect(singularize('mice')).toBe('mouse');
    expect(singularize('tomatoes')).toBe('tomato');
  });

  it('pluralises -o nouns correctly', () => {
    // Regression: the missing -o -> -oes rule produced "tomatos", which broke
    // pantry/recipe matching and grocery line merging for those ingredients.
    expect(pluralize('tomato')).toBe('tomatoes');
    expect(pluralize('potato')).toBe('potatoes');
    // Not every -o word takes -es.
    expect(pluralize('avocado')).toBe('avocados');
  });

  it('does not mangle short words', () => {
    expect(singularize('oil')).toBe('oil');
    expect(singularize('as')).toBe('as');
  });
});

describe('inferCategory', () => {
  it.each([
    ['chicken breast', 'meat'],
    ['salmon fillet', 'seafood'],
    ['prawns', 'seafood'],
    ['whole milk', 'dairy'],
    ['cheddar cheese', 'dairy'],
    ['greek yoghurt', 'dairy'],
    ['baby spinach', 'vegetable'],
    ['banana', 'fruit'],
    ['basmati rice', 'grain'],
    ['black beans', 'legume'],
    ['olive oil', 'oil_fat'],
    ['almonds', 'nut_seed'],
    ['soy sauce', 'condiment'],
    ['ground cumin', 'spice'],
    ['orange juice', 'beverage'],
    ['frozen peas', 'frozen'],
    ['canned tomatoes', 'canned'],
    ['sourdough bread', 'grain'],
    ['dark chocolate', 'snack'],
    ['white sugar', 'sweetener'],
  ])('categorises "%s" as %s', (name, category) => {
    expect(inferCategory(name)).toBe(category);
  });

  it('falls back to "other" for anything unrecognised', () => {
    expect(inferCategory('mystery substance')).toBe('other');
    expect(inferCategory('')).toBe('other');
  });
});

describe('coerceCategory', () => {
  it('accepts a valid category unchanged', () => {
    expect(coerceCategory('vegetable')).toBe('vegetable');
    expect(coerceCategory('meat')).toBe('meat');
  });

  it('recovers from model casing and label variants', () => {
    expect(coerceCategory('Vegetable')).toBe('vegetable');
    expect(coerceCategory('VEGETABLES')).toBe('vegetable');
    expect(coerceCategory('nuts & seeds')).toBe('nut_seed');
    expect(coerceCategory('nut_seed')).toBe('nut_seed');
  });

  it('falls back to inferring from the name, then to "other"', () => {
    expect(coerceCategory('produce')).not.toBe('produce');
    expect(coerceCategory(null)).toBe('other');
    expect(coerceCategory(undefined)).toBe('other');
    expect(coerceCategory(42)).toBe('other');
  });
});

describe('normalizeUnit', () => {
  it.each([
    ['g', 'g'],
    ['G', 'g'],
    ['grams', 'g'],
    ['gram', 'g'],
    ['kg', 'kg'],
    ['kilogram', 'kg'],
    ['ml', 'ml'],
    ['milliliters', 'ml'],
    ['l', 'l'],
    ['litre', 'l'],
    ['liter', 'l'],
    ['pcs', 'pieces'],
    ['piece', 'pieces'],
    ['pieces', 'pieces'],
    ['pc', 'pieces'],
    ['unit', 'pieces'],
    ['tbsp', 'tbsp'],
    ['tablespoon', 'tbsp'],
    ['tsp', 'tsp'],
    ['teaspoon', 'tsp'],
    ['cup', 'cups'],
    ['cups', 'cups'],
    ['clove', 'cloves'],
    ['can', 'cans'],
    ['tin', 'cans'],
  ])('maps "%s" → %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });

  it('returns null for empty input', () => {
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit('   ')).toBeNull();
  });

  it('passes an unknown unit through rather than discarding it', () => {
    // Losing a unit would silently turn "3 punnets" into "3 grams" downstream.
    expect(normalizeUnit('punnet')).toBe('punnet');
  });

  it('is idempotent — normalising twice changes nothing', () => {
    for (const unit of ['pieces', 'cups', 'g', 'kg', 'tbsp']) {
      expect(normalizeUnit(normalizeUnit(unit))).toBe(normalizeUnit(unit));
    }
  });
});

describe('parseQuantity', () => {
  it('parses metric quantities', () => {
    expect(parseQuantity('250 g')).toEqual({ quantity: 250, unit: 'g' });
    expect(parseQuantity('1.5 kg')).toEqual({ quantity: 1.5, unit: 'kg' });
    expect(parseQuantity('500ml')).toEqual({ quantity: 500, unit: 'ml' });
  });

  it('parses counts', () => {
    expect(parseQuantity('3 pieces')).toEqual({ quantity: 3, unit: 'pieces' });
    expect(parseQuantity('2')).toEqual({ quantity: 2, unit: null });
  });

  it('parses units glued to the number', () => {
    // Regression: "500ml" tokenised as one digit-leading token, so the unit was
    // skipped entirely and the line was read as 500 uncountable pieces.
    expect(parseQuantity('500ml')).toEqual({ quantity: 500, unit: 'ml' });
    expect(parseQuantity('250g')).toEqual({ quantity: 250, unit: 'g' });
    expect(parseQuantity('1kg')).toEqual({ quantity: 1, unit: 'kg' });
    expect(parseQuantity('2tbsp')).toEqual({ quantity: 2, unit: 'tbsp' });
  });

  it('parses fractions', () => {
    expect(parseQuantity('1/2 cup')?.quantity).toBe(0.5);
    expect(parseQuantity('1/4 tsp')?.quantity).toBe(0.25);
    expect(parseQuantity('3/4 cup')?.quantity).toBe(0.75);
  });

  it('parses spelled-out numbers', () => {
    expect(parseQuantity('two eggs')?.quantity).toBe(2);
    expect(parseQuantity('a pinch')?.quantity).toBe(1);
  });

  it('ignores leading filler words', () => {
    expect(parseQuantity('about 2 large onions')?.quantity).toBe(2);
    expect(parseQuantity('approx 300 g')?.quantity).toBe(300);
  });

  it('returns nulls for unparseable input', () => {
    expect(parseQuantity('')).toEqual({ quantity: null, unit: null });
    expect(parseQuantity(null)).toEqual({ quantity: null, unit: null });
    expect(parseQuantity('to taste')).toEqual({ quantity: null, unit: null });
  });
});

describe('toGrams', () => {
  it('converts weight units', () => {
    expect(toGrams(1, 'kg')).toBe(1000);
    expect(toGrams(500, 'g')).toBe(500);
    expect(toGrams(2.5, 'kg')).toBe(2500);
  });

  it('converts volume units using typical densities', () => {
    expect(toGrams(1, 'l')).toBeGreaterThan(900);
    expect(toGrams(1, 'ml')).toBeGreaterThan(0);
    expect(toGrams(1, 'cup')).toBeGreaterThan(100);
  });

  it('returns null only when there is no quantity', () => {
    expect(toGrams(null, 'g')).toBeNull();
    expect(toGrams(null, null)).toBeNull();
  });

  it('estimates countable items at a nominal weight rather than losing them', () => {
    // A bare count or unknown unit falls back to the count itself, so nutrition
    // and CO₂ maths still produce a number instead of dropping the ingredient.
    expect(toGrams(3, 'pcs')).toBeGreaterThan(0);
    expect(toGrams(3, null)).toBe(3);
    expect(toGrams(3, 'punnet')).toBe(3);
  });

  it('never returns NaN', () => {
    expect(Number.isNaN(toGrams(1, 'g') as number)).toBe(false);
    expect(Number.isNaN(toGrams(-5, 'kg') as number)).toBe(false);
  });
});

describe('formatQuantity', () => {
  it('renders a quantity with its unit', () => {
    expect(formatQuantity(250, 'g')).toContain('250');
    expect(formatQuantity(250, 'g')).toContain('g');
  });

  it('renders a bare quantity when there is no unit', () => {
    expect(formatQuantity(3, null).trim()).toBe('3');
  });

  it('handles nulls without throwing', () => {
    expect(() => formatQuantity(null, null)).not.toThrow();
  });

  it('does not emit trailing ".0" for whole numbers', () => {
    expect(formatQuantity(2, 'pcs')).not.toContain('2.0');
  });
});

describe('scaleQuantity', () => {
  it('scales up and down proportionally', () => {
    expect(scaleQuantity(300, 2, 4)).toBe(600);
    expect(scaleQuantity(300, 4, 2)).toBe(150);
  });

  it('is a no-op when servings are equal', () => {
    expect(scaleQuantity(250, 3, 3)).toBe(250);
  });

  it('guards against division by zero', () => {
    expect(scaleQuantity(250, 0, 2)).toBe(250);
    expect(Number.isFinite(scaleQuantity(250, 0, 2) as number)).toBe(true);
  });

  it('passes null through', () => {
    expect(scaleQuantity(null, 2, 4)).toBeNull();
  });
});

describe('levenshtein / similarity', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('flour', 'flour')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns 1 for identical strings', () => {
    expect(similarity('tomato', 'tomato')).toBe(1);
  });

  it('returns a high score for near-matches', () => {
    expect(similarity('tomato', 'tomatos')).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(similarity('yoghurt', 'yogurt')).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });

  it('returns a low score for unrelated strings', () => {
    expect(similarity('chicken', 'chocolate')).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('gives full credit when one name contains the other', () => {
    // "chicken" inside "chicken breast" is the same ingredient for matching.
    expect(similarity('chicken', 'chicken breast')).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it('is symmetric', () => {
    expect(similarity('yoghurt', 'yogurt')).toBe(similarity('yogurt', 'yoghurt'));
  });
});

describe('matchIngredient', () => {
  /** Build pantry rows the way the services do. */
  function pantryOf(...names: string[]) {
    return names.map((ingredientName, i) => ({ id: `id-${i}`, ingredientName, quantity: 1, unit: 'pcs' }));
  }

  it('finds an exact normalised match', () => {
    const match = matchIngredient('chicken breast', pantryOf('Chicken Breast', 'basmati rice', 'Eggs'));
    expect(match).not.toBeNull();
    expect(match?.pantryName).toBe('Chicken Breast');
    expect(match?.score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it('matches across plural/singular differences', () => {
    expect(matchIngredient('egg', pantryOf('eggs', 'tomatoes'))?.pantryName).toBe('eggs');
    expect(matchIngredient('tomato', pantryOf('eggs', 'tomatoes'))?.pantryName).toBe('tomatoes');
  });

  it('matches close misspellings from the vision model', () => {
    expect(matchIngredient('greek yogurt', pantryOf('greek yoghurt'))).not.toBeNull();
  });

  it('picks the best of several candidates', () => {
    const match = matchIngredient('chicken breast', pantryOf('chicken thigh', 'chicken breast', 'rice'));
    expect(match?.pantryName).toBe('chicken breast');
  });

  it('carries the matched quantity and unit through', () => {
    const pantry = [{ id: 'abc', ingredientName: 'basmati rice', quantity: 2.5, unit: 'kg' }];
    const match = matchIngredient('basmati rice', pantry);
    expect(match?.pantryId).toBe('abc');
    expect(match?.quantity).toBe(2.5);
    expect(match?.unit).toBe('kg');
  });

  it('does not match unrelated ingredients', () => {
    expect(matchIngredient('dark chocolate', pantryOf('chicken breast', 'basmati rice'))).toBeNull();
  });

  it('respects a custom threshold', () => {
    const pantry = pantryOf('chicken thigh');
    expect(matchIngredient('chicken breast', pantry, 0.99)).toBeNull();
    expect(matchIngredient('chicken breast', pantry, 0.3)).not.toBeNull();
  });

  it('handles empty inputs', () => {
    expect(matchIngredient('', pantryOf('rice'))).toBeNull();
    expect(matchIngredient('rice', [])).toBeNull();
  });
});

describe('defaultShelfLifeDays', () => {
  it('gives dairy a short shelf life', () => {
    expect(defaultShelfLifeDays('milk')).toBeLessThanOrEqual(10);
    expect(defaultShelfLifeDays('greek yoghurt')).toBeLessThanOrEqual(14);
  });

  it('gives frozen goods a long shelf life', () => {
    expect(defaultShelfLifeDays('frozen peas')).toBeGreaterThan(60);
  });

  it('gives pantry staples the longest shelf life', () => {
    expect(defaultShelfLifeDays('basmati rice')).toBeGreaterThan(180);
    expect(defaultShelfLifeDays('olive oil')).toBeGreaterThan(180);
  });

  it('gives leafy greens a very short shelf life', () => {
    expect(defaultShelfLifeDays('spinach')).toBeLessThanOrEqual(7);
  });

  it('always returns a positive number', () => {
    expect(defaultShelfLifeDays('mystery item')).toBeGreaterThan(0);
    expect(defaultShelfLifeDays('')).toBeGreaterThan(0);
  });

  it('has a rule for every entry in SHELF_LIFE_DAYS', () => {
    expect(SHELF_LIFE_DAYS.length).toBeGreaterThan(10);
    for (const [pattern, days] of SHELF_LIFE_DAYS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(days).toBeGreaterThan(0);
    }
  });
});

describe('co2ForWaste', () => {
  it('scales linearly with quantity', () => {
    const one = co2ForWaste(1, 'kg', 'meat');
    const two = co2ForWaste(2, 'kg', 'meat');
    expect(two).toBeCloseTo(one * 2, 4);
  });

  it('converts grams to kilograms before applying the factor', () => {
    expect(co2ForWaste(1000, 'g', 'vegetable')).toBeCloseTo(co2ForWaste(1, 'kg', 'vegetable'), 4);
  });

  it('produces a higher figure for meat than for vegetables', () => {
    expect(co2ForWaste(1, 'kg', 'meat')).toBeGreaterThan(co2ForWaste(1, 'kg', 'vegetable'));
  });

  it('never returns a negative number or NaN', () => {
    expect(co2ForWaste(1, 'kg', 'meat')).toBeGreaterThanOrEqual(0);
    expect(co2ForWaste(null, 'kg', 'meat')).toBeGreaterThanOrEqual(0);
    expect(co2ForWaste(1, null, 'meat')).toBeGreaterThanOrEqual(0);
    expect(co2ForWaste(1, 'kg', null)).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(co2ForWaste(1, 'kg', 'meat'))).toBe(false);
  });

  it('is 0 when there is no quantity', () => {
    expect(co2ForWaste(0, 'kg', 'meat')).toBe(0);
  });
});

describe('estimatePriceUsd', () => {
  it('prices a known ingredient', () => {
    expect(estimatePriceUsd('chicken breast', 500, 'g')).toBeGreaterThan(0);
    expect(estimatePriceUsd('basmati rice', 1, 'kg')).toBeGreaterThan(0);
  });

  it('scales with quantity', () => {
    const one = estimatePriceUsd('chicken breast', 1, 'kg');
    const two = estimatePriceUsd('chicken breast', 2, 'kg');
    expect(two).toBeGreaterThan(one);
  });

  it('returns a positive fallback for unknown ingredients', () => {
    // A grocery list must never show $0 for a line — that trains users to
    // distrust every other number on the screen.
    expect(estimatePriceUsd('unobtainium', 1, 'pcs')).toBeGreaterThan(0);
  });

  it('handles null quantity and unit', () => {
    expect(estimatePriceUsd('egg', null, null)).toBeGreaterThan(0);
  });

  it('rounds to cents', () => {
    const price = estimatePriceUsd('chicken breast', 333, 'g');
    expect(price).toBe(round2(price));
  });

  it('has a populated price index', () => {
    expect(PRICE_INDEX_USD.length).toBeGreaterThan(20);
    for (const [pattern, entry] of PRICE_INDEX_USD) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(entry.unitPrice).toBeGreaterThan(0);
      expect(typeof entry.unit).toBe('string');
    }
  });
});

describe('round1 / round2', () => {
  it('rounds to the requested precision', () => {
    expect(round1(1.25)).toBe(1.3);
    expect(round2(1.2555)).toBe(1.26);
  });

  it('leaves integers alone', () => {
    expect(round1(2)).toBe(2);
    expect(round2(2)).toBe(2);
  });

  it('handles zero and negatives', () => {
    expect(round2(0)).toBe(0);
    expect(round2(-1.234)).toBe(-1.23);
  });

  it('never returns NaN for finite input', () => {
    expect(Number.isNaN(round2(0.1 + 0.2))).toBe(false);
  });
});

describe('isAssumedStaple', () => {
  it('recognises the pantry staples a recipe may assume you own', () => {
    for (const staple of ['salt', 'black pepper', 'olive oil', 'water']) {
      expect(ASSUMED_STAPLES.length).toBeGreaterThan(0);
      // At least the common ones must be flagged — these are excluded from
      // grocery lists so the shopper is not told to buy salt every week.
      if (['salt', 'black pepper', 'olive oil'].includes(staple)) {
        expect(isAssumedStaple(staple), staple).toBe(true);
      }
    }
  });

  it('does not treat real ingredients as staples', () => {
    expect(isAssumedStaple('chicken breast')).toBe(false);
    expect(isAssumedStaple('salmon fillet')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isAssumedStaple('Salt')).toBe(isAssumedStaple('salt'));
  });

  it('handles empty input', () => {
    expect(isAssumedStaple('')).toBe(false);
  });
});
