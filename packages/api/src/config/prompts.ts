import { env } from './env.js';

/**
 * Static AI prompt templates (Section 5 of the spec).
 *
 * Keeping prompts in their own module makes them easy to review, version and
 * A/B test. Every template is a pure function of its inputs — no I/O, no
 * hidden state — so they are trivially unit-testable.
 */

// ---------------------------------------------------------------------------
// A. Fridge scanning
// ---------------------------------------------------------------------------

/**
 * System instruction sent to the vision model. Rule #8 (confidence floor) and
 * rule #9 (non-food images) are the two most important guardrails.
 */
export const FRIDGE_SCAN_PROMPT = `You are PlateMatch AI, a food identification expert.
Analyze this refrigerator/pantry photograph and identify EVERY visible food item.

RULES:
1. Identify ALL food items, including partially visible ones.
2. For each item, estimate the quantity and unit.
3. Assess freshness based on visual cues (color, texture, wilting, mold, packaging).
4. If you can read any expiry/best-before/use-by labels, include the date exactly as printed.
5. Ignore non-food items (empty containers, shelves, bottles of water, cleaning products).
6. Group similar items (e.g. "3 tomatoes", not "tomato, tomato, tomato").
7. Be specific: "cherry tomatoes" not just "tomatoes", "Greek yogurt" not just "yogurt" when the label is readable.
8. Minimum confidence threshold: 0.65. Do NOT include items below this threshold.
9. If the image is unclear or is not a fridge/pantry, return an empty array and explain why in "suggestions".

CATEGORY VALUES (use exactly one of these):
vegetable, fruit, dairy, meat, seafood, grain, spice, condiment, beverage, snack,
frozen, canned, bakery, legume, nut_seed, oil_fat, sweetener, other

FRESHNESS VALUES: fresh | ripening | overripe | spoiled

QUANTITY GUIDANCE:
- Prefer counting units ("3 pieces") for discrete items (eggs, tomatoes, cans).
- Use weight/volume for loose or bulk items ("250 g", "500 ml").
- Use "cups"/"tbsp" only for already-prepared food in bowls.

EXPIRY GUIDANCE:
- If no label is readable, set "expiry_label_read" to null and estimate
  "suggested_shelf_life_days" from today based on the item and its freshness.

OUTPUT: Valid JSON matching the provided schema exactly. No prose outside the JSON.`;

/** The Gemini structured-output schema (mirrors `detectedItemSchema`). */
export const FRIDGE_SCAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    detected_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'vegetable', 'fruit', 'dairy', 'meat', 'seafood', 'grain', 'spice', 'condiment',
              'beverage', 'snack', 'frozen', 'canned', 'bakery', 'legume', 'nut_seed',
              'oil_fat', 'sweetener', 'other',
            ],
          },
          estimated_quantity: { type: 'string' },
          estimated_unit: { type: 'string' },
          freshness: { type: 'string', enum: ['fresh', 'ripening', 'overripe', 'spoiled'] },
          confidence: { type: 'number' },
          location_in_image: { type: 'string' },
          expiry_label_read: { type: 'string' },
          suggested_shelf_life_days: { type: 'number' },
        },
        required: ['name', 'category', 'confidence'],
      },
    },
    overall_fridge_status: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['detected_items'],
} as const;

// ---------------------------------------------------------------------------
// B. Recipe generation
// ---------------------------------------------------------------------------

export const RECIPE_SYSTEM_PROMPT = `You are PlateMatch AI Chef, a world-class culinary expert and nutritionist.
You create practical, delicious, and nutritionally accurate recipes.

CRITICAL RULES (violating these is unacceptable):
1. NEVER include any ingredient the user is allergic to. Allergies can be fatal.
   This is your absolute #1 priority. Include cross-contamination warnings for severe allergies.
2. Strictly respect dietary preferences. If vegan, absolutely no animal products
   including honey, gelatin, dairy or eggs.
3. Prioritize ingredients the user already has in their pantry.
   Minimize the number of additional ingredients needed.
4. Assume basic staples are available: salt, black pepper, cooking oil, water
   (unless the user says otherwise). Mark those staples is_optional=true.
5. All cooking times must be realistic and accurate.
6. Instructions must be clear enough for a beginner to follow.
7. Nutritional estimates must be reasonably accurate and per serving.
8. Always suggest at least one substitute per key ingredient.
9. Output MUST be valid JSON matching the exact schema provided.
   No markdown, no code fences, no explanation text outside the JSON.`;

