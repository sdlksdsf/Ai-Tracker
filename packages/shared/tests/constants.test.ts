import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LEVELS,
  AI_CONFIDENCE,
  ALLERGEN_INGREDIENT_KEYWORDS,
  ALLERGEN_SEVERITIES,
  CACHE_TTL_SECONDS,
  CALORIE_ADJUSTMENT_BY_GOAL,
  CO2_PER_KG_BY_CATEGORY,
  COMMON_ALLERGENS,
  COOKING_SKILL_LEVELS,
  CUISINES,
  CURRENCIES,
  DAY_NAMES,
  DAY_SHORT_NAMES,
  DAYS_OF_WEEK,
  DIFFICULTY_LEVELS,
  DIETARY_EXCLUSIONS,
  DIETARY_PREFERENCES,
  FRESHNESS_LEVELS,
  HEALTH_GOALS,
  INGREDIENT_CATEGORIES,
  KG_CO2_PER_TREE_PER_YEAR,
  LITRES_WATER_PER_KG_FOOD,
  MACRO_SPLIT_BY_GOAL,
  MEAL_TYPES,
  PLAN_LIMITS,
  RATE_LIMITS,
  SCAN_SOURCES,
  SCAN_STATUSES,
  STORAGE_LOCATIONS,
  SUBSCRIPTION_TIERS,
  TOKEN_TTL,
  UNITS,
  UNIT_TO_GRAMS,
  UPLOAD_LIMITS,
  WASTE_REASONS,
  API_BASE_PATH,
  APP_SCHEME,
} from '../src/constants/index.js';

/**
 * Shared constants.
 *
 * These values are the contract between the API and the mobile app: a plan limit
 * here is enforced server-side AND rendered in the Premium screen's comparison
 * table, and a CO₂ factor here is what turns a waste log into the number a user
 * reads. Silent inconsistency between the two would be invisible at runtime.
 */

