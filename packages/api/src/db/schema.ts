/**
 * PlateMatch — PostgreSQL schema (Drizzle ORM)
 * ===========================================================================
 * Mirrors Section 3 of the product specification 1:1, plus a handful of
 * supporting tables the spec's endpoints require (refresh-token rotation,
 * password resets, the in-app notification inbox, multi-device push tokens,
 * cook history, per-user AI usage counters and households for the Family tier).
 *
 * Every foreign key is indexed and every frequently-filtered column has an
 * index (Section 8 — Performance).
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

export const dietaryPrefEnum = pgEnum('dietary_pref', [
  'none',
  'vegetarian',
  'vegan',
  'pescatarian',
  'keto',
  'paleo',
  'mediterranean',
  'halal',
  'kosher',
  'low_fodmap',
  'carnivore',
]);

export const healthGoalEnum = pgEnum('health_goal', [
  'lose_weight',
  'gain_muscle',
  'maintain',
  'eat_healthy',
  'manage_diabetes',
]);

export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
]);

export const ingredientCategoryEnum = pgEnum('ingredient_category', [
  'vegetable',
  'fruit',
  'dairy',
  'meat',
  'seafood',
  'grain',
  'spice',
  'condiment',
  'beverage',
  'snack',
  'frozen',
  'canned',
  'bakery',
  'legume',
  'nut_seed',
  'oil_fat',
  'sweetener',
  'other',
]);

export const mealTypeEnum = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack']);

export const difficultyLevelEnum = pgEnum('difficulty_level', ['easy', 'medium', 'hard']);

export const wasteReasonEnum = pgEnum('waste_reason', [
  'expired',
  'spoiled',
  'leftover',
  'overcooked',
  'didnt_like',
  'other',
]);

export const scanSourceEnum = pgEnum('scan_source', ['camera', 'gallery', 'manual']);

export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'premium', 'family']);

export const freshnessEnum = pgEnum('freshness_level', ['fresh', 'ripening', 'overripe', 'spoiled']);

export const storageLocationEnum = pgEnum('storage_location', ['fridge', 'pantry', 'freezer']);

export const cookingSkillEnum = pgEnum('cooking_skill', ['beginner', 'intermediate', 'advanced']);

export const notificationTypeEnum = pgEnum('notification_type', [
  'expiry_alert',
  'meal_reminder',
  'weekly_report',
  'smart_suggestion',
  'achievement',
  'scan_complete',
  'system',
]);

export const scanStatusEnum = pgEnum('scan_status', ['queued', 'processing', 'completed', 'failed']);

export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'apple']);

export const householdRoleEnum = pgEnum('household_role', ['owner', 'adult', 'teen', 'child']);

// ---------------------------------------------------------------------------
// HOUSEHOLDS (Phase 4 — Family tier shared pantry)
// ---------------------------------------------------------------------------

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  ownerUserId: uuid('owner_user_id').notNull(),
  maxMembers: smallint('max_members').notNull().default(6),
  inviteCode: varchar('invite_code', { length: 12 }).unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  'household_members',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: householdRoleEnum('role').notNull().default('adult'),
    nickname: varchar('nickname', { length: 60 }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] }), index('idx_household_members_user').on(t.userId)],
);

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    /** Null when the account was created through OAuth only. */
    passwordHash: varchar('password_hash', { length: 255 }),
    fullName: varchar('full_name', { length: 100 }).notNull(),
    avatarUrl: text('avatar_url'),
    dateOfBirth: date('date_of_birth'),
    gender: varchar('gender', { length: 20 }),
    heightCm: decimal('height_cm', { precision: 5, scale: 1, mode: 'number' }).$type<number>(),
    weightKg: decimal('weight_kg', { precision: 5, scale: 1, mode: 'number' }).$type<number>(),
    healthGoal: healthGoalEnum('health_goal').notNull().default('eat_healthy'),
    activityLevel: activityLevelEnum('activity_level').notNull().default('moderate'),
    dietaryPreference: dietaryPrefEnum('dietary_preference').notNull().default('none'),
    familySize: smallint('family_size').notNull().default(1),
    weeklyBudget: decimal('weekly_budget', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    /** Auto-calculated from the profile via the Mifflin–St Jeor equation. */
    dailyCalorieTarget: integer('daily_calorie_target'),
    dailyProteinTargetG: integer('daily_protein_target_g'),
    dailyCarbsTargetG: integer('daily_carbs_target_g'),
    dailyFatTargetG: integer('daily_fat_target_g'),
    cookingSkillLevel: cookingSkillEnum('cooking_skill_level').notNull().default('beginner'),
    preferredCuisines: text('preferred_cuisines').array().notNull().default(sql`'{}'::text[]`),
    maxCookingTimeMin: integer('max_cooking_time_min').notNull().default(45),
    onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
    subscriptionTier: subscriptionTierEnum('subscription_tier').notNull().default('free'),
    subscriptionExpiresAt: timestamp('subscription_expires_at', { withTimezone: true }),
    subscriptionStatus: varchar('subscription_status', { length: 20 }).notNull().default('none'),
    subscriptionInterval: varchar('subscription_interval', { length: 10 }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    trialUsed: boolean('trial_used').notNull().default(false),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    householdId: uuid('household_id').references(() => households.id, { onDelete: 'set null' }),
    /** Last time the app was opened — drives the "smart suggestion" push rule. */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    emailVerified: boolean('email_verified').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('idx_users_household').on(t.householdId),
    index('idx_users_subscription').on(t.subscriptionTier),
    index('idx_users_last_active').on(t.lastActiveAt),
  ],
);

export const userAllergies = pgTable(
  'user_allergies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    allergen: varchar('allergen', { length: 50 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull().default('moderate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_user_allergen').on(t.userId, t.allergen),
    index('idx_user_allergies_user').on(t.userId),
  ],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    rawProfile: jsonb('raw_profile'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_oauth_provider_account').on(t.provider, t.providerAccountId),
    index('idx_oauth_accounts_user').on(t.userId),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the issued token — the raw value is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedFromId: uuid('rotated_from_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_refresh_token_hash').on(t.tokenHash),
    index('idx_refresh_tokens_user').on(t.userId),
    index('idx_refresh_tokens_family').on(t.familyId),
    index('idx_refresh_tokens_expires').on(t.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_password_reset_hash').on(t.tokenHash), index('idx_password_reset_user').on(t.userId)],
);

export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Expo push token or FCM registration token. */
    pushToken: text('push_token').notNull(),
    platform: varchar('platform', { length: 20 }).notNull().default('android'),
    deviceName: varchar('device_name', { length: 100 }),
    appVersion: varchar('app_version', { length: 30 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_user_device_token').on(t.userId, t.pushToken),
    index('idx_user_devices_user').on(t.userId),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiryAlerts: boolean('expiry_alerts').notNull().default(true),
    mealReminders: boolean('meal_reminders').notNull().default(true),
    weeklyReports: boolean('weekly_reports').notNull().default(true),
    smartSuggestions: boolean('smart_suggestions').notNull().default(true),
    achievementAlerts: boolean('achievement_alerts').notNull().default(true),
    reminderBreakfastTime: varchar('reminder_breakfast_time', { length: 5 }).notNull().default('07:30'),
    reminderLunchTime: varchar('reminder_lunch_time', { length: 5 }).notNull().default('12:00'),
    reminderDinnerTime: varchar('reminder_dinner_time', { length: 5 }).notNull().default('18:30'),
    digestHour: smallint('digest_hour').notNull().default(9),
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }),
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),
    /** Kept for backwards compatibility with the spec's single-token column. */
    fcmToken: text('fcm_token'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_notification_prefs_user').on(t.userId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    deepLink: text('deep_link'),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    /** 'push' = delivered through FCM/Expo, 'inbox' = stored only. */
    channel: varchar('channel', { length: 10 }).notNull().default('push'),
    deliveryStatus: varchar('delivery_status', { length: 20 }).notNull().default('pending'),
    deliveryError: text('delivery_error'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_notifications_user_created').on(t.userId, t.createdAt),
    index('idx_notifications_unread').on(t.userId, t.readAt),
  ],
);

// ---------------------------------------------------------------------------
// PANTRY & SCANNING
// ---------------------------------------------------------------------------

export const pantryItems = pgTable(
  'pantry_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Shared households see each other's items through this flag. */
    householdId: uuid('household_id').references(() => households.id, { onDelete: 'set null' }),
    ingredientName: varchar('ingredient_name', { length: 100 }).notNull(),
    /** Lower-cased, de-pluralised key used for fuzzy matching against recipes. */
    normalizedKey: varchar('normalized_key', { length: 100 }).notNull(),
    category: ingredientCategoryEnum('category').notNull().default('other'),
    quantity: decimal('quantity', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    unit: varchar('unit', { length: 20 }),
    expiryDate: date('expiry_date'),
    purchaseDate: date('purchase_date'),
    addedVia: scanSourceEnum('added_via').notNull().default('manual'),
    aiConfidence: decimal('ai_confidence', { precision: 3, scale: 2, mode: 'number' }).$type<number>(),
    photoUrl: text('photo_url'),
    barcode: varchar('barcode', { length: 50 }),
    freshness: freshnessEnum('freshness').notNull().default('fresh'),
    isExpired: boolean('is_expired').notNull().default(false),
    isUsed: boolean('is_used').notNull().default(false),
    location: storageLocationEnum('location').notNull().default('fridge'),
    /** Scan this item originated from (null for manual entries). */
    scanId: uuid('scan_id').references(() => fridgeScans.id, { onDelete: 'set null' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_pantry_user').on(t.userId),
    index('idx_pantry_expiry').on(t.expiryDate),
    index('idx_pantry_category').on(t.category),
    index('idx_pantry_user_location').on(t.userId, t.location),
    index('idx_pantry_normalized_key').on(t.normalizedKey),
    index('idx_pantry_household').on(t.householdId),
    index('idx_pantry_active').on(t.userId, t.isUsed, t.isExpired),
  ],
);

export const fridgeScans = pgTable(
  'fridge_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    photoUrl: text('photo_url'),
    /** Public URL of the compressed derivative used by the AI call. */
    compressedUrl: text('compressed_url'),
    storageKey: varchar('storage_key', { length: 400 }),
    status: scanStatusEnum('status').notNull().default('queued'),
    progress: smallint('progress').notNull().default(0),
    aiModelUsed: varchar('ai_model_used', { length: 50 }),
    /** All models attempted, with latency + cost (see ScanPipelineResult). */
    modelsTried: jsonb('models_tried').notNull().default(sql`'[]'::jsonb`),
    aiRawResponse: jsonb('ai_raw_response'),
    detectedItems: jsonb('detected_items').notNull().default(sql`'[]'::jsonb`),
    overallFridgeStatus: text('overall_fridge_status'),
    suggestions: jsonb('suggestions').notNull().default(sql`'[]'::jsonb`),
    itemsConfirmedCount: integer('items_confirmed_count').notNull().default(0),
    itemsCorrectedCount: integer('items_corrected_count').notNull().default(0),
    itemsRemovedCount: integer('items_removed_count').notNull().default(0),
    itemsAddedCount: integer('items_added_count').notNull().default(0),
    processingTimeMs: integer('processing_time_ms'),
    apiCostUsd: decimal('api_cost_usd', { precision: 6, scale: 4, mode: 'number' }).$type<number>().notNull().default(0),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),
    /** Perceptual hash used to deduplicate identical scan requests. */
    imageHash: varchar('image_hash', { length: 64 }),
    source: scanSourceEnum('source').notNull().default('camera'),
    errorMessage: text('error_message'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_scans_user_created').on(t.userId, t.createdAt),
    index('idx_scans_status').on(t.status),
    index('idx_scans_image_hash').on(t.imageHash),
  ],
);

// ---------------------------------------------------------------------------
// RECIPES
// ---------------------------------------------------------------------------

export const recipes = pgTable(
  'recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Recipes generated for a specific user are private; curated ones are null. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    cuisine: varchar('cuisine', { length: 50 }),
    mealType: mealTypeEnum('meal_type'),
    difficulty: difficultyLevelEnum('difficulty').notNull().default('easy'),
    prepTimeMin: integer('prep_time_min'),
    cookTimeMin: integer('cook_time_min'),
    totalTimeMin: integer('total_time_min'),
    servings: integer('servings').notNull().default(2),
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),
    source: varchar('source', { length: 20 }).notNull().default('ai_generated'),
    aiModelUsed: varchar('ai_model_used', { length: 50 }),
    /** SHA-256 of the normalised prompt — used for deduplication/caching. */
    aiPromptHash: varchar('ai_prompt_hash', { length: 64 }),
    totalCostEstimate: decimal('total_cost_estimate', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    ratingAvg: decimal('rating_avg', { precision: 2, scale: 1, mode: 'number' }).$type<number>().notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    timesCooked: integer('times_cooked').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    /** Set to false for private per-user generations so they stay out of search. */
    isPublic: boolean('is_public').notNull().default(true),
    /** Free-text search vector built from title/description/tags/cuisine. */
    searchBlob: text('search_blob'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Dietary tags derived from ingredients (vegan, gluten-free, …). */
    dietTags: text('diet_tags').array().notNull().default(sql`'{}'::text[]`),
    allergenWarnings: text('allergen_warnings').array().notNull().default(sql`'{}'::text[]`),
    storageInstructions: text('storage_instructions'),
    reheatingInstructions: text('reheating_instructions'),
    /** Ingredients that can be safely omitted for a "pantry-only" variant. */
    usesExpiringFriendly: boolean('uses_expiring_friendly').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_recipes_cuisine').on(t.cuisine),
    index('idx_recipes_difficulty').on(t.difficulty),
    index('idx_recipes_rating').on(t.ratingAvg),
    index('idx_recipes_owner').on(t.ownerId),
    index('idx_recipes_public').on(t.isPublic, t.isFeatured),
    index('idx_recipes_meal_type').on(t.mealType),
    index('idx_recipes_total_time').on(t.totalTimeMin),
    index('idx_recipes_created').on(t.createdAt),
  ],
);

export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    ingredientName: varchar('ingredient_name', { length: 100 }).notNull(),
    normalizedKey: varchar('normalized_key', { length: 100 }).notNull(),
    quantity: decimal('quantity', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    unit: varchar('unit', { length: 20 }),
    isOptional: boolean('is_optional').notNull().default(false),
    substitutes: text('substitutes').array().notNull().default(sql`'{}'::text[]`),
    category: ingredientCategoryEnum('category'),
    /** Approx. USD per unit — drives cost estimates and grocery totals. */
    unitPriceUsd: decimal('unit_price_usd', { precision: 8, scale: 4, mode: 'number' }).$type<number>(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('idx_recipe_ingredients_recipe').on(t.recipeId),
    index('idx_recipe_ingredients_key').on(t.normalizedKey),
  ],
);

export const recipeSteps = pgTable(
  'recipe_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number').notNull(),
    instruction: text('instruction').notNull(),
    durationMin: integer('duration_min'),
    tip: text('tip'),
    imageUrl: text('image_url'),
  },
  (t) => [uniqueIndex('uq_recipe_step').on(t.recipeId, t.stepNumber), index('idx_recipe_steps_recipe').on(t.recipeId)],
);

export const recipeNutrition = pgTable(
  'recipe_nutrition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .unique()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    calories: decimal('calories', { precision: 7, scale: 1, mode: 'number' }).$type<number>(),
    proteinG: decimal('protein_g', { precision: 6, scale: 1, mode: 'number' }).$type<number>(),
    carbsG: decimal('carbs_g', { precision: 6, scale: 1, mode: 'number' }).$type<number>(),
    fatG: decimal('fat_g', { precision: 6, scale: 1, mode: 'number' }).$type<number>(),
    fiberG: decimal('fiber_g', { precision: 5, scale: 1, mode: 'number' }).$type<number>(),
    sugarG: decimal('sugar_g', { precision: 5, scale: 1, mode: 'number' }).$type<number>(),
    sodiumMg: decimal('sodium_mg', { precision: 7, scale: 1, mode: 'number' }).$type<number>(),
    cholesterolMg: decimal('cholesterol_mg', { precision: 6, scale: 1, mode: 'number' }).$type<number>(),
    saturatedFatG: decimal('saturated_fat_g', { precision: 5, scale: 1, mode: 'number' }).$type<number>(),
    vitaminAPct: decimal('vitamin_a_pct', { precision: 4, scale: 1, mode: 'number' }).$type<number>(),
    vitaminCPct: decimal('vitamin_c_pct', { precision: 4, scale: 1, mode: 'number' }).$type<number>(),
    calciumPct: decimal('calcium_pct', { precision: 4, scale: 1, mode: 'number' }).$type<number>(),
    ironPct: decimal('iron_pct', { precision: 4, scale: 1, mode: 'number' }).$type<number>(),
    potassiumMg: decimal('potassium_mg', { precision: 7, scale: 1, mode: 'number' }).$type<number>(),
    /** 'ai' = model estimate, 'edamam' = verified via the Nutrition Analysis API. */
    source: varchar('source', { length: 20 }).notNull().default('ai'),
    perServing: boolean('per_serving').notNull().default(true),
  },
  (t) => [index('idx_recipe_nutrition_recipe').on(t.recipeId)],
);

