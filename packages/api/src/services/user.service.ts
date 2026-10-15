import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  NutritionTargetsInput,
  UpdatePreferencesInput,
  UpdateProfileInput,
  UserDto,
} from '@platematch/shared';
import { getDb } from '../db/index.js';
import { notificationPreferences, userAllergies, users, type User, type UserAllergy } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { CacheKeys, cache } from '../lib/redis.js';
import { sanitizeText } from '../lib/crypto.js';
import { calculateNutritionTargets } from '../utils/nutrition.js';
import { userToDto, type UserWithAllergies } from './dto.js';

/**
 * User profile, preferences, allergies and nutrition targets.
 */

export async function getUserById(userId: string): Promise<User | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllergies(userId: string): Promise<UserAllergy[]> {
  const db = getDb();
  return db.select().from(userAllergies).where(eq(userAllergies.userId, userId)).orderBy(asc(userAllergies.allergen));
}

export async function getUserDto(userId: string): Promise<UserDto> {
  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');
  const allergies = await getAllergies(userId);
  return userToDto(user as UserWithAllergies, allergies);
}

/** Ensure a `notification_preferences` row exists for the user. */
export async function ensureNotificationPreferences(userId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(notificationPreferences)
    .values({ userId })
    .onConflictDoNothing({ target: notificationPreferences.userId });
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDto> {
  const db = getDb();
  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');

  const patch: Partial<User> = { updatedAt: new Date() };

  if (input.full_name !== undefined) patch.fullName = sanitizeText(input.full_name).slice(0, 100);
  if (input.avatar_url !== undefined) patch.avatarUrl = input.avatar_url ?? null;
  if (input.date_of_birth !== undefined) patch.dateOfBirth = input.date_of_birth ? toDateString(input.date_of_birth) : null;
  if (input.gender !== undefined) patch.gender = input.gender ?? null;
  if (input.height_cm !== undefined) patch.heightCm = input.height_cm ?? null;
  if (input.weight_kg !== undefined) patch.weightKg = input.weight_kg ?? null;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.locale !== undefined) patch.locale = input.locale;
  if (input.cooking_skill_level !== undefined) patch.cookingSkillLevel = input.cooking_skill_level;

  const rows = await db.update(users).set(patch).where(eq(users.id, userId)).returning();
  const updated = rows[0] as User;

  // Body metrics changed → recalculate targets.
  if (input.height_cm !== undefined || input.weight_kg !== undefined || input.date_of_birth !== undefined || input.gender !== undefined) {
    await recalculateTargets(userId, updated);
  }

  await invalidateUserCache(userId);
  return getUserDto(userId);
}

export async function updatePreferences(userId: string, input: UpdatePreferencesInput): Promise<UserDto> {
  const db = getDb();
  const user = await getUserById(userId);
  if (!user) throw new NotFoundError('User not found');

  const patch: Partial<User> = { updatedAt: new Date() };

  if (input.health_goal !== undefined) patch.healthGoal = input.health_goal;
  if (input.activity_level !== undefined) patch.activityLevel = input.activity_level;
  if (input.dietary_preference !== undefined) patch.dietaryPreference = input.dietary_preference;
  if (input.family_size !== undefined) patch.familySize = input.family_size;
  if (input.weekly_budget !== undefined) patch.weeklyBudget = input.weekly_budget ?? null;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.max_cooking_time_min !== undefined) patch.maxCookingTimeMin = input.max_cooking_time_min;
  if (input.onboarding_completed !== undefined) patch.onboardingCompleted = input.onboarding_completed;
  if (input.preferred_cuisines !== undefined) {
    patch.preferredCuisines = [...new Set(input.preferred_cuisines.map((c) => sanitizeText(c).trim()).filter(Boolean))];
  }

  await db.update(users).set(patch).where(eq(users.id, userId));

  // Allergies are replaced wholesale when supplied (the wizard sends the full list).
  if (input.allergies !== undefined) {
    await db.delete(userAllergies).where(eq(userAllergies.userId, userId));
    const unique = dedupeAllergies(input.allergies);
    if (unique.length) {
      await db.insert(userAllergies).values(
        unique.map((a) => ({
          userId,
          allergen: sanitizeText(a.allergen).toLowerCase().slice(0, 50),
          severity: a.severity,
        })),
      );
    }
  }

  const updated = (await getUserById(userId)) as User;
  if (input.recalculate_targets !== false) {
    await recalculateTargets(userId, updated);
  }

  await invalidateUserCache(userId);
  return getUserDto(userId);
}

function dedupeAllergies(allergies: Array<{ allergen: string; severity: string }>) {
  const seen = new Map<string, { allergen: string; severity: string }>();
  for (const allergy of allergies) {
    const key = sanitizeText(allergy.allergen).toLowerCase().trim();
    if (!key) continue;
    // Keep the most severe declaration if a user lists the same allergen twice.
    const existing = seen.get(key);
    if (!existing || severityRank(allergy.severity) > severityRank(existing.severity)) {
      seen.set(key, { allergen: key, severity: allergy.severity });
    }
  }
  return [...seen.values()];
}

function severityRank(severity: string): number {
  return severity === 'severe' ? 3 : severity === 'moderate' ? 2 : 1;
}

/** Recompute macro targets from the stored profile and persist them. */
export async function recalculateTargets(userId: string, user: User): Promise<NutritionTargetsInput> {
  const db = getDb();
  const targets = calculateNutritionTargets({
    gender: user.gender,
    heightCm: user.heightCm,
    weightKg: user.weightKg,
    dateOfBirth: user.dateOfBirth,
    healthGoal: user.healthGoal,
    activityLevel: user.activityLevel,
  });

  await db
    .update(users)
    .set({
      dailyCalorieTarget: targets.dailyCalorieTarget,
      dailyProteinTargetG: targets.dailyProteinTargetG,
      dailyCarbsTargetG: targets.dailyCarbsTargetG,
      dailyFatTargetG: targets.dailyFatTargetG,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  await invalidateUserCache(userId);

  return {
    daily_calorie_target: targets.dailyCalorieTarget,
    daily_protein_target_g: targets.dailyProteinTargetG,
    daily_carbs_target_g: targets.dailyCarbsTargetG,
    daily_fat_target_g: targets.dailyFatTargetG,
  };
}

export async function addAllergy(userId: string, allergen: string, severity = 'moderate'): Promise<UserAllergy> {
  const db = getDb();
  const clean = sanitizeText(allergen).toLowerCase().trim().slice(0, 50);
  if (!clean) throw new ConflictError('Allergen name is required');

  const rows = await db
    .insert(userAllergies)
    .values({ userId, allergen: clean, severity })
    .onConflictDoUpdate({ target: [userAllergies.userId, userAllergies.allergen], set: { severity } })
    .returning();

  await invalidateUserCache(userId);
  return rows[0] as UserAllergy;
}

export async function removeAllergy(userId: string, allergyId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .delete(userAllergies)
    .where(and(eq(userAllergies.id, allergyId), eq(userAllergies.userId, userId)))
    .returning({ id: userAllergies.id });
  if (!rows.length) throw new NotFoundError('Allergy not found');
  await invalidateUserCache(userId);
}

/** Update the avatar URL after an upload. */
export async function setAvatarUrl(userId: string, avatarUrl: string): Promise<UserDto> {
  const db = getDb();
  await db.update(users).set({ avatarUrl, updatedAt: new Date() }).where(eq(users.id, userId));
  await invalidateUserCache(userId);
  return getUserDto(userId);
}

/** Touch `last_active_at` (drives the smart-suggestion push rule). */
export async function touchLastActive(userId: string): Promise<void> {
  const db = getDb();
  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId)).catch(() => undefined);
}

/** Soft-delete the account and cascade its data (GDPR "delete my data"). */
export async function deleteAccount(userId: string): Promise<void> {
  const db = getDb();
  const rows = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  if (!rows.length) throw new NotFoundError('User not found');
  await invalidateUserCache(userId);
}

/** Bulk-fetch several users (household/admin views). */
export async function getUsersByIds(ids: string[]): Promise<User[]> {
  if (!ids.length) return [];
  const db = getDb();
  return db.select().from(users).where(inArray(users.id, ids));
}

async function invalidateUserCache(userId: string): Promise<void> {
  await Promise.all([cache.del(CacheKeys.pantry(userId)), cache.del(CacheKeys.session(userId))]);
}

function toDateString(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
