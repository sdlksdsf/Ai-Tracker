CREATE TYPE "public"."activity_level" AS ENUM('sedentary', 'light', 'moderate', 'active', 'very_active');--> statement-breakpoint
CREATE TYPE "public"."cooking_skill" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."dietary_pref" AS ENUM('none', 'vegetarian', 'vegan', 'pescatarian', 'keto', 'paleo', 'mediterranean', 'halal', 'kosher', 'low_fodmap', 'carnivore');--> statement-breakpoint
CREATE TYPE "public"."difficulty_level" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."freshness_level" AS ENUM('fresh', 'ripening', 'overripe', 'spoiled');--> statement-breakpoint
CREATE TYPE "public"."health_goal" AS ENUM('lose_weight', 'gain_muscle', 'maintain', 'eat_healthy', 'manage_diabetes');--> statement-breakpoint
CREATE TYPE "public"."household_role" AS ENUM('owner', 'adult', 'teen', 'child');--> statement-breakpoint
CREATE TYPE "public"."ingredient_category" AS ENUM('vegetable', 'fruit', 'dairy', 'meat', 'seafood', 'grain', 'spice', 'condiment', 'beverage', 'snack', 'frozen', 'canned', 'bakery', 'legume', 'nut_seed', 'oil_fat', 'sweetener', 'other');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner', 'snack');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('expiry_alert', 'meal_reminder', 'weekly_report', 'smart_suggestion', 'achievement', 'scan_complete', 'system');--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'apple');--> statement-breakpoint
CREATE TYPE "public"."scan_source" AS ENUM('camera', 'gallery', 'manual');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."storage_location" AS ENUM('fridge', 'pantry', 'freezer');--> statement-breakpoint
CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'premium', 'family');--> statement-breakpoint
CREATE TYPE "public"."waste_reason" AS ENUM('expired', 'spoiled', 'leftover', 'overcooked', 'didnt_like', 'other');--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"task" varchar(30) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"model" varchar(60) NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"latency_ms" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(8, 6) DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_waste_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"household_id" uuid,
	"ingredient_name" varchar(100) NOT NULL,
	"normalized_key" varchar(100) NOT NULL,
	"category" "ingredient_category" DEFAULT 'other' NOT NULL,
	"quantity" numeric(8, 2),
	"unit" varchar(20),
	"reason" "waste_reason" NOT NULL,
	"grams" integer,
	"estimated_cost" numeric(6, 2),
	"co2_equivalent_kg" numeric(6, 2),
	"preventable" boolean DEFAULT true NOT NULL,
	"photo_url" text,
	"notes" text,
	"pantry_item_id" uuid,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fridge_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_url" text,
	"compressed_url" text,
	"storage_key" varchar(400),
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"progress" smallint DEFAULT 0 NOT NULL,
	"ai_model_used" varchar(50),
	"models_tried" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_raw_response" jsonb,
	"detected_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_fridge_status" text,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items_confirmed_count" integer DEFAULT 0 NOT NULL,
	"items_corrected_count" integer DEFAULT 0 NOT NULL,
	"items_removed_count" integer DEFAULT 0 NOT NULL,
	"items_added_count" integer DEFAULT 0 NOT NULL,
	"processing_time_ms" integer,
	"api_cost_usd" numeric(6, 4) DEFAULT 0 NOT NULL,
	"image_width" integer,
	"image_height" integer,
	"image_hash" varchar(64),
	"source" "scan_source" DEFAULT 'camera' NOT NULL,
	"error_message" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grocery_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grocery_list_id" uuid NOT NULL,
	"ingredient_name" varchar(100) NOT NULL,
	"normalized_key" varchar(100) NOT NULL,
	"quantity" numeric(8, 2),
	"unit" varchar(20),
	"category" "ingredient_category",
	"estimated_price" numeric(6, 2),
	"cheapest_store" varchar(100),
	"cheapest_price" numeric(6, 2),
	"actual_price" numeric(6, 2),
	"estimated_cost" numeric(8, 2),
	"checked" boolean DEFAULT false NOT NULL,
	"purchased_at" timestamp with time zone,
	"price_checked_at" timestamp with time zone,
	"needed_for_recipes" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"from_recipes" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"in_pantry" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grocery_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"household_id" uuid,
	"meal_plan_id" uuid,
	"title" varchar(200),
	"total_estimated_cost" numeric(8, 2),
	"total_actual_cost" numeric(8, 2),
	"savings_amount" numeric(8, 2),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"cheapest_store" varchar(100),
	"total_items" integer DEFAULT 0 NOT NULL,
	"total_checked" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"prices_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "household_role" DEFAULT 'adult' NOT NULL,
	"nickname" varchar(60),
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_id_user_id_pk" PRIMARY KEY("household_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"max_members" smallint DEFAULT 6 NOT NULL,
	"invite_code" varchar(12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "meal_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_plan_id" uuid NOT NULL,
	"recipe_id" uuid,
	"day_of_week" smallint NOT NULL,
	"date" date,
	"meal_type" "meal_type" NOT NULL,
	"servings" integer DEFAULT 2 NOT NULL,
	"actual_servings" integer,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"user_notes" text,
	"calories" numeric(7, 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) DEFAULT 'Weekly Meal Plan' NOT NULL,
	"week_start_date" date NOT NULL,
	"week_end_date" date NOT NULL,
	"servings" smallint DEFAULT 2 NOT NULL,
	"dietary_preference" "dietary_pref",
	"budget_per_day" numeric(8, 2),
	"total_calories" numeric(8, 1),
	"total_cost_estimate" numeric(8, 2),
	"daily_calorie_target" integer,
	"average_daily_calories" integer,
	"weekly_totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"optimization_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_model_used" varchar(50),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"grocery_list_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expiry_alerts" boolean DEFAULT true NOT NULL,
	"meal_reminders" boolean DEFAULT true NOT NULL,
	"weekly_reports" boolean DEFAULT true NOT NULL,
	"smart_suggestions" boolean DEFAULT true NOT NULL,
	"achievement_alerts" boolean DEFAULT true NOT NULL,
	"reminder_breakfast_time" varchar(5) DEFAULT '07:30' NOT NULL,
	"reminder_lunch_time" varchar(5) DEFAULT '12:00' NOT NULL,
	"reminder_dinner_time" varchar(5) DEFAULT '18:30' NOT NULL,
	"digest_hour" smallint DEFAULT 9 NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"fcm_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"deep_link" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel" varchar(10) DEFAULT 'push' NOT NULL,
	"delivery_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"email" varchar(255),
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"raw_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pantry_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"household_id" uuid,
	"ingredient_name" varchar(100) NOT NULL,
	"normalized_key" varchar(100) NOT NULL,
	"category" "ingredient_category" DEFAULT 'other' NOT NULL,
	"quantity" numeric(8, 2),
	"unit" varchar(20),
	"expiry_date" date,
	"purchase_date" date,
	"added_via" "scan_source" DEFAULT 'manual' NOT NULL,
	"ai_confidence" numeric(3, 2),
	"photo_url" text,
	"barcode" varchar(50),
	"freshness" "freshness_level" DEFAULT 'fresh' NOT NULL,
	"is_expired" boolean DEFAULT false NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"location" "storage_location" DEFAULT 'fridge' NOT NULL,
	"scan_id" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_cook_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"servings_cooked" integer DEFAULT 2 NOT NULL,
	"rating" smallint,
	"notes" text,
	"source" varchar(30) DEFAULT 'recipe_detail' NOT NULL,
	"meal_plan_entry_id" uuid,
	"cooked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"ingredient_name" varchar(100) NOT NULL,
	"normalized_key" varchar(100) NOT NULL,
	"quantity" numeric(8, 2),
	"unit" varchar(20),
	"is_optional" boolean DEFAULT false NOT NULL,
	"substitutes" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" "ingredient_category",
	"unit_price_usd" numeric(8, 4),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_nutrition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"calories" numeric(7, 1),
	"protein_g" numeric(6, 1),
	"carbs_g" numeric(6, 1),
	"fat_g" numeric(6, 1),
	"fiber_g" numeric(5, 1),
	"sugar_g" numeric(5, 1),
	"sodium_mg" numeric(7, 1),
	"cholesterol_mg" numeric(6, 1),
	"saturated_fat_g" numeric(5, 1),
	"vitamin_a_pct" numeric(4, 1),
	"vitamin_c_pct" numeric(4, 1),
	"calcium_pct" numeric(4, 1),
	"iron_pct" numeric(4, 1),
	"potassium_mg" numeric(7, 1),
	"source" varchar(20) DEFAULT 'ai' NOT NULL,
	"per_serving" boolean DEFAULT true NOT NULL,
	CONSTRAINT "recipe_nutrition_recipe_id_unique" UNIQUE("recipe_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"review_text" text,
	"photo_url" text,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_range" CHECK (rating >= 1 AND rating <= 5)
);
--> statement-breakpoint
CREATE TABLE "recipe_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"shared_by" uuid NOT NULL,
	"share_slug" varchar(24) NOT NULL,
	"caption" varchar(280),
	"views" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"instruction" text NOT NULL,
	"duration_min" integer,
	"tip" text,
	"image_url" text
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"title" varchar(200) NOT NULL,
	"description" text,
	"cuisine" varchar(50),
	"meal_type" "meal_type",
	"difficulty" "difficulty_level" DEFAULT 'easy' NOT NULL,
	"prep_time_min" integer,
	"cook_time_min" integer,
	"total_time_min" integer,
	"servings" integer DEFAULT 2 NOT NULL,
	"image_url" text,
	"video_url" text,
	"source" varchar(20) DEFAULT 'ai_generated' NOT NULL,
	"ai_model_used" varchar(50),
	"ai_prompt_hash" varchar(64),
	"total_cost_estimate" numeric(6, 2),
	"rating_avg" numeric(2, 1) DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"times_cooked" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"search_blob" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"diet_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergen_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"storage_instructions" text,
	"reheating_instructions" text,
	"uses_expiring_friendly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_from_id" uuid,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"user_id" uuid NOT NULL,
	"bucket" varchar(60) NOT NULL,
	"kind" varchar(30) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_user_id_bucket_pk" PRIMARY KEY("user_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_key" varchar(50) NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_allergies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"allergen" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'moderate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"push_token" text NOT NULL,
	"platform" varchar(20) DEFAULT 'android' NOT NULL,
	"device_name" varchar(100),
	"app_version" varchar(30),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"full_name" varchar(100) NOT NULL,
	"avatar_url" text,
	"date_of_birth" date,
	"gender" varchar(20),
	"height_cm" numeric(5, 1),
	"weight_kg" numeric(5, 1),
	"health_goal" "health_goal" DEFAULT 'eat_healthy' NOT NULL,
	"activity_level" "activity_level" DEFAULT 'moderate' NOT NULL,
	"dietary_preference" "dietary_pref" DEFAULT 'none' NOT NULL,
	"family_size" smallint DEFAULT 1 NOT NULL,
	"weekly_budget" numeric(8, 2),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"daily_calorie_target" integer,
	"daily_protein_target_g" integer,
	"daily_carbs_target_g" integer,
	"daily_fat_target_g" integer,
	"cooking_skill_level" "cooking_skill" DEFAULT 'beginner' NOT NULL,
	"preferred_cuisines" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_cooking_time_min" integer DEFAULT 45 NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"subscription_tier" "subscription_tier" DEFAULT 'free' NOT NULL,
	"subscription_expires_at" timestamp with time zone,
	"subscription_status" varchar(20) DEFAULT 'none' NOT NULL,
	"subscription_interval" varchar(10),
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_used" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" varchar(255),
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"household_id" uuid,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_waste_logs" ADD CONSTRAINT "food_waste_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_waste_logs" ADD CONSTRAINT "food_waste_logs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_waste_logs" ADD CONSTRAINT "food_waste_logs_pantry_item_id_pantry_items_id_fk" FOREIGN KEY ("pantry_item_id") REFERENCES "public"."pantry_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fridge_scans" ADD CONSTRAINT "fridge_scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list_items" ADD CONSTRAINT "grocery_list_items_grocery_list_id_grocery_lists_id_fk" FOREIGN KEY ("grocery_list_id") REFERENCES "public"."grocery_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_lists" ADD CONSTRAINT "grocery_lists_meal_plan_id_meal_plans_id_fk" FOREIGN KEY ("meal_plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_meal_plan_id_meal_plans_id_fk" FOREIGN KEY ("meal_plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_scan_id_fridge_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."fridge_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cook_log" ADD CONSTRAINT "recipe_cook_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_cook_log" ADD CONSTRAINT "recipe_cook_log_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_nutrition" ADD CONSTRAINT "recipe_nutrition_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_shares" ADD CONSTRAINT "recipe_shares_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_shares" ADD CONSTRAINT "recipe_shares_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_allergies" ADD CONSTRAINT "user_allergies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user_time" ON "ai_usage_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_task" ON "ai_usage_logs" USING btree ("task","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_provider" ON "ai_usage_logs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_waste_user_time" ON "food_waste_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX "idx_waste_reason" ON "food_waste_logs" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "idx_waste_category" ON "food_waste_logs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_waste_key" ON "food_waste_logs" USING btree ("normalized_key");--> statement-breakpoint
CREATE INDEX "idx_scans_user_created" ON "fridge_scans" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scans_status" ON "fridge_scans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_scans_image_hash" ON "fridge_scans" USING btree ("image_hash");--> statement-breakpoint
CREATE INDEX "idx_grocery_items_list" ON "grocery_list_items" USING btree ("grocery_list_id");--> statement-breakpoint
CREATE INDEX "idx_grocery_items_key" ON "grocery_list_items" USING btree ("normalized_key");--> statement-breakpoint
CREATE INDEX "idx_grocery_lists_user" ON "grocery_lists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_grocery_lists_plan" ON "grocery_lists" USING btree ("meal_plan_id");--> statement-breakpoint
CREATE INDEX "idx_grocery_lists_status" ON "grocery_lists" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_household_members_user" ON "household_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_meal_plan_entries_plan" ON "meal_plan_entries" USING btree ("meal_plan_id");--> statement-breakpoint
CREATE INDEX "idx_meal_plan_entries_day" ON "meal_plan_entries" USING btree ("meal_plan_id","day_of_week");--> statement-breakpoint
CREATE INDEX "idx_meal_plan_entries_recipe" ON "meal_plan_entries" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_meal_plan_entries_date" ON "meal_plan_entries" USING btree ("meal_plan_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plan_day_meal" ON "meal_plan_entries" USING btree ("meal_plan_id","day_of_week","meal_type");--> statement-breakpoint
CREATE INDEX "idx_meal_plans_user" ON "meal_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_meal_plans_user_week" ON "meal_plans" USING btree ("user_id","week_start_date");--> statement-breakpoint
CREATE INDEX "idx_meal_plans_status" ON "meal_plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notification_prefs_user" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_unread" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_provider_account" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_accounts_user" ON "oauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pantry_user" ON "pantry_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pantry_expiry" ON "pantry_items" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "idx_pantry_category" ON "pantry_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_pantry_user_location" ON "pantry_items" USING btree ("user_id","location");--> statement-breakpoint
CREATE INDEX "idx_pantry_normalized_key" ON "pantry_items" USING btree ("normalized_key");--> statement-breakpoint
CREATE INDEX "idx_pantry_household" ON "pantry_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_pantry_active" ON "pantry_items" USING btree ("user_id","is_used","is_expired");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_password_reset_hash" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_password_reset_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_cook_log_user_time" ON "recipe_cook_log" USING btree ("user_id","cooked_at");--> statement-breakpoint
CREATE INDEX "idx_cook_log_recipe" ON "recipe_cook_log" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_recipe_ingredients_recipe" ON "recipe_ingredients" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_recipe_ingredients_key" ON "recipe_ingredients" USING btree ("normalized_key");--> statement-breakpoint
CREATE INDEX "idx_recipe_nutrition_recipe" ON "recipe_nutrition" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recipe_rating_user" ON "recipe_ratings" USING btree ("recipe_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_recipe_ratings_recipe" ON "recipe_ratings" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_recipe_ratings_user" ON "recipe_ratings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_share_slug" ON "recipe_shares" USING btree ("share_slug");--> statement-breakpoint
CREATE INDEX "idx_recipe_shares_recipe" ON "recipe_shares" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recipe_step" ON "recipe_steps" USING btree ("recipe_id","step_number");--> statement-breakpoint
CREATE INDEX "idx_recipe_steps_recipe" ON "recipe_steps" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "idx_recipes_cuisine" ON "recipes" USING btree ("cuisine");--> statement-breakpoint
CREATE INDEX "idx_recipes_difficulty" ON "recipes" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "idx_recipes_rating" ON "recipes" USING btree ("rating_avg");--> statement-breakpoint
CREATE INDEX "idx_recipes_owner" ON "recipes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_recipes_public" ON "recipes" USING btree ("is_public","is_featured");--> statement-breakpoint
CREATE INDEX "idx_recipes_meal_type" ON "recipes" USING btree ("meal_type");--> statement-breakpoint
CREATE INDEX "idx_recipes_total_time" ON "recipes" USING btree ("total_time_min");--> statement-breakpoint
CREATE INDEX "idx_recipes_created" ON "recipes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refresh_token_hash" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_usage_kind" ON "usage_counters" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_achievement" ON "user_achievements" USING btree ("user_id","achievement_key");--> statement-breakpoint
CREATE INDEX "idx_achievements_user" ON "user_achievements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_allergen" ON "user_allergies" USING btree ("user_id","allergen");--> statement-breakpoint
CREATE INDEX "idx_user_allergies_user" ON "user_allergies" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_device_token" ON "user_devices" USING btree ("user_id","push_token");--> statement-breakpoint
CREATE INDEX "idx_user_devices_user" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_favorite" ON "user_favorites" USING btree ("user_id","recipe_id");--> statement-breakpoint
CREATE INDEX "idx_user_favorites_user" ON "user_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_users_household" ON "users" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_users_subscription" ON "users" USING btree ("subscription_tier");--> statement-breakpoint
CREATE INDEX "idx_users_last_active" ON "users" USING btree ("last_active_at");