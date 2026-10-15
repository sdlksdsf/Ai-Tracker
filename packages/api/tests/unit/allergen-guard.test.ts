import { describe, expect, it } from 'vitest';
import { auditRecipe, findViolation, guardBatch, sanitizeRecipe, type GuardContext } from '../../src/services/ai/allergen-guard.js';
import { makeHiddenAllergenRecipe, makePeanutRecipe, makeRecipe, makeVeganViolationRecipe, ingredient } from './fixtures.js';

/**
 * Allergen guard — the safety-critical module in the whole codebase.
 *
 * A false negative here can hospitalise someone. These tests exist to prove the
 * guard over-blocks rather than under-blocks, and that a violation anywhere in a
 * recipe (ingredients, steps, or the title) disqualifies the whole recipe
 * instead of being silently edited out.
 */

const peanutContext: GuardContext = {
  allergies: [{ allergen: 'peanuts', severity: 'severe' }],
  dietaryPreference: 'none',
  avoid: [],
};

describe('findViolation', () => {
  it('flags a declared allergen by exact name', () => {
    const violation = findViolation('peanuts', peanutContext);
    expect(violation).not.toBeNull();
    expect(violation?.kind).toBe('allergen');
    expect(violation?.allergen).toBe('peanuts');
    expect(violation?.severity).toBe('severe');
  });

  it('flags derived ingredients, not just the raw allergen', () => {
    // "peanut butter" and "peanut oil" are not the string "peanuts" — the guard
    // must still catch them via the keyword table.
    for (const name of ['peanut butter', 'peanut oil', 'roasted peanuts', 'groundnut']) {
      expect(findViolation(name, peanutContext), name).not.toBeNull();
    }
  });

  it('is case and punctuation insensitive', () => {
    expect(findViolation('Peanuts', peanutContext)).not.toBeNull();
    expect(findViolation('  PEANUTS  ', peanutContext)).not.toBeNull();
  });

  it('returns null for safe ingredients', () => {
    for (const name of ['chicken breast', 'basmati rice', 'spinach', 'olive oil']) {
      expect(findViolation(name, peanutContext), name).toBeNull();
    }
  });

  it('returns null for an empty name', () => {
    expect(findViolation('', peanutContext)).toBeNull();
    expect(findViolation('   ', peanutContext)).toBeNull();
  });

  it('honours the user avoid-list separately from allergies', () => {
    const context: GuardContext = { allergies: [], dietaryPreference: 'none', avoid: ['coriander'] };
    const violation = findViolation('fresh coriander', context);
    expect(violation).not.toBeNull();
    expect(violation?.kind).toBe('avoid');
  });

  it('enforces dietary exclusions (vegan rejects dairy and meat)', () => {
    const vegan: GuardContext = { allergies: [], dietaryPreference: 'vegan', avoid: [] };

    for (const name of ['parmesan cheese', 'double cream', 'chicken breast', 'honey']) {
      const violation = findViolation(name, vegan);
      expect(violation, name).not.toBeNull();
      expect(violation?.kind).toBe('diet');
    }

    expect(findViolation('firm tofu', vegan)).toBeNull();
    expect(findViolation('chickpeas', vegan)).toBeNull();
  });

  it('allows dairy for a vegetarian', () => {
    const vegetarian: GuardContext = { allergies: [], dietaryPreference: 'vegetarian', avoid: [] };
    expect(findViolation('greek yoghurt', vegetarian)).toBeNull();
    expect(findViolation('cheddar cheese', vegetarian)).toBeNull();
    expect(findViolation('chicken breast', vegetarian)).not.toBeNull();
  });
});

describe('auditRecipe', () => {
  it('passes a clean recipe', () => {
    const report = auditRecipe(makeRecipe(), peanutContext);
    expect(report.safe).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('rejects a recipe with an allergen in the ingredient list', () => {
    const report = auditRecipe(makePeanutRecipe(), peanutContext);
    expect(report.safe).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(2);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('catches an allergen hidden inside a cooking step', () => {
    // "Fry in peanut oil" appears only in step 2 — an ingredients-only check
    // would let this through.
    const report = auditRecipe(makeHiddenAllergenRecipe(), peanutContext);
    expect(report.safe).toBe(false);
    expect(report.violations.some((v) => v.ingredient.startsWith('step:'))).toBe(true);
  });

  it('catches an allergen named in the title', () => {
    const report = auditRecipe(makePeanutRecipe(), peanutContext);
    expect(report.safe).toBe(false);
  });

  it('reports dietary violations for a vegan', () => {
    const vegan: GuardContext = { allergies: [], dietaryPreference: 'vegan', avoid: [] };
    const report = auditRecipe(makeVeganViolationRecipe(), vegan);
    expect(report.safe).toBe(false);
    expect(report.violations.every((v) => v.kind === 'diet')).toBe(true);
  });

  it('audits optional ingredients too — optional is not the same as absent', () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient('chicken breast'),
        ingredient('crushed peanuts', { is_optional: true }),
      ],
    });
    expect(auditRecipe(recipe, peanutContext).safe).toBe(false);
  });

  it('audits substitutes — an unsafe swap is still unsafe', () => {
    const recipe = makeRecipe({
      ingredients: [ingredient('sunflower seed butter', { substitutes: ['peanut butter'] })],
    });
    expect(auditRecipe(recipe, peanutContext).safe).toBe(false);
  });
});

