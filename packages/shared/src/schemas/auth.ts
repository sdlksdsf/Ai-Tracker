import { z } from 'zod';
import {
  ACTIVITY_LEVELS,
  COOKING_SKILL_LEVELS,
  CURRENCIES,
  DIETARY_PREFERENCES,
  GENDERS,
  HEALTH_GOALS,
  SUBSCRIPTION_TIERS,
} from '../constants/index.js';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** RFC-5322-ish practical email check (Zod's built-in is fine for our needs). */
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(255);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-zA-Z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  full_name: fullNameSchema,
  /** Optional: lets the client pre-seed onboarding answers at signup. */
  timezone: z.string().max(50).optional(),
  locale: z.string().max(10).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
  /** Expo push token — registered opportunistically on login. */
  fcm_token: z.string().max(500).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refresh_token: z.string().min(10, 'Refresh token is required'),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refresh_token: z.string().min(10).optional(),
});
export type LogoutInput = z.infer<typeof logoutSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10, 'Reset token is required'),
    password: passwordSchema,
    confirm_password: passwordSchema,
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const oauthGoogleSchema = z.object({
  /** Google ID token obtained from expo-auth-session. */
  id_token: z.string().min(20),
  fcm_token: z.string().max(500).optional(),
});
export type OAuthGoogleInput = z.infer<typeof oauthGoogleSchema>;

export const oauthAppleSchema = z.object({
  /** Signed identity token from Apple Sign-In. */
  identity_token: z.string().min(20),
  /** Apple only returns these on the FIRST authorisation — persist them then. */
  full_name: fullNameSchema.optional(),
  email: emailSchema.optional(),
  fcm_token: z.string().max(500).optional(),
});
export type OAuthAppleInput = z.infer<typeof oauthAppleSchema>;

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

export const allergySchema = z.object({
  allergen: z.string().trim().toLowerCase().min(2).max(50),
  severity: z.enum(['mild', 'moderate', 'severe']).default('moderate'),
});
export type AllergyInput = z.infer<typeof allergySchema>;

export const updateProfileSchema = z.object({
  full_name: fullNameSchema.optional(),
  avatar_url: z.string().url().nullish(),
  date_of_birth: z.coerce.date().optional().nullable(),
  gender: z.enum(GENDERS).optional().nullable(),
  height_cm: z.number().min(80).max(250).optional().nullable(),
  weight_kg: z.number().min(25).max(400).optional().nullable(),
  timezone: z.string().max(50).optional(),
  locale: z.string().max(10).optional(),
  cooking_skill_level: z.enum(COOKING_SKILL_LEVELS).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updatePreferencesSchema = z.object({
  health_goal: z.enum(HEALTH_GOALS).optional(),
  activity_level: z.enum(ACTIVITY_LEVELS).optional(),
  dietary_preference: z.enum(DIETARY_PREFERENCES).optional(),
  family_size: z.number().int().min(1).max(12).optional(),
  weekly_budget: z.number().min(0).max(100000).optional().nullable(),
  currency: z.enum(CURRENCIES).optional(),
  preferred_cuisines: z.array(z.string().min(1).max(50)).max(12).optional(),
  max_cooking_time_min: z.number().int().min(5).max(240).optional(),
  allergies: z.array(allergySchema).max(30).optional(),
  onboarding_completed: z.boolean().optional(),
  /** When true, macro targets are recomputed from the updated profile. */
  recalculate_targets: z.boolean().default(true),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/** What a client may send — `recalculate_targets` and the allergy severity
 *  both have server-side defaults. */
export type UpdatePreferencesRequest = z.input<typeof updatePreferencesSchema>;

export const nutritionTargetsSchema = z.object({
  daily_calorie_target: z.number().int().min(800).max(6000),
  daily_protein_target_g: z.number().int().min(10).max(500),
  daily_carbs_target_g: z.number().int().min(0).max(1000),
  daily_fat_target_g: z.number().int().min(0).max(500),
});
export type NutritionTargetsInput = z.infer<typeof nutritionTargetsSchema>;

/**
 * The 7-step onboarding wizard payload. Sent once at the end of onboarding
 * (or progressively — the endpoint is idempotent).
 */
export const onboardingSchema = updatePreferencesSchema
  .extend({
    full_name: fullNameSchema.optional(),
    date_of_birth: z.coerce.date().optional().nullable(),
    gender: z.enum(GENDERS).optional().nullable(),
    height_cm: z.number().min(80).max(250).optional().nullable(),
    weight_kg: z.number().min(25).max(400).optional().nullable(),
    cooking_skill_level: z.enum(COOKING_SKILL_LEVELS).optional(),
  })
  .extend({ onboarding_completed: z.boolean().default(true) });
export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** Client-facing onboarding payload; every field is optional. */
export type OnboardingRequest = z.input<typeof onboardingSchema>;

// ---------------------------------------------------------------------------
// Public user shape (never leaks password_hash / stripe ids)
// ---------------------------------------------------------------------------

export const userAllergyDtoSchema = z.object({
  id: z.string().uuid(),
  allergen: z.string(),
  severity: z.string(),
  created_at: z.string(),
});

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  full_name: z.string(),
  avatar_url: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  gender: z.string().nullable(),
  height_cm: z.number().nullable(),
  weight_kg: z.number().nullable(),
  // Real non-null enum columns. Typing them as loose strings meant a screen
  // could read `user.dietary_preference` but could not feed it back into an
  // update payload without an unsafe cast.
  health_goal: z.enum(HEALTH_GOALS),
  activity_level: z.enum(ACTIVITY_LEVELS),
  dietary_preference: z.enum(DIETARY_PREFERENCES),
  family_size: z.number(),
  weekly_budget: z.number().nullable(),
  currency: z.string(),
  daily_calorie_target: z.number().nullable(),
  daily_protein_target_g: z.number().nullable(),
  daily_carbs_target_g: z.number().nullable(),
  daily_fat_target_g: z.number().nullable(),
  // A real enum column (`cooking_skill_level_enum`) — typing it as a loose
  // string here meant clients could not feed it back into an update payload.
  cooking_skill_level: z.enum(COOKING_SKILL_LEVELS),
  preferred_cuisines: z.array(z.string()),
  max_cooking_time_min: z.number().nullable(),
  onboarding_completed: z.boolean(),
  subscription_tier: z.enum(SUBSCRIPTION_TIERS),
  subscription_expires_at: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  created_at: z.string(),
  allergies: z.array(userAllergyDtoSchema).default([]),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const authSessionSchema = z.object({
  user: userDtoSchema,
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;
