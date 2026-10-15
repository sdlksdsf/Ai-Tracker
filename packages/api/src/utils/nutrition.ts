import {
  ACTIVITY_MULTIPLIERS,
  CALORIE_ADJUSTMENT_BY_GOAL,
  MACRO_SPLIT_BY_GOAL,
  type ActivityLevel,
  type HealthGoal,
} from '@platematch/shared';

/**
 * Nutrition target calculation
 * ===========================================================================
 * Resting energy expenditure uses the Mifflin–St Jeor equation (the most
 * accurate for the general population), multiplied by an activity factor and
 * adjusted for the user's health goal.
 *
 *   Men:   BMR = 10·kg + 6.25·cm − 5·age + 5
 *   Women: BMR = 10·kg + 6.25·cm − 5·age − 161
 *
 * When height/weight/age are missing we fall back to sensible defaults so the
 * app always has a target to plan against.
 */

export interface NutritionProfileInput {
  gender?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  dateOfBirth?: string | Date | null;
  healthGoal?: HealthGoal | string | null;
  activityLevel?: ActivityLevel | string | null;
  /** Override the calculated calorie target (e.g. from the onboarding slider). */
  calorieOverride?: number | null;
}

export interface NutritionTargets {
  dailyCalorieTarget: number;
  dailyProteinTargetG: number;
  dailyCarbsTargetG: number;
  dailyFatTargetG: number;
  bmr: number;
  tdee: number;
  age: number | null;
  method: 'mifflin_st_jeor' | 'default';
}

const DEFAULT_CALORIES = 2000;
const SAFE_MIN_CALORIES = 1200;
const SAFE_MAX_CALORIES = 4500;

export function calculateAge(dateOfBirth: string | Date | null | undefined, now = new Date()): number | null {
  if (!dateOfBirth) return null;
  const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth;
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function calculateNutritionTargets(input: NutritionProfileInput): NutritionTargets {
  const goal = (input.healthGoal ?? 'eat_healthy') as HealthGoal;
  const activity = (input.activityLevel ?? 'moderate') as ActivityLevel;

  const age = calculateAge(input.dateOfBirth);
  const hasBodyData = Boolean(input.heightCm && input.weightKg && age !== null);

  let bmr: number;
  let method: NutritionTargets['method'];

  if (hasBodyData) {
    const weight = input.weightKg as number;
    const height = input.heightCm as number;
    const base = 10 * weight + 6.25 * height - 5 * (age as number);
    // 'female' → −161, everything else (including 'prefer_not_to_say') → +5.
    bmr = input.gender === 'female' ? base - 161 : base + 5;
    method = 'mifflin_st_jeor';
  } else {
    bmr = input.gender === 'female' ? 1350 : 1600;
    method = 'default';
  }

  const multiplier = ACTIVITY_MULTIPLIERS[activity] ?? 1.55;
  const tdee = bmr * multiplier;

  const adjustment = CALORIE_ADJUSTMENT_BY_GOAL[goal] ?? 0;
  let calories = input.calorieOverride ?? Math.round(tdee + adjustment);

  // Clamp to a safe band.
  calories = Math.min(SAFE_MAX_CALORIES, Math.max(SAFE_MIN_CALORIES, calories));
  // Round to the nearest 25 kcal so the number looks intentional in the UI.
  calories = Math.round(calories / 25) * 25;

  const split = MACRO_SPLIT_BY_GOAL[goal] ?? MACRO_SPLIT_BY_GOAL.eat_healthy;

  // Protein: 4 kcal/g, carbs: 4 kcal/g, fat: 9 kcal/g.
  const protein = Math.round((calories * split.protein) / 4);
  const carbs = Math.round((calories * split.carbs) / 4);
  const fat = Math.round((calories * split.fat) / 9);

  return {
    dailyCalorieTarget: calories,
    dailyProteinTargetG: protein,
    dailyCarbsTargetG: carbs,
    dailyFatTargetG: fat,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    age,
    method,
  };
}

/** Weekly calorie budget = daily target × days. */
export function weeklyCalorieTarget(daily: number | null, days = 7): number {
  return (daily ?? DEFAULT_CALORIES) * days;
}

/** ±10% tolerance check used to verify a generated meal plan. */
export interface MacroCheck {
  day: number;
  calories: number;
  target: number;
  delta: number;
  deltaPct: number;
  withinTolerance: boolean;
}

export function checkDailyMacros(
  day: number,
  calories: number,
  target: number | null,
  tolerancePct = 10,
): MacroCheck {
  const t = target ?? DEFAULT_CALORIES;
  const delta = calories - t;
  const deltaPct = t === 0 ? 0 : (delta / t) * 100;
  return {
    day,
    calories: Math.round(calories),
    target: t,
    delta: Math.round(delta),
    deltaPct: Math.round(deltaPct * 10) / 10,
    withinTolerance: Math.abs(deltaPct) <= tolerancePct,
  };
}

/** Per-serving macros → totals for `servings`. */
export function scaleNutrition(
  perServing: { calories?: number | null; protein_g?: number | null; carbs_g?: number | null; fat_g?: number | null },
  servings: number,
): { calories: number; protein_g: number; carbs_g: number; fat_g: number } {
  return {
    calories: Math.round((perServing.calories ?? 0) * servings),
    protein_g: Math.round((perServing.protein_g ?? 0) * servings * 10) / 10,
    carbs_g: Math.round((perServing.carbs_g ?? 0) * servings * 10) / 10,
    fat_g: Math.round((perServing.fat_g ?? 0) * servings * 10) / 10,
  };
}

/** Percentage of a daily target a single meal covers. */
export function percentOfTarget(value: number | null | undefined, target: number | null | undefined): number {
  if (!value || !target) return 0;
  return Math.min(999, Math.round((value / target) * 100));
}

export { DEFAULT_CALORIES };
