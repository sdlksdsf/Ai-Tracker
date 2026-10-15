import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALORIES,
  calculateAge,
  calculateNutritionTargets,
  checkDailyMacros,
  percentOfTarget,
  scaleNutrition,
  weeklyCalorieTarget,
} from '../../src/utils/nutrition.js';

/**
 * Nutrition maths (Sections 5.C and 6).
 *
 * These numbers are shown to users as health guidance and drive the meal-plan
 * verification loop, so they must be plausible, bounded and stable. The Mifflin–
 * St Jeor equation is the reference; the guards around it matter as much as the
 * formula.
 */

describe('calculateAge', () => {
  const now = new Date(Date.UTC(2026, 9, 15));

  it('computes a whole number of years', () => {
    expect(calculateAge('1994-05-12', now)).toBe(32);
  });

  it('has not incremented before the birthday in the current year', () => {
    expect(calculateAge('1994-12-01', now)).toBe(31);
  });

  it('increments on the birthday itself', () => {
    expect(calculateAge('1994-10-15', now)).toBe(32);
  });

  it('accepts a Date', () => {
    expect(calculateAge(new Date(Date.UTC(1994, 4, 12)), now)).toBe(32);
  });

  it('returns null when there is no date of birth', () => {
    expect(calculateAge(null, now)).toBeNull();
    expect(calculateAge(undefined, now)).toBeNull();
  });

  it('rejects an implausible date of birth instead of returning a bad number', () => {
    // A future or absurd birth date (bad OCR, a timezone edge, a fat-fingered
    // year) must yield null — "unknown" — rather than a negative or 900-year-old
    // age that would then be fed into the Mifflin-St Jeor equation.
    expect(calculateAge('2030-01-01', now)).toBeNull();
    expect(calculateAge('1700-01-01', now)).toBeNull();
  });

  it('rejects an unparseable date string', () => {
    expect(calculateAge('not-a-date', now)).toBeNull();
    expect(calculateAge('', now)).toBeNull();
  });

  it('falls back to default targets when the age is unusable', () => {
    const targets = calculateNutritionTargets({
      gender: 'male',
      heightCm: 180,
      weightKg: 80,
      dateOfBirth: '2030-01-01',
      activityLevel: 'moderate',
      healthGoal: 'maintain',
    });
    // Still a sane number — never NaN, never negative.
    expect(targets.dailyCalorieTarget).toBeGreaterThan(0);
    expect(Number.isNaN(targets.dailyCalorieTarget)).toBe(false);
  });
});