describe('subscription tiers and plan limits', () => {
  it('defines exactly the three monetised tiers', () => {
    expect([...SUBSCRIPTION_TIERS].sort()).toEqual(['family', 'free', 'premium']);
  });

  it('has a limit set for every tier', () => {
    for (const tier of SUBSCRIPTION_TIERS) {
      expect(PLAN_LIMITS[tier], `no limits defined for ${tier}`).toBeTruthy();
    }
  });

  it('gives free users a real but bounded quota', () => {
    // These numbers appear verbatim in the Premium screen, so they must be
    // positive integers rather than sentinels.
    expect(PLAN_LIMITS.free.scansPerWeek).toBe(3);
    expect(PLAN_LIMITS.free.recipeGenerationsPerDay).toBe(5);
    expect(PLAN_LIMITS.free.mealPlansPerMonth).toBe(1);
    expect(PLAN_LIMITS.free.maxPantryItems).toBe(50);
  });

  it('removes the caps on paid tiers', () => {
    for (const tier of ['premium', 'family'] as const) {
      expect(PLAN_LIMITS[tier].scansPerWeek).toBe(-1);
      expect(PLAN_LIMITS[tier].recipeGenerationsPerDay).toBe(-1);
      expect(PLAN_LIMITS[tier].mealPlansPerMonth).toBe(-1);
      expect(PLAN_LIMITS[tier].maxPantryItems).toBe(-1);
    }
  });

  it('grants paid features only to paid tiers', () => {
    expect(PLAN_LIMITS.free.priceComparison).toBe(false);
    expect(PLAN_LIMITS.premium.priceComparison).toBe(true);
    expect(PLAN_LIMITS.family.priceComparison).toBe(true);

    expect(PLAN_LIMITS.free.cookingModeVoice).toBe(false);
    expect(PLAN_LIMITS.premium.cookingModeVoice).toBe(true);

    expect(PLAN_LIMITS.free.advancedAnalytics).toBe(false);
    expect(PLAN_LIMITS.premium.advancedAnalytics).toBe(true);
  });

  it('reserves the shared household for Family', () => {
    expect(PLAN_LIMITS.free.sharedHouseholdMembers).toBe(0);
    expect(PLAN_LIMITS.premium.sharedHouseholdMembers).toBe(0);
    expect(PLAN_LIMITS.family.sharedHouseholdMembers).toBeGreaterThan(0);
  });

  it('shows ads only on the free tier', () => {
    // Free is ad-supported; paying removes them. Asserting "no ads anywhere"
    // would contradict the monetisation model the Premium screen sells.
    expect(PLAN_LIMITS.free.ads).toBe(true);
    expect(PLAN_LIMITS.premium.ads).toBe(false);
    expect(PLAN_LIMITS.family.ads).toBe(false);
  });

  it('orders the tiers monotonically — a higher tier never grants less', () => {
    const rank = ['free', 'premium', 'family'] as const;
    const numericKeys = ['scansPerWeek', 'recipeGenerationsPerDay', 'mealPlansPerMonth', 'maxPantryItems', 'sharedHouseholdMembers'] as const;

    // -1 means unlimited, so it must compare as +infinity rather than as "less
    // than 3", which would flag every paid tier as a downgrade.
    const effective = (value: number): number => (value === -1 ? Number.POSITIVE_INFINITY : value);

    for (const key of numericKeys) {
      for (let i = 1; i < rank.length; i += 1) {
        const lower = effective(PLAN_LIMITS[rank[i - 1]!]![key]);
        const higher = effective(PLAN_LIMITS[rank[i]!]![key]);
        expect(higher, `${key}: ${rank[i]} should not grant less than ${rank[i - 1]}`).toBeGreaterThanOrEqual(lower);
      }
    }
  });

  it('uses -1 as the only unlimited sentinel', () => {
    // A limit of 0 would mean "blocked", which is a different thing from
    // "unlimited". Anything negative other than -1 is a typo.
    for (const tier of SUBSCRIPTION_TIERS) {
      for (const value of Object.values(PLAN_LIMITS[tier]!)) {
        if (typeof value === 'number') expect(value).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});

describe('rate limits', () => {
  it('matches the limits documented in the README and OpenAPI', () => {
    expect(RATE_LIMITS.general.max).toBe(100);
    expect(RATE_LIMITS.ai.max).toBe(10);
    expect(RATE_LIMITS.scan.max).toBe(5);
    expect(RATE_LIMITS.auth.max).toBe(10);
  });

  it('rate-limits the expensive endpoints most strictly', () => {
    expect(RATE_LIMITS.scan.max).toBeLessThan(RATE_LIMITS.ai.max);
    expect(RATE_LIMITS.ai.max).toBeLessThan(RATE_LIMITS.general.max);
  });

  it('uses a one-minute window everywhere', () => {
    for (const [key, limit] of Object.entries(RATE_LIMITS)) {
      expect(limit.windowMs, `${key} window`).toBe(60_000);
      expect(Number.isInteger(limit.max), `${key} max should be an integer`).toBe(true);
      expect(limit.max, `${key} max should be positive`).toBeGreaterThan(0);
    }
  });
});

describe('token TTLs', () => {
  it('uses a short-lived access token and a week-long refresh token', () => {
    expect(TOKEN_TTL.accessTokenSeconds).toBe(900);
    expect(TOKEN_TTL.refreshTokenSeconds).toBe(604_800);
  });

  it('keeps the refresh token meaningfully longer than the access token', () => {
    expect(TOKEN_TTL.refreshTokenSeconds).toBeGreaterThan(TOKEN_TTL.accessTokenSeconds * 10);
  });

  it('expires a password-reset token within an hour', () => {
    // Long-lived reset links are a takeover vector; an hour is the norm.
    expect(TOKEN_TTL.resetPasswordTokenSeconds).toBe(3600);
    expect(TOKEN_TTL.resetPasswordTokenSeconds).toBeLessThan(TOKEN_TTL.refreshTokenSeconds);
  });
});

describe('cache TTLs', () => {
  it('caches expensive third-party lookups for a day or more', () => {
    // Grocery prices are quoted to users, so a stale figure is worse than a
    // missing one — but re-querying per keystroke would blow the rate budget.
    expect(CACHE_TTL_SECONDS.groceryPrices).toBe(86_400);
    expect(CACHE_TTL_SECONDS.nutrition).toBe(2_592_000); // 30 days
  });

  it('keeps volatile, personalised caches short', () => {
    expect(CACHE_TTL_SECONDS.userPantry).toBeLessThanOrEqual(600);
    expect(CACHE_TTL_SECONDS.recipeSearch).toBeLessThanOrEqual(600);
    expect(CACHE_TTL_SECONDS.scanDedupe).toBeLessThanOrEqual(600);
  });

  it('dedupes identical AI generations for an hour', () => {
    // The same ingredient combination asked twice in a row should not cost twice.
    expect(CACHE_TTL_SECONDS.recipeGeneration).toBe(3600);
  });

  it('keeps the session cache no longer than the refresh token', () => {
    expect(CACHE_TTL_SECONDS.session).toBeLessThanOrEqual(TOKEN_TTL.refreshTokenSeconds);
  });

  it('has only positive integers', () => {
    for (const [key, value] of Object.entries(CACHE_TTL_SECONDS)) {
      expect(Number.isInteger(value), `${key} should be an integer`).toBe(true);
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });
});

describe('upload limits', () => {
  it('caps an image at 10 MB', () => {
    expect(UPLOAD_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
  });

  it('downscales to a sane model input size', () => {
    // Vision models do not benefit from a 4000px image and charge for the tokens.
    expect(UPLOAD_LIMITS.maxLongestSidePx).toBeLessThanOrEqual(2048);
    expect(UPLOAD_LIMITS.maxLongestSidePx).toBeGreaterThanOrEqual(768);
  });

  it('accepts only real image types', () => {
    expect(UPLOAD_LIMITS.allowedMimeTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(UPLOAD_LIMITS.allowedMimeTypes).not.toContain('application/octet-stream');
  });
});

describe('AI confidence thresholds', () => {
  it('drops low-confidence detections below the accept floor', () => {
    expect(AI_CONFIDENCE.minAccept).toBe(0.65);
  });

  it('triggers the fallback model above the accept floor', () => {
    // The fallback threshold must sit ABOVE minAccept, otherwise a batch that
    // triggers the fallback would already have been accepted as good enough.
    expect(AI_CONFIDENCE.fallbackThreshold).toBeGreaterThan(AI_CONFIDENCE.minAccept);
  });

  it('keeps both inside 0..1', () => {
    for (const value of Object.values(AI_CONFIDENCE)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('ingredient categories', () => {
  it('has a stable, non-empty set', () => {
    expect(INGREDIENT_CATEGORIES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(INGREDIENT_CATEGORIES).size).toBe(INGREDIENT_CATEGORIES.length);
  });

  it('includes "other" so nothing is unrepresentable', () => {
    expect(INGREDIENT_CATEGORIES).toContain('other');
  });

  it('has a CO₂ factor for every category', () => {
    // A missing factor would silently report 0 kg CO₂e for that category, which
    // understates a user's impact rather than failing visibly.
    for (const category of INGREDIENT_CATEGORIES) {
      expect(CO2_PER_KG_BY_CATEGORY[category], `no CO₂ factor for ${category}`).toBeDefined();
      expect(CO2_PER_KG_BY_CATEGORY[category]).toBeGreaterThan(0);
    }
  });

  it('ranks meat above vegetables, as the literature does', () => {
    expect(CO2_PER_KG_BY_CATEGORY.meat!).toBeGreaterThan(CO2_PER_KG_BY_CATEGORY.vegetable!);
    expect(CO2_PER_KG_BY_CATEGORY.seafood!).toBeGreaterThan(CO2_PER_KG_BY_CATEGORY.grain!);
  });
});

describe('unit conversions', () => {
  it('has a gram factor for every weight unit', () => {
    expect(UNIT_TO_GRAMS.g).toBe(1);
    expect(UNIT_TO_GRAMS.kg).toBe(1000);
    expect(UNIT_TO_GRAMS.oz).toBeCloseTo(28.35, 1);
    expect(UNIT_TO_GRAMS.lb).toBeCloseTo(453.6, 0);
  });

  it('has a plausible volume factor', () => {
    // Volumes are converted at ~1 g/ml; anything wildly off would distort every
    // CO₂ and cost figure derived from it.
    expect(UNIT_TO_GRAMS.ml).toBeGreaterThan(0.5);
    expect(UNIT_TO_GRAMS.ml).toBeLessThan(2);
    expect(UNIT_TO_GRAMS.l).toBeCloseTo((UNIT_TO_GRAMS.ml ?? 1) * 1000, 0);
  });

  it('lists every unit it can convert', () => {
    for (const unit of UNITS) {
      // Countable units have no gram factor by design.
      const countable = ['pieces', 'clove', 'cloves', 'slice', 'slices', 'can', 'cans', 'bunch', 'bunches', 'head', 'heads', 'pinch', 'dash', 'handful'];
      if (countable.includes(unit)) continue;
      expect(UNIT_TO_GRAMS[unit], `${unit} has no conversion factor`).toBeDefined();
    }
  });

  it('has only positive factors', () => {
    for (const [unit, grams] of Object.entries(UNIT_TO_GRAMS)) {
      expect(grams, `${unit} factor should be positive`).toBeGreaterThan(0);
      expect(Number.isFinite(grams), `${unit} factor should be finite`).toBe(true);
    }
  });
});

describe('impact constants', () => {
  it('uses the published per-tree carbon figure', () => {
    // A mature tree absorbs roughly 21 kg CO₂ per year.
    expect(KG_CO2_PER_TREE_PER_YEAR).toBe(21);
  });

  it('uses the published water footprint of food', () => {
    expect(LITRES_WATER_PER_KG_FOOD).toBeGreaterThan(500);
    expect(LITRES_WATER_PER_KG_FOOD).toBeLessThan(2000);
  });
});

describe('allergen data', () => {
  it('covers the major regulated allergens', () => {
    for (const allergen of ['peanuts', 'tree nuts', 'milk', 'eggs', 'fish', 'shellfish', 'soy', 'wheat', 'sesame']) {
      expect(COMMON_ALLERGENS, `missing regulated allergen: ${allergen}`).toContain(allergen);
    }
  });

  it('also offers the religious and lifestyle avoidances the UI groups with allergies', () => {
    // These are not IgE allergens, but they are declared the same way and must be
    // enforced the same way — the guard treats all three lists identically.
    for (const avoidance of ['pork', 'beef', 'alcohol', 'caffeine']) {
      expect(COMMON_ALLERGENS, `missing avoidance: ${avoidance}`).toContain(avoidance);
    }
  });

  it('has a non-empty keyword family for every declared allergen', () => {
    // Regression guard: a missing family means the guard falls back to matching
    // only the literal name, so "groundnut oil" would pass a peanut allergy and
    // "corn syrup" would pass a corn allergy. Every entry a user can declare in
    // the onboarding UI must have derived-ingredient coverage.
    for (const allergen of COMMON_ALLERGENS) {
      expect(ALLERGEN_INGREDIENT_KEYWORDS[allergen], `no keyword family for "${allergen}"`).toBeDefined();
      expect(ALLERGEN_INGREDIENT_KEYWORDS[allergen]!.length, `empty family for "${allergen}"`).toBeGreaterThan(0);
    }
  });

  it('covers the hidden forms of corn', () => {
    // Corn appears in processed food far more often than as a visible kernel.
    expect(ALLERGEN_INGREDIENT_KEYWORDS.corn).toEqual(
      expect.arrayContaining(['cornstarch', 'corn syrup', 'maize', 'polenta', 'masa']),
    );
  });

  it('covers the hidden forms of gluten and soy', () => {
    expect(ALLERGEN_INGREDIENT_KEYWORDS.gluten!.length).toBeGreaterThan(1);
    expect(ALLERGEN_INGREDIENT_KEYWORDS.soy!.length).toBeGreaterThan(1);
  });

  it('includes derived ingredients, not just the raw allergen', () => {
    expect(ALLERGEN_INGREDIENT_KEYWORDS.peanuts).toEqual(
      expect.arrayContaining(['peanut', 'groundnut', 'arachis']),
    );
    expect(ALLERGEN_INGREDIENT_KEYWORDS.milk).toEqual(expect.arrayContaining(['butter', 'cheese', 'cream', 'whey', 'casein']));
    expect(ALLERGEN_INGREDIENT_KEYWORDS['tree nuts']).toEqual(expect.arrayContaining(['almond', 'cashew', 'marzipan']));
  });

  it('has severity levels for triage', () => {
    expect(ALLERGEN_SEVERITIES.length).toBeGreaterThanOrEqual(3);
    expect(ALLERGEN_SEVERITIES).toContain('severe');
  });

  it('has exclusion lists for every dietary preference', () => {
    for (const preference of DIETARY_PREFERENCES) {
      expect(DIETARY_EXCLUSIONS[preference], `no exclusions for ${preference}`).toBeDefined();
    }
  });

  it('excludes meat and fish for vegetarians', () => {
    const vegetarian = DIETARY_EXCLUSIONS.vegetarian!;
    for (const excluded of ['beef', 'chicken', 'pork', 'fish', 'prawn']) {
      expect(vegetarian, `vegetarian should exclude ${excluded}`).toContain(excluded);
    }
  });

  it('excludes dairy and egg for vegans, on top of the vegetarian list', () => {
    const vegan = DIETARY_EXCLUSIONS.vegan!;
    for (const excluded of ['milk', 'butter', 'cheese', 'egg', 'honey', 'beef']) {
      expect(vegan, `vegan should exclude ${excluded}`).toContain(excluded);
    }
  });

  it('lets pescatarians eat fish but not meat', () => {
    const pescatarian = DIETARY_EXCLUSIONS.pescatarian!;
    expect(pescatarian).toContain('chicken');
    expect(pescatarian).toContain('beef');
    expect(pescatarian).not.toContain('salmon');
    expect(pescatarian).not.toContain('fish');
  });

  it('excludes pork and alcohol for halal', () => {
    const halal = DIETARY_EXCLUSIONS.halal!;
    expect(halal).toContain('pork');
    expect(halal).toContain('bacon');
    expect(halal).toContain('alcohol');
  });

  it('excludes shellfish for kosher', () => {
    const kosher = DIETARY_EXCLUSIONS.kosher!;
    expect(kosher).toContain('shrimp');
    expect(kosher).toContain('shellfish');
    expect(kosher).toContain('pork');
  });

  it('applies no exclusions for "none"', () => {
    expect(DIETARY_EXCLUSIONS.none).toEqual([]);
  });
});

describe('macro and goal data', () => {
  it('has a macro split for every health goal', () => {
    for (const goal of HEALTH_GOALS) {
      expect(MACRO_SPLIT_BY_GOAL[goal], `no macro split for ${goal}`).toBeDefined();
    }
  });

  it('sums every macro split to exactly 1.0', () => {
    // Splits are energy fractions, not percentages. A split summing to 0.9 would
    // silently under-prescribe 10% of a user's calories.
    for (const [goal, split] of Object.entries(MACRO_SPLIT_BY_GOAL)) {
      const total = split.protein + split.carbs + split.fat;
      expect(Math.abs(total - 1), `${goal} macro split sums to ${total}`).toBeLessThan(1e-9);
    }
  });

  it('keeps protein highest for weight loss, to preserve lean mass in a deficit', () => {
    expect(MACRO_SPLIT_BY_GOAL.lose_weight.protein).toBeGreaterThan(MACRO_SPLIT_BY_GOAL.maintain.protein);
    expect(MACRO_SPLIT_BY_GOAL.lose_weight.protein).toBeGreaterThanOrEqual(MACRO_SPLIT_BY_GOAL.gain_muscle.protein);
  });

  it('gives a muscle-gain goal more carbohydrate than weight loss, for training fuel', () => {
    expect(MACRO_SPLIT_BY_GOAL.gain_muscle.carbs).toBeGreaterThan(MACRO_SPLIT_BY_GOAL.lose_weight.carbs);
    expect(MACRO_SPLIT_BY_GOAL.gain_muscle.carbs).toBeGreaterThan(MACRO_SPLIT_BY_GOAL.eat_healthy.carbs);
  });

  it('caps carbohydrate for diabetes management below the maintenance split', () => {
    expect(MACRO_SPLIT_BY_GOAL.manage_diabetes.carbs).toBeLessThanOrEqual(MACRO_SPLIT_BY_GOAL.maintain.carbs);
  });

  it('applies the calorie adjustment that matches each goal', () => {
    expect(CALORIE_ADJUSTMENT_BY_GOAL.lose_weight).toBeLessThan(0);
    expect(CALORIE_ADJUSTMENT_BY_GOAL.gain_muscle).toBeGreaterThan(0);
    expect(CALORIE_ADJUSTMENT_BY_GOAL.maintain).toBe(0);
  });

  it('defines activity levels from sedentary to very active', () => {
    expect(ACTIVITY_LEVELS).toContain('sedentary');
    expect(ACTIVITY_LEVELS).toContain('very_active');
  });
});

describe('day-of-week data', () => {
  it('uses ISO numbering, Monday = 1 through Sunday = 7', () => {
    expect(DAY_NAMES[1]).toBe('Monday');
    expect(DAY_NAMES[7]).toBe('Sunday');
    expect(Object.keys(DAY_NAMES)).toHaveLength(7);
  });

  it('has a short name for every day', () => {
    for (const day of DAYS_OF_WEEK) {
      expect(DAY_SHORT_NAMES[day], `no short name for day ${day}`).toBeDefined();
      expect(DAY_SHORT_NAMES[day]!.length).toBeLessThanOrEqual(3);
    }
  });

  it('has exactly seven entries in each table', () => {
    expect(DAYS_OF_WEEK).toHaveLength(7);
    expect(Object.keys(DAY_SHORT_NAMES)).toHaveLength(7);
  });
});

describe('enum sets used by schemas and UI', () => {
  it('has no duplicates in any enum', () => {
    const enums: Record<string, readonly string[]> = {
      MEAL_TYPES,
      DIFFICULTY_LEVELS,
      WASTE_REASONS,
      SCAN_SOURCES,
      SCAN_STATUSES,
      FRESHNESS_LEVELS,
      STORAGE_LOCATIONS,
      COOKING_SKILL_LEVELS,
      DIETARY_PREFERENCES,
      HEALTH_GOALS,
      ACTIVITY_LEVELS,
      CURRENCIES,
    };

    for (const [name, values] of Object.entries(enums)) {
      expect(new Set(values).size, `${name} contains duplicates`).toBe(values.length);
      expect(values.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  it('uses the four meal types the plan grid renders', () => {
    expect([...MEAL_TYPES].sort()).toEqual(['breakfast', 'dinner', 'lunch', 'snack']);
  });

  it('uses the three storage locations a kitchen actually has', () => {
    expect([...STORAGE_LOCATIONS].sort()).toEqual(['freezer', 'fridge', 'pantry']);
  });

  it('covers the scan lifecycle end to end', () => {
    expect([...SCAN_STATUSES]).toEqual(['queued', 'processing', 'completed', 'failed']);
  });

  it('lists the waste reasons the UI offers', () => {
    for (const reason of ['expired', 'spoiled', 'leftover', 'overcooked', 'didnt_like', 'other']) {
      expect(WASTE_REASONS).toContain(reason);
    }
  });

  it('includes USD, the default currency', () => {
    expect(CURRENCIES).toContain('USD');
  });

  it('offers a reasonable set of cuisines', () => {
    expect(CUISINES.length).toBeGreaterThanOrEqual(8);
    expect(CUISINES).toContain('Italian');
  });
});

describe('app-wide identifiers', () => {
  it('uses a versioned API prefix', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('declares the deep-link scheme from app.json', () => {
    expect(APP_SCHEME).toBe('platematch');
  });
});
