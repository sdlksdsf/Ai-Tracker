import type { DetectedItem, FreshnessLevel, IngredientCategory } from '@platematch/shared';

/**
 * Shared AI contracts.
 *
 * Every provider implements the same narrow interface so the orchestrating
 * services (`vision.service`, `recipe.service`, `mealplan.service`) can swap
 * providers, chain fallbacks and record cost without caring who answered.
 */

export type AiProviderName = 'gemini' | 'openai' | 'anthropic' | 'cloud-vision' | 'edamam' | 'spoonacular' | 'kroger' | 'local';

export type AiTask = 'vision' | 'recipe' | 'mealplan' | 'nutrition' | 'prices';

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface AiCallResult<T> {
  data: T;
  provider: AiProviderName;
  model: string;
  usage: AiUsage;
  latencyMs: number;
  /** True when the answer came from cache rather than a live call. */
  cached?: boolean;
}

export interface VisionRequest {
  /** JPEG/PNG/WebP bytes, already downscaled to ≤1536px. */
  image: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  /** Optional hint from the user ("this is my freezer shelf"). */
  hint?: string;
  signal?: AbortSignal;
}

export interface VisionResult {
  detectedItems: DetectedItem[];
  overallFridgeStatus: string | null;
  suggestions: string[];
  /** Mean confidence across accepted detections. */
  averageConfidence: number;
  boundingBoxes: BoundingBox[];
}

export interface BoundingBox {
  label: string;
  confidence: number;
  /** Normalised 0..1 relative to the image. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A recipe as produced by an LLM (pre-persistence). */
export interface AiRecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
  category: IngredientCategory;
  is_in_pantry: boolean;
  is_optional: boolean;
  substitutes: string[];
}

export interface AiRecipeStep {
  step_number: number;
  instruction: string;
  duration_min: number | null;
  tip: string | null;
}

export interface AiRecipe {
  title: string;
  description: string;
  cuisine: string;
  meal_type?: 'breakfast' | 'lunch' | 'dinner' | 'snack' | null;
  difficulty: 'easy' | 'medium' | 'hard';
  prep_time_min: number;
  cook_time_min: number;
  total_time_min: number;
  servings: number;
  tags: string[];
  ingredients: AiRecipeIngredient[];
  steps: AiRecipeStep[];
  estimated_nutrition_per_serving: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    sodium_mg: number;
  };
  allergen_warnings: string[];
  storage_instructions: string;
  reheating_instructions: string | null;
  /** Present only for meal-plan recipes. */
  estimated_cost?: number;
  uses_expiring_items?: string[];
}

export interface AiRecipeBatch {
  recipes: AiRecipe[];
}

export interface AiMealSlot {
  recipe: AiRecipe | null;
}

export interface AiMealPlan {
  /** day key (monday…) → meal type → recipe */
  meal_plan: Record<string, Record<string, AiRecipe | null>>;
  daily_nutrition_summary: Record<string, { calories: number; protein: number; carbs: number; fat: number }>;
  weekly_nutrition_totals: { calories: number; protein: number; carbs: number; fat: number };
  grocery_list: Array<{ item: string; quantity: number | null; unit: string | null; estimated_price: number | null; needed_for: string[] }>;
  estimated_weekly_grocery_cost: number;
  pantry_items_used: string[];
  waste_reduction_tips: string[];
  meal_prep_suggestions: string[];
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

export interface VisionProvider {
  readonly name: AiProviderName;
  readonly model: string;
  readonly isConfigured: boolean;
  analyse(request: VisionRequest): Promise<AiCallResult<VisionResult>>;
}

export interface ReasoningProvider {
  readonly name: AiProviderName;
  readonly model: string;
  readonly isConfigured: boolean;
  /**
   * Send a system + user prompt and get strictly-parsed JSON back.
   * Implementations must use provider-native structured output where available.
   */
  generateJson<T>(request: ReasoningRequest): Promise<AiCallResult<T>>;
}

export interface ReasoningRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  /** Optional JSON schema hint (Gemini structured output / OpenAI json_schema). */
  jsonSchema?: unknown;
  signal?: AbortSignal;
  /** Free-form label used in logs and the usage ledger. */
  label?: string;
}

export type Freshness = FreshnessLevel;