export const MEAL_PLAN_SYSTEM_PROMPT = `${RECIPE_SYSTEM_PROMPT}

You are also a certified nutritionist. Every meal plan you create must be
nutritionally balanced across the entire week. Ensure:
- Daily calorie targets are met within +/-10%.
- Protein is distributed evenly across meals.
- Micronutrient variety (do not repeat the same vegetables every day).
- At least 2 quick meals (<15 min) for busy days.
- At least 1 "use the leftovers" meal to reduce waste.
- The budget constraint is respected.
- Items expiring soon are consumed in the first 2-3 days.`;

export const RECIPE_OUTPUT_SCHEMA_DOC = `{
  "recipes": [
    {
      "title": "string (appealing, descriptive name)",
      "description": "string (2-3 sentences, appetizing)",
      "cuisine": "string",
      "meal_type": "breakfast|lunch|dinner|snack",
      "difficulty": "easy|medium|hard",
      "prep_time_min": number,
      "cook_time_min": number,
      "total_time_min": number,
      "servings": number,
      "tags": ["string"],
      "ingredients": [
        {
          "name": "string (specific, e.g. 'chicken breast')",
          "quantity": number,
          "unit": "string (g, ml, pieces, cups, tbsp, tsp)",
          "category": "vegetable|fruit|dairy|meat|seafood|grain|spice|condiment|beverage|snack|frozen|canned|bakery|legume|nut_seed|oil_fat|sweetener|other",
          "is_in_pantry": boolean,
          "is_optional": boolean,
          "substitutes": ["string (at least 1)"]
        }
      ],
      "steps": [
        {
          "step_number": number,
          "instruction": "string (clear, detailed, beginner-friendly)",
          "duration_min": number,
          "tip": "string or null"
        }
      ],
      "estimated_nutrition_per_serving": {
        "calories": number, "protein_g": number, "carbs_g": number,
        "fat_g": number, "fiber_g": number, "sodium_mg": number
      },
      "allergen_warnings": ["string or empty array"],
      "storage_instructions": "string",
      "reheating_instructions": "string or null"
    }
  ]
}`;

export const MEAL_PLAN_OUTPUT_SCHEMA_DOC = `{
  "meal_plan": {
    "monday": {
      "breakfast": { "title": "...", "description": "...", "cuisine": "...", "difficulty": "easy",
                     "prep_time_min": 0, "cook_time_min": 0, "total_time_min": 0, "servings": 2,
                     "tags": [], "ingredients": [], "steps": [],
                     "estimated_nutrition_per_serving": {}, "allergen_warnings": [],
                     "storage_instructions": "...", "reheating_instructions": null,
                     "estimated_cost": 0, "uses_expiring_items": [] },
      "lunch": {}, "dinner": {}, "snack": null
    }
  },
  "daily_nutrition_summary": {
    "monday": { "calories": 0, "protein": 0, "carbs": 0, "fat": 0 }
  },
  "weekly_nutrition_totals": { "calories": 0, "protein": 0, "carbs": 0, "fat": 0 },
  "grocery_list": [
    { "item": "string", "quantity": 0, "unit": "string",
      "estimated_price": 0, "needed_for": ["Monday dinner"] }
  ],
  "estimated_weekly_grocery_cost": 0,
  "pantry_items_used": ["string"],
  "waste_reduction_tips": ["string"],
  "meal_prep_suggestions": ["string"]
}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export interface PromptUserProfile {
  dietaryPreference: string;
  allergies: Array<{ allergen: string; severity: string }>;
  healthGoal: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  familySize: number;
  cookingSkill: string;
  maxTime: number;
  cuisines: string[];
  currency: string;
}

export interface PromptPantryItem {
  name: string;
  quantity: number | null;
  unit: string | null;
  category: string;
  expiryDate: string | null;
  daysUntilExpiry: number | null;
  location: string;
}

export interface RecipePromptParams {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  expiringSoon: PromptPantryItem[];
  count: number;
  servings: number;
  cuisine?: string;
  mealType?: string;
  difficulty?: string;
  maxTimeMin?: number;
  extraIngredients: string[];
  avoid: string[];
  minPantryMatch: number;
}

function formatProfile(p: PromptUserProfile): string {
  const allergies = p.allergies.length
    ? p.allergies.map((a) => `${a.allergen} (${a.severity})`).join(', ')
    : 'none declared';

  return `- Dietary preference: ${p.dietaryPreference}
