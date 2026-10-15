import type { AiRecipe, AiRecipeIngredient } from '../../src/services/ai/types.js';

/**
 * Test fixtures.
 *
 * Every test that needs an `AiRecipe` builds it here, so a change to the AI
 * output contract breaks one file rather than twenty.
 */

export function ingredient(name: string, overrides: Partial<AiRecipeIngredient> = {}): AiRecipeIngredient {
  return {
    name,
    quantity: 1,
    unit: 'pcs',
    category: 'other',
    is_in_pantry: false,
    is_optional: false,
    substitutes: [],
    ...overrides,
  };
}

export function makeRecipe(overrides: Partial<AiRecipe> = {}): AiRecipe {
  return {
    title: 'Test Recipe',
    description: 'A recipe used only by tests.',
    cuisine: 'Mediterranean',
    meal_type: 'dinner',
    difficulty: 'easy',
    prep_time_min: 10,
    cook_time_min: 20,
    total_time_min: 30,
    servings: 2,
    tags: ['quick'],
    ingredients: [ingredient('chicken breast', { quantity: 300, unit: 'g', category: 'meat' })],
    steps: [
      { step_number: 1, instruction: 'Season the chicken.', duration_min: 5, tip: null },
      { step_number: 2, instruction: 'Pan-fry until golden.', duration_min: 15, tip: 'Do not crowd the pan.' },
    ],
    estimated_nutrition_per_serving: {
      calories: 420,
      protein_g: 38,
      carbs_g: 12,
      fat_g: 22,
      fiber_g: 3,
      sodium_mg: 480,
    },
    allergen_warnings: [],
    storage_instructions: 'Refrigerate in a sealed container for up to 3 days.',
    reheating_instructions: 'Reheat gently in a pan with a splash of water.',
    ...overrides,
  };
}

/** A recipe that must never pass the allergen guard. */
export function makePeanutRecipe(): AiRecipe {
  return makeRecipe({
    title: 'Peanut Satay Bowls',
    ingredients: [
      ingredient('rice noodles', { quantity: 200, unit: 'g', category: 'grain' }),
      ingredient('peanut butter', { quantity: 3, unit: 'tbsp', category: 'nut_seed' }),
      ingredient('roasted peanuts', { quantity: 50, unit: 'g', category: 'nut_seed' }),
    ],
    steps: [
      { step_number: 1, instruction: 'Cook the noodles.', duration_min: 8, tip: null },
      { step_number: 2, instruction: 'Whisk the peanut butter with lime.', duration_min: 4, tip: null },
    ],
  });
}

/** A recipe that hides an allergen inside an instruction rather than a line item. */
export function makeHiddenAllergenRecipe(): AiRecipe {
  return makeRecipe({
    title: 'Crispy Tofu Stir Fry',
    ingredients: [ingredient('firm tofu', { quantity: 400, unit: 'g', category: 'legume' })],
    steps: [
      { step_number: 1, instruction: 'Press the tofu for ten minutes.', duration_min: 10, tip: null },
      // The allergen only appears here — a naive ingredient-only check misses it.
      { step_number: 2, instruction: 'Fry in peanut oil until crisp.', duration_min: 8, tip: null },
    ],
  });
}

export function makeVeganViolationRecipe(): AiRecipe {
  return makeRecipe({
    title: 'Creamy Parmesan Pasta',
    ingredients: [
      ingredient('spaghetti', { quantity: 200, unit: 'g', category: 'grain' }),
      ingredient('parmesan cheese', { quantity: 60, unit: 'g', category: 'dairy' }),
      ingredient('double cream', { quantity: 200, unit: 'ml', category: 'dairy' }),
    ],
  });
}