export const recipeRatings = pgTable(
  'recipe_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    reviewText: text('review_text'),
    photoUrl: text('photo_url'),
    helpfulCount: integer('helpful_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_recipe_rating_user').on(t.recipeId, t.userId),
    check('rating_range', sql`rating >= 1 AND rating <= 5`),
    index('idx_recipe_ratings_recipe').on(t.recipeId),
    index('idx_recipe_ratings_user').on(t.userId),
  ],
);

export const userFavorites = pgTable(
  'user_favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_user_favorite').on(t.userId, t.recipeId),
    index('idx_user_favorites_user').on(t.userId),
  ],
);

/** Every time the user presses "Start Cooking" → complete. Powers /recipes/history. */
export const recipeCookLog = pgTable(
  'recipe_cook_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    servingsCooked: integer('servings_cooked').notNull().default(2),
    rating: smallint('rating'),
    notes: text('notes'),
    source: varchar('source', { length: 30 }).notNull().default('recipe_detail'),
    mealPlanEntryId: uuid('meal_plan_entry_id'),
    cookedAt: timestamp('cooked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_cook_log_user_time').on(t.userId, t.cookedAt),
    index('idx_cook_log_recipe').on(t.recipeId),
  ],
);

// ---------------------------------------------------------------------------
// MEAL PLANS
// ---------------------------------------------------------------------------