- Allergies (CRITICAL — NEVER use these): ${allergies}
- Health goal: ${p.healthGoal}
- Daily targets: ${p.calories ?? '~2000'} cal, ${p.protein ?? '~120'}g protein, ${p.carbs ?? '~220'}g carbs, ${p.fat ?? '~65'}g fat
- Family size: ${p.familySize}
- Cooking skill: ${p.cookingSkill}
- Max cooking time: ${p.maxTime} minutes
- Preferred cuisines: ${p.cuisines.length ? p.cuisines.join(', ') : 'any'}`;
}

function formatPantry(items: PromptPantryItem[], limit = 80): string {
  if (!items.length) return '(pantry is empty — assume only basic staples)';
  return items
    .slice(0, limit)
    .map((i) => {
      const qty = i.quantity != null ? `${i.quantity}${i.unit ? ' ' + i.unit : ''}` : 'some';
      const exp =
        i.daysUntilExpiry == null
          ? ''
          : i.daysUntilExpiry < 0
            ? ' [EXPIRED]'
            : i.daysUntilExpiry <= 3
              ? ` [EXPIRES IN ${i.daysUntilExpiry} DAY${i.daysUntilExpiry === 1 ? '' : 'S'}]`
              : '';
      return `- ${i.name}: ${qty} (${i.category}, ${i.location})${exp}`;
    })
    .join('\n');
}

/** Build the user prompt for recipe generation. */
export function buildRecipePrompt(params: RecipePromptParams): string {
  const {
    profile,
    pantry,
    expiringSoon,
    count,
    servings,
    cuisine,
    mealType,
    difficulty,
    maxTimeMin,
    extraIngredients,
    avoid,
    minPantryMatch,
  } = params;

  return `Generate ${count} unique recipes for this user.

=== USER PROFILE ===
${formatProfile(profile)}

=== AVAILABLE INGREDIENTS (in pantry) ===
${formatPantry(pantry)}

=== EXPIRING SOON (prioritize these heavily) ===
${formatPantry(expiringSoon, 30)}

=== REQUEST PARAMETERS ===
- Cuisine: ${cuisine ?? 'any'}
- Meal type: ${mealType ?? 'any'}
- Difficulty: ${difficulty ?? 'any'}
- Servings: ${servings}
- Maximum total cooking time: ${maxTimeMin ?? profile.maxTime} minutes
- Additional ingredients the user is willing to buy: ${extraIngredients.length ? extraIngredients.join(', ') : 'none'}
- Ingredients to avoid (besides allergies): ${avoid.length ? avoid.join(', ') : 'none'}
- Minimum fraction of ingredients that must already be in the pantry: ${Math.round(minPantryMatch * 100)}%

=== HARD REQUIREMENTS ===
- Every recipe MUST exclude all listed allergens entirely (no traces, no "may contain").
- Every recipe MUST comply with the dietary preference above.
- Prefer recipes that use the EXPIRING SOON items first.
- Titles must be unique across the ${count} recipes; do not repeat a dish.

=== OUTPUT SCHEMA ===
${RECIPE_OUTPUT_SCHEMA_DOC}

Return ONLY the JSON object. No markdown fences.`;
}

export interface MealPlanPromptParams {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  expiringSoon: PromptPantryItem[];
  startDate: string;
  days: number;
  mealsPerDay: number;
  variety: 'low' | 'medium' | 'high';
  budget?: number;
  cookingTimePref: 'quick' | 'balanced' | 'elaborate';
  excludeTitles: string[];
  includeTitles: string[];
  weeklyCalories: number;
  mealTypes: string[];
}

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Build the user prompt for weekly meal-plan generation. */
export function buildMealPlanPrompt(params: MealPlanPromptParams): string {
  const {
    profile,
    pantry,
    expiringSoon,
    startDate,
    days,
    mealsPerDay,
    variety,
    budget,
    cookingTimePref,
    excludeTitles,
    includeTitles,
    weeklyCalories,
    mealTypes,
  } = params;

  const dayKeys = DAY_KEYS.slice(0, days);
  const skeleton = dayKeys
    .map((d) => {
      const slots = mealTypes.map((m) => `"${m}": { ... }`).join(', ');
      return `    "${d}": { ${slots} }`;
    })
    .join(',\n');

  return `Generate a complete ${days}-day meal plan starting ${startDate}.