describe('calculateNutritionTargets', () => {
  const base = {
    gender: 'male',
    heightCm: 180,
    weightKg: 80,
    dateOfBirth: '1994-05-12',
    activityLevel: 'moderate',
    healthGoal: 'maintain',
  };

  it('uses Mifflin–St Jeor when a full profile is available', () => {
    const targets = calculateNutritionTargets(base);
    expect(targets.method).toBe('mifflin_st_jeor');
    expect(targets.bmr).toBeGreaterThan(1500);
    expect(targets.bmr).toBeLessThan(2200);
    // TDEE must exceed BMR for any activity level above sedentary.
    expect(targets.tdee).toBeGreaterThan(targets.bmr);
  });

  it('produces a plausible maintenance calorie target', () => {
    const targets = calculateNutritionTargets(base);
    expect(targets.dailyCalorieTarget).toBeGreaterThan(2000);
    expect(targets.dailyCalorieTarget).toBeLessThan(3500);
  });

  it('orders the goals correctly: lose < maintain < gain', () => {
    const lose = calculateNutritionTargets({ ...base, healthGoal: 'lose_weight' });
    const maintain = calculateNutritionTargets({ ...base, healthGoal: 'maintain' });
    const gain = calculateNutritionTargets({ ...base, healthGoal: 'gain_muscle' });

    expect(lose.dailyCalorieTarget).toBeLessThan(maintain.dailyCalorieTarget);
    expect(gain.dailyCalorieTarget).toBeGreaterThan(maintain.dailyCalorieTarget);
  });

  it('scales with activity level', () => {
    const sedentary = calculateNutritionTargets({ ...base, activityLevel: 'sedentary' });
    const veryActive = calculateNutritionTargets({ ...base, activityLevel: 'very_active' });
    expect(veryActive.dailyCalorieTarget).toBeGreaterThan(sedentary.dailyCalorieTarget);
  });

  it('gives men a higher target than women at the same measurements', () => {
    const male = calculateNutritionTargets({ ...base, gender: 'male' });
    const female = calculateNutritionTargets({ ...base, gender: 'female' });
    expect(male.dailyCalorieTarget).toBeGreaterThan(female.dailyCalorieTarget);
  });

  it('splits macros to roughly the calorie target', () => {
    const targets = calculateNutritionTargets(base);
    // 4 kcal per gram of protein and carbs, 9 kcal per gram of fat.
    const fromMacros =
      targets.dailyProteinTargetG * 4 + targets.dailyCarbsTargetG * 4 + targets.dailyFatTargetG * 9;
    expect(fromMacros).toBeGreaterThan(targets.dailyCalorieTarget * 0.8);
    expect(fromMacros).toBeLessThan(targets.dailyCalorieTarget * 1.2);
  });

  it('gives a muscle-gain goal more protein than maintenance', () => {
    const maintain = calculateNutritionTargets({ ...base, healthGoal: 'maintain' });
    const gain = calculateNutritionTargets({ ...base, healthGoal: 'gain_muscle' });
    expect(gain.dailyProteinTargetG).toBeGreaterThanOrEqual(maintain.dailyProteinTargetG);
  });

  it('falls back to defaults when the profile is missing', () => {
    const targets = calculateNutritionTargets({});
    expect(targets.method).toBe('default');
    expect(targets.dailyCalorieTarget).toBeGreaterThan(0);
    expect(targets.age).toBeNull();
  });

  it('honours an explicit calorie override from the onboarding slider', () => {
    const targets = calculateNutritionTargets({ ...base, calorieOverride: 2400 });
    expect(targets.dailyCalorieTarget).toBe(2400);
  });

  it('never returns a clinically unsafe target', () => {
    // Extreme inputs must be clamped, not passed through: 30 kg / 140 cm with a
    // "lose weight" goal must not produce a starvation-level number.
    const tiny = calculateNutritionTargets({
      gender: 'female',
      heightCm: 140,
      weightKg: 35,
      dateOfBirth: '1994-05-12',
      activityLevel: 'sedentary',
      healthGoal: 'lose_weight',
    });
    expect(tiny.dailyCalorieTarget).toBeGreaterThanOrEqual(1200);

    const huge = calculateNutritionTargets({
      gender: 'male',
      heightCm: 220,
      weightKg: 250,
      dateOfBirth: '1994-05-12',
      activityLevel: 'very_active',
      healthGoal: 'gain_muscle',
    });
    expect(huge.dailyCalorieTarget).toBeLessThanOrEqual(4500);
  });

  it('is deterministic — the same profile always yields the same targets', () => {
    const a = calculateNutritionTargets(base);
    const b = calculateNutritionTargets(base);
    expect(a).toEqual(b);
  });
});

describe('weeklyCalorieTarget', () => {
  it('multiplies the daily target by seven', () => {
    expect(weeklyCalorieTarget(2000)).toBe(14_000);
  });

  it('respects a custom day count', () => {
    expect(weeklyCalorieTarget(2000, 5)).toBe(10_000);
  });

  it('handles a null daily target', () => {
    expect(weeklyCalorieTarget(null)).toBeGreaterThanOrEqual(0);
  });
});