export const mealPlans = pgTable(
  'meal_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** User-visible plan name, e.g. "Week of 12 May". */
    name: varchar('name', { length: 120 }).notNull().default('Weekly Meal Plan'),
    weekStartDate: date('week_start_date').notNull(),
    weekEndDate: date('week_end_date').notNull(),
    servings: smallint('servings').notNull().default(2),
    dietaryPreference: dietaryPrefEnum('dietary_preference'),
    /** Per-day grocery budget the planner optimises against. */
    budgetPerDay: decimal('budget_per_day', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    totalCalories: decimal('total_calories', { precision: 8, scale: 1, mode: 'number' }).$type<number>(),
    totalCostEstimate: decimal('total_cost_estimate', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    dailyCalorieTarget: integer('daily_calorie_target'),
    averageDailyCalories: integer('average_daily_calories'),
    /** { calories, protein_g, carbs_g, fat_g, fiber_g, cost_usd } for the week. */
    weeklyTotals: jsonb('weekly_totals').notNull().default(sql`'{}'::jsonb`),
    /** Nutritionist notes returned by the model ("high in fibre on Mon/Tue", …). */
    optimizationNotes: jsonb('optimization_notes').notNull().default(sql`'[]'::jsonb`),
    aiModelUsed: varchar('ai_model_used', { length: 50 }),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    /** Denormalised pointer to the derived grocery list (no FK: avoids a cycle). */
    groceryListId: uuid('grocery_list_id'),
    /** Extra AI metadata: tips, prep suggestions, pantry usage. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_meal_plans_user').on(t.userId),
    index('idx_meal_plans_user_week').on(t.userId, t.weekStartDate),
    index('idx_meal_plans_status').on(t.status),
  ],
);

export const mealPlanEntries = pgTable(
  'meal_plan_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mealPlanId: uuid('meal_plan_id')
      .notNull()
      .references(() => mealPlans.id, { onDelete: 'cascade' }),
    recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
    /** 1 = Monday … 7 = Sunday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    /** Concrete calendar date, derived from the plan's week start. */
    date: date('date'),
    mealType: mealTypeEnum('meal_type').notNull(),
    servings: integer('servings').notNull().default(2),
    actualServings: integer('actual_servings'),
    isCompleted: boolean('is_completed').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    userNotes: text('user_notes'),
    /** Calories snapshotted from the recipe at plan-generation time. */
    calories: decimal('calories', { precision: 7, scale: 1, mode: 'number' }).$type<number>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_meal_plan_entries_plan').on(t.mealPlanId),
    index('idx_meal_plan_entries_day').on(t.mealPlanId, t.dayOfWeek),
    index('idx_meal_plan_entries_recipe').on(t.recipeId),
    index('idx_meal_plan_entries_date').on(t.mealPlanId, t.date),
    uniqueIndex('uq_plan_day_meal').on(t.mealPlanId, t.dayOfWeek, t.mealType),
  ],
);

// ---------------------------------------------------------------------------
// GROCERY LISTS
// ---------------------------------------------------------------------------

export const groceryLists = pgTable(
  'grocery_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id').references(() => households.id, { onDelete: 'set null' }),
    mealPlanId: uuid('meal_plan_id').references(() => mealPlans.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 200 }),
    totalEstimatedCost: decimal('total_estimated_cost', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    totalActualCost: decimal('total_actual_cost', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    /** Cheapest-store routing savings, computed at generation time. */
    savingsAmount: decimal('savings_amount', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    /** Store that came out cheapest in the last price comparison. */
    cheapestStore: varchar('cheapest_store', { length: 100 }),
    totalItems: integer('total_items').notNull().default(0),
    totalChecked: integer('total_checked').notNull().default(0),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    pricesFetchedAt: timestamp('prices_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_grocery_lists_user').on(t.userId),
    index('idx_grocery_lists_plan').on(t.mealPlanId),
    index('idx_grocery_lists_status').on(t.userId, t.status),
  ],
);

export const groceryListItems = pgTable(
  'grocery_list_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groceryListId: uuid('grocery_list_id')
      .notNull()
      .references(() => groceryLists.id, { onDelete: 'cascade' }),
    ingredientName: varchar('ingredient_name', { length: 100 }).notNull(),
    normalizedKey: varchar('normalized_key', { length: 100 }).notNull(),
    quantity: decimal('quantity', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    unit: varchar('unit', { length: 20 }),
    category: ingredientCategoryEnum('category'),
    estimatedPrice: decimal('estimated_price', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    cheapestStore: varchar('cheapest_store', { length: 100 }),
    cheapestPrice: decimal('cheapest_price', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    actualPrice: decimal('actual_price', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    /** Line total for the requested quantity, best available price. */
    estimatedCost: decimal('estimated_cost', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    /** Spec name: `checked` — ticking an item off the shopping list. */
    isChecked: boolean('checked').notNull().default(false),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    priceCheckedAt: timestamp('price_checked_at', { withTimezone: true }),
    /** Recipe ids this ingredient was aggregated from. */
    neededForRecipes: uuid('needed_for_recipes').array().notNull().default(sql`'{}'::uuid[]`),
    /** Recipe titles, kept for display without a join. */
    fromRecipes: text('from_recipes').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** [{ store, price, currency, in_stock, url, fetched_at }] */
    storePrices: jsonb('store_prices').notNull().default(sql`'[]'::jsonb`),
    /** True when the pantry already covers this item (shown as "at home"). */
    inPantry: boolean('in_pantry').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('idx_grocery_items_list').on(t.groceryListId),
    index('idx_grocery_items_key').on(t.normalizedKey),
  ],
);

// ---------------------------------------------------------------------------
// FOOD WASTE & GAMIFICATION
// ---------------------------------------------------------------------------

export const foodWasteLogs = pgTable(
  'food_waste_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id').references(() => households.id, { onDelete: 'set null' }),
    ingredientName: varchar('ingredient_name', { length: 100 }).notNull(),
    normalizedKey: varchar('normalized_key', { length: 100 }).notNull(),
    category: ingredientCategoryEnum('category').notNull().default('other'),
    quantity: decimal('quantity', { precision: 8, scale: 2, mode: 'number' }).$type<number>(),
    unit: varchar('unit', { length: 20 }),
    reason: wasteReasonEnum('reason').notNull(),
    /** Normalised mass so CO₂ maths is category-agnostic. */
    grams: integer('grams'),
    estimatedCostUsd: decimal('estimated_cost', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    co2EquivalentKg: decimal('co2_equivalent_kg', { precision: 6, scale: 2, mode: 'number' }).$type<number>(),
    /** False for plate leftovers — waste the user could not have planned around. */
    preventable: boolean('preventable').notNull().default(true),
    photoUrl: text('photo_url'),
    notes: text('notes'),
    pantryItemId: uuid('pantry_item_id').references(() => pantryItems.id, { onDelete: 'set null' }),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_waste_user_time').on(t.userId, t.loggedAt),
    index('idx_waste_reason').on(t.reason),
    index('idx_waste_category').on(t.category),
    index('idx_waste_key').on(t.normalizedKey),
  ],
);

export const userAchievements = pgTable(
  'user_achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    achievementKey: varchar('achievement_key', { length: 50 }).notNull(),
    progress: integer('progress').notNull().default(0),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    notified: boolean('notified').notNull().default(false),
  },
  (t) => [
    uniqueIndex('uq_user_achievement').on(t.userId, t.achievementKey),
    index('idx_achievements_user').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// AI COST / USAGE TRACKING
// ---------------------------------------------------------------------------

/** Rolling usage counters backing the free-tier limits and abuse prevention. */
export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. 'scan:2025-W24', 'recipe:2025-06-16', 'mealplan:2025-06' */
    bucket: varchar('bucket', { length: 60 }).notNull(),
    kind: varchar('kind', { length: 30 }).notNull(),
    count: integer('count').notNull().default(0),
    costUsd: decimal('cost_usd', { precision: 10, scale: 4, mode: 'number' }).$type<number>().notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bucket] }), index('idx_usage_kind').on(t.kind)],
);