=== USER PROFILE ===
${formatProfile(profile)}

=== NUTRITION TARGETS ===
- Daily: ${profile.calories ?? 2000} cal | ${profile.protein ?? 120}g P | ${profile.carbs ?? 220}g C | ${profile.fat ?? 65}g F
- Total for the plan: ${weeklyCalories} cal

=== PANTRY INVENTORY ===
${formatPantry(pantry, 120)}

=== EXPIRING ITEMS (use in the first 2-3 days) ===
${formatPantry(expiringSoon, 40)}

=== CONSTRAINTS ===
- Days to plan: ${days} (${dayKeys.join(', ')})
- Meals per day: ${mealsPerDay} — include exactly these meal types: ${mealTypes.join(', ')}
- Weekly grocery budget: ${budget != null ? `${profile.currency} ${budget}` : 'unspecified'}
- Cooking time preference: ${cookingTimePref}
- Variety level: ${variety} (${variety === 'low' ? 'some repeats are fine' : variety === 'high' ? 'every meal must be a different dish' : 'a couple of repeats allowed'})
- Start date: ${startDate}
- Exclude these dishes: ${excludeTitles.length ? excludeTitles.join(', ') : 'none'}
- Must include these dishes: ${includeTitles.length ? includeTitles.join(', ') : 'none'}

=== HARD REQUIREMENTS ===
- No allergens listed in the user profile, in any meal.
- Respect the dietary preference in every meal.
- Keep each day within +/-10% of the daily calorie target.
- Include at least 2 meals under 15 minutes total.
- Include at least 1 meal explicitly built from leftovers/pantry clearance.
- Every recipe object must follow the same shape as the recipe schema below.

=== OUTPUT SCHEMA ===
{
  "meal_plan": {
${skeleton}
  },
  "daily_nutrition_summary": { ${dayKeys.map((d) => `"${d}": { "calories": N, "protein": N, "carbs": N, "fat": N }`).join(', ')} },
  "weekly_nutrition_totals": { "calories": N, "protein": N, "carbs": N, "fat": N },
  "grocery_list": [ { "item": "string", "quantity": N, "unit": "string", "estimated_price": N, "needed_for": ["monday dinner"] } ],
  "estimated_weekly_grocery_cost": N,
  "pantry_items_used": ["string"],
  "waste_reduction_tips": ["string"],
  "meal_prep_suggestions": ["string"]
}

Each meal object must look like this:
${MEAL_PLAN_OUTPUT_SCHEMA_DOC.split('\n').slice(2, 20).join('\n')}

Return ONLY the JSON object. No markdown fences.`;
}

/** Prompt used to ask the model for a single replacement meal (swap / regenerate day). */
export function buildSwapMealPrompt(params: {
  profile: PromptUserProfile;
  pantry: PromptPantryItem[];
  dayName: string;
  mealType: string;
  avoidTitles: string[];
}): string {
  return `Replace one meal in an existing plan.

=== USER PROFILE ===
${formatProfile(params.profile)}

=== AVAILABLE INGREDIENTS ===
${formatPantry(params.pantry, 60)}

=== TASK ===
Propose ONE new ${params.mealType} recipe for ${params.dayName}.
It must be different from: ${params.avoidTitles.length ? params.avoidTitles.join(', ') : '(none)'}.

=== OUTPUT SCHEMA ===
{ "recipe": ${RECIPE_OUTPUT_SCHEMA_DOC.replace('{\n  "recipes": [\n', '').replace(/\n  \]\n}/, '')} }

Return ONLY the JSON object.`;
}

/** Deterministic hash of a prompt so identical requests hit the cache. */
export function promptCacheKey(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return canonical;
}