describe('sanitizeRecipe', () => {
  it('returns the recipe untouched when it is safe', () => {
    const recipe = makeRecipe();
    const result = sanitizeRecipe(recipe, peanutContext);
    expect(result.rejected).toBe(false);
    expect(result.recipe).toBe(recipe);
    expect(result.removed).toHaveLength(0);
  });

  it('rejects the whole recipe rather than deleting the allergen', () => {
    const result = sanitizeRecipe(makePeanutRecipe(), peanutContext);
    expect(result.rejected).toBe(true);
    expect(result.recipe).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('never returns a recipe that still contains the violation', () => {
    const result = sanitizeRecipe(makePeanutRecipe(), peanutContext);
    // A rejected recipe must not leak a partially-edited version downstream.
    expect(result.recipe).toBeNull();
  });
});

describe('guardBatch', () => {
  it('keeps safe recipes and drops unsafe ones', () => {
    const { recipes, notes } = guardBatch(
      [makeRecipe({ title: 'Safe One' }), makePeanutRecipe(), makeRecipe({ title: 'Safe Two' })],
      peanutContext,
    );

    expect(recipes).toHaveLength(2);
    expect(recipes.map((r) => r.title).sort()).toEqual(['Safe One', 'Safe Two']);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(' ')).toMatch(/peanut/i);
  });

  it('returns an empty batch when everything is unsafe', () => {
    const { recipes } = guardBatch([makePeanutRecipe(), makePeanutRecipe()], peanutContext);
    expect(recipes).toHaveLength(0);
  });

  it('handles an empty batch without throwing', () => {
    const { recipes, notes } = guardBatch([], peanutContext);
    expect(recipes).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it('explains every rejection in the notes so the UI can tell the user why', () => {
    const { notes } = guardBatch([makePeanutRecipe(), makeVeganViolationRecipe()], {
      allergies: [{ allergen: 'peanuts', severity: 'severe' }],
      dietaryPreference: 'vegan',
      avoid: [],
    });

    expect(notes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('multiple simultaneous restrictions', () => {
  const context: GuardContext = {
    allergies: [
      { allergen: 'peanuts', severity: 'severe' },
      { allergen: 'shellfish', severity: 'moderate' },
    ],
    dietaryPreference: 'vegetarian',
    avoid: ['mushrooms'],
  };

  it('flags every offending ingredient in one recipe', () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient('prawns', { category: 'seafood' }),
        ingredient('portobello mushrooms'),
        ingredient('basmati rice'),
      ],
    });

    const report = auditRecipe(recipe, context);
    expect(report.safe).toBe(false);

    const offending = report.violations.map((v) => v.ingredient);
    expect(offending).toContain('prawns');
    expect(offending).toContain('portobello mushrooms');
    // Rice is safe and must not be flagged — over-blocking has to stay targeted.
    expect(offending).not.toContain('basmati rice');
  });

  it('ranks an allergen above a dietary violation for the same ingredient', () => {
    // Prawns are both a declared shellfish allergy AND non-vegetarian. Only one
    // violation is reported per ingredient, and it must be the more dangerous
    // one so the UI shows "Contains shellfish" rather than "Not vegetarian".
    const violation = findViolation('prawns', context);
    expect(violation?.kind).toBe('allergen');
    expect(violation?.allergen).toBe('shellfish');
  });

  it('still reports the dietary violation when no allergy applies', () => {
    const vegetarianOnly: GuardContext = { allergies: [], dietaryPreference: 'vegetarian', avoid: [] };
    expect(findViolation('prawns', vegetarianOnly)?.kind).toBe('diet');
  });

  it('reports the avoid-list violation when neither allergy nor diet applies', () => {
    const avoidOnly: GuardContext = { allergies: [], dietaryPreference: 'none', avoid: ['mushrooms'] };
    expect(findViolation('portobello mushrooms', avoidOnly)?.kind).toBe('avoid');
  });
});

describe('allergen keyword families are actually consulted', () => {
  // Regression guard: the family table is keyed by the plural display form
  // ("peanuts"), while ingredient names are singularised before lookup. A
  // mismatch silently dropped every derived-ingredient keyword, so "groundnut
  // oil" passed for a user with a declared peanut allergy.
  const cases: Array<[allergen: string, ingredient: string]> = [
    ['peanuts', 'groundnut oil'],
    ['peanuts', 'arachis hypogaea'],
    ['peanuts', 'monkey nuts'],
    ['peanuts', 'beer nuts'],
    ['tree nuts', 'marzipan'],
    ['tree nuts', 'praline'],
    ['tree nuts', 'frangipane'],
    ['milk', 'ghee'],
    ['milk', 'casein'],
    ['milk', 'whey powder'],
    ['shellfish', 'calamari'],
    ['shellfish', 'crayfish'],
    ['gluten', 'seitan'],
  ];

  it.each(cases)('blocks %s for an ingredient of "%s"', (allergen, name) => {
    const violation = findViolation(name, { allergies: [{ allergen, severity: 'severe' }], dietaryPreference: 'none', avoid: [] });
    expect(violation, `${name} should trip the "${allergen}" allergy`).not.toBeNull();
    expect(violation?.kind).toBe('allergen');
  });

  it('protects a user who declares the synonym instead of the canonical name', () => {
    // Reverse direction: someone who types "groundnut" must still be protected
    // from "peanut butter".
    const violation = findViolation('peanut butter', {
      allergies: [{ allergen: 'groundnut', severity: 'severe' }],
      dietaryPreference: 'none',
      avoid: [],
    });
    expect(violation).not.toBeNull();
    expect(violation?.kind).toBe('allergen');
  });

  it('does not over-block unrelated ingredients', () => {
    const ctx: GuardContext = { allergies: [{ allergen: 'peanuts', severity: 'severe' }], dietaryPreference: 'none', avoid: [] };
    for (const name of ['green peas', 'snap peas', 'pea shoots', 'chickpeas', 'peanut butter'] .slice(0, 4)) {
      expect(findViolation(name, ctx), name).toBeNull();
    }
  });
});