/** Append-only AI call ledger — every provider call, success or failure. */
export const aiUsageLogs = pgTable(
  'ai_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'vision' | 'recipe' | 'mealplan' | 'nutrition' | 'prices' */
    task: varchar('task', { length: 30 }).notNull(),
    provider: varchar('provider', { length: 30 }).notNull(),
    model: varchar('model', { length: 60 }).notNull(),
    success: boolean('success').notNull().default(true),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    costUsd: decimal('cost_usd', { precision: 8, scale: 6, mode: 'number' }).$type<number>().notNull().default(0),
    errorCode: varchar('error_code', { length: 60 }),
    refId: uuid('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_ai_usage_user_time').on(t.userId, t.createdAt),
    index('idx_ai_usage_task').on(t.task, t.createdAt),
    index('idx_ai_usage_provider').on(t.provider),
  ],
);

/** Community recipes shared publicly (Phase 4). */
export const recipeShares = pgTable(
  'recipe_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    sharedBy: uuid('shared_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shareSlug: varchar('share_slug', { length: 24 }).notNull(),
    caption: varchar('caption', { length: 280 }),
    views: integer('views').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_share_slug').on(t.shareSlug), index('idx_recipe_shares_recipe').on(t.recipeId)],
);

// ---------------------------------------------------------------------------
// RELATIONS
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  allergies: many(userAllergies),
  pantryItems: many(pantryItems),
  scans: many(fridgeScans),
  recipes: many(recipes),
  mealPlans: many(mealPlans),
  groceryLists: many(groceryLists),
  wasteLogs: many(foodWasteLogs),
  achievements: many(userAchievements),
  favorites: many(userFavorites),
  ratings: many(recipeRatings),
  devices: many(userDevices),
  oauthAccounts: many(oauthAccounts),
  refreshTokens: many(refreshTokens),
  notifications: many(notifications),
  preferences: one(notificationPreferences, { fields: [users.id], references: [notificationPreferences.userId] }),
  household: one(households, { fields: [users.householdId], references: [households.id] }),
}));

export const pantryItemsRelations = relations(pantryItems, ({ one }) => ({
  user: one(users, { fields: [pantryItems.userId], references: [users.id] }),
  scan: one(fridgeScans, { fields: [pantryItems.scanId], references: [fridgeScans.id] }),
}));

export const fridgeScansRelations = relations(fridgeScans, ({ one, many }) => ({
  user: one(users, { fields: [fridgeScans.userId], references: [users.id] }),
  pantryItems: many(pantryItems),
}));