describe('scaleNutrition', () => {
  const perServing = { calories: 400, protein_g: 30, carbs_g: 40, fat_g: 12 };

  it('scales every macro linearly', () => {
    expect(scaleNutrition(perServing, 2)).toEqual({ calories: 800, protein_g: 60, carbs_g: 80, fat_g: 24 });
  });

  it('returns the per-serving values for one serving', () => {
    expect(scaleNutrition(perServing, 1)).toEqual({ calories: 400, protein_g: 30, carbs_g: 40, fat_g: 12 });
  });

  it('treats missing fields as zero rather than NaN', () => {
    const scaled = scaleNutrition({ calories: 400 }, 3);
    expect(scaled.calories).toBe(1200);
    expect(scaled.protein_g).toBe(0);
    expect(Number.isNaN(scaled.fat_g)).toBe(false);
  });

  it('rounds macros to one decimal and calories to a whole number', () => {
    const scaled = scaleNutrition({ calories: 333.33, protein_g: 10.05, carbs_g: 0, fat_g: 0 }, 3);
    expect(Number.isInteger(scaled.calories)).toBe(true);
    expect(scaled.protein_g).toBe(Math.round(scaled.protein_g * 10) / 10);
  });

  it('handles a family-size serving count without overflowing', () => {
    const scaled = scaleNutrition(perServing, 12);
    expect(scaled.calories).toBe(4800);
    expect(Number.isFinite(scaled.calories)).toBe(true);
  });
});

describe('percentOfTarget', () => {
  it('returns a whole percentage', () => {
    expect(percentOfTarget(1000, 2000)).toBe(50);
    expect(percentOfTarget(2000, 2000)).toBe(100);
    expect(percentOfTarget(2500, 2000)).toBe(125);
  });

  it('returns 0 for a zero or missing target', () => {
    expect(percentOfTarget(500, 0)).toBe(0);
    expect(percentOfTarget(500, null)).toBe(0);
    expect(percentOfTarget(500, undefined)).toBe(0);
  });

  it('returns 0 for a missing value', () => {
    expect(percentOfTarget(null, 2000)).toBe(0);
    expect(percentOfTarget(undefined, 2000)).toBe(0);
  });

  it('caps the result so a UI ring cannot wrap past 999%', () => {
    expect(percentOfTarget(100_000, 2000)).toBeLessThanOrEqual(999);
  });
});

describe('checkDailyMacros', () => {
  it('reports a day inside tolerance', () => {
    const check = checkDailyMacros(1, 2000, 2000);
    expect(check.withinTolerance).toBe(true);
    expect(check.delta).toBe(0);
    expect(check.deltaPct).toBe(0);
    expect(check.day).toBe(1);
    expect(check.calories).toBe(2000);
    expect(check.target).toBe(2000);
  });

  it('accepts a day within the default ±10% band', () => {
    expect(checkDailyMacros(2, 2150, 2000).withinTolerance).toBe(true);
    expect(checkDailyMacros(3, 1850, 2000).withinTolerance).toBe(true);
  });

  it('rejects a day outside the band', () => {
    expect(checkDailyMacros(4, 2400, 2000).withinTolerance).toBe(false);
    expect(checkDailyMacros(5, 1500, 2000).withinTolerance).toBe(false);
  });

  it('reports a signed delta so the UI can say over or under', () => {
    expect(checkDailyMacros(1, 2400, 2000).delta).toBe(400);
    expect(checkDailyMacros(1, 1600, 2000).delta).toBe(-400);
  });

  it('honours a custom tolerance', () => {
    expect(checkDailyMacros(1, 2400, 2000, 25).withinTolerance).toBe(true);
    expect(checkDailyMacros(1, 2400, 2000, 5).withinTolerance).toBe(false);
  });

  it('does not divide by zero when the target is 0', () => {
    const check = checkDailyMacros(1, 500, 0);
    expect(Number.isFinite(check.deltaPct)).toBe(true);
    expect(Number.isNaN(check.deltaPct)).toBe(false);
  });

  it('treats a zero-calorie day as under target', () => {
    expect(checkDailyMacros(1, 0, 2000).withinTolerance).toBe(false);
    expect(checkDailyMacros(1, 0, 2000).delta).toBe(-2000);
  });
});

describe('DEFAULT_CALORIES', () => {
  it('is a sensible fallback', () => {
    expect(DEFAULT_CALORIES).toBeGreaterThanOrEqual(1500);
    expect(DEFAULT_CALORIES).toBeLessThanOrEqual(2500);
  });
});