export const recipesRelations = relations(recipes, ({ one, many }) => ({
  owner: one(users, { fields: [recipes.ownerId], references: [users.id] }),
  ingredients: many(recipeIngredients),
  steps: many(recipeSteps),
  nutrition: one(recipeNutrition, { fields: [recipes.id], references: [recipeNutrition.recipeId] }),
  ratings: many(recipeRatings),
  favorites: many(userFavorites),
  mealPlanEntries: many(mealPlanEntries),
}));

export const recipeIngredientsRelations = relations(recipeIngredients, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeIngredients.recipeId], references: [recipes.id] }),
}));

export const recipeStepsRelations = relations(recipeSteps, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeSteps.recipeId], references: [recipes.id] }),
}));

export const recipeNutritionRelations = relations(recipeNutrition, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeNutrition.recipeId], references: [recipes.id] }),
}));

export const mealPlansRelations = relations(mealPlans, ({ one, many }) => ({
  user: one(users, { fields: [mealPlans.userId], references: [users.id] }),
  entries: many(mealPlanEntries),
  groceryLists: many(groceryLists),
}));

export const mealPlanEntriesRelations = relations(mealPlanEntries, ({ one }) => ({
  plan: one(mealPlans, { fields: [mealPlanEntries.mealPlanId], references: [mealPlans.id] }),
  recipe: one(recipes, { fields: [mealPlanEntries.recipeId], references: [recipes.id] }),
}));

export const groceryListsRelations = relations(groceryLists, ({ one, many }) => ({
  user: one(users, { fields: [groceryLists.userId], references: [users.id] }),
  mealPlan: one(mealPlans, { fields: [groceryLists.mealPlanId], references: [mealPlans.id] }),
  items: many(groceryListItems),
}));

export const groceryListItemsRelations = relations(groceryListItems, ({ one }) => ({
  list: one(groceryLists, { fields: [groceryListItems.groceryListId], references: [groceryLists.id] }),
}));

export const foodWasteLogsRelations = relations(foodWasteLogs, ({ one }) => ({
  user: one(users, { fields: [foodWasteLogs.userId], references: [users.id] }),
}));

export const userAchievementsRelations = relations(userAchievements, ({ one }) => ({
  user: one(users, { fields: [userAchievements.userId], references: [users.id] }),
}));

export const recipeRatingsRelations = relations(recipeRatings, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeRatings.recipeId], references: [recipes.id] }),
  user: one(users, { fields: [recipeRatings.userId], references: [users.id] }),
}));

export const userFavoritesRelations = relations(userFavorites, ({ one }) => ({
  recipe: one(recipes, { fields: [userFavorites.recipeId], references: [recipes.id] }),
  user: one(users, { fields: [userFavorites.userId], references: [users.id] }),
}));

export const householdsRelations = relations(households, ({ many }) => ({
  members: many(householdMembers),
}));

export const householdMembersRelations = relations(householdMembers, ({ one }) => ({
  household: one(households, { fields: [householdMembers.householdId], references: [households.id] }),
  user: one(users, { fields: [householdMembers.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserAllergy = typeof userAllergies.$inferSelect;
export type PantryItem = typeof pantryItems.$inferSelect;
export type NewPantryItem = typeof pantryItems.$inferInsert;
export type FridgeScan = typeof fridgeScans.$inferSelect;
export type NewFridgeScan = typeof fridgeScans.$inferInsert;
export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
export type RecipeIngredient = typeof recipeIngredients.$inferSelect;
export type RecipeStep = typeof recipeSteps.$inferSelect;
export type RecipeNutrition = typeof recipeNutrition.$inferSelect;
export type MealPlan = typeof mealPlans.$inferSelect;
export type MealPlanEntry = typeof mealPlanEntries.$inferSelect;
export type GroceryList = typeof groceryLists.$inferSelect;
export type GroceryListItem = typeof groceryListItems.$inferSelect;
export type FoodWasteLog = typeof foodWasteLogs.$inferSelect;
export type UserAchievement = typeof userAchievements.$inferSelect;
export type RecipeRating = typeof recipeRatings.$inferSelect;
export type UserFavorite = typeof userFavorites.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type UserDevice = typeof userDevices.$inferSelect;
export type Household = typeof households.$inferSelect;
export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type UsageCounter = typeof usageCounters.$inferSelect;
export type RecipeCookLog = typeof recipeCookLog.$inferSelect;
