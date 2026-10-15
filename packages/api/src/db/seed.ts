import { and, eq, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { hashPassword } from '../lib/crypto.js';
import { getDb } from './index.js';
import { pantryItems, recipeNutrition, recipes, userAllergies, users } from './schema.js';
import { RECIPE_CORPUS, toAiRecipe, type CorpusRecipe } from '../data/recipe-corpus.js';
import { analyseLocally, type NutritionSummary } from '../services/ai/nutrition.service.js';
import { persistAiRecipe } from '../services/recipe.service.js';
import { calculateNutritionTargets } from '../utils/nutrition.js';
import { addDays, toIsoDate } from '../utils/dates.js';
import { defaultShelfLifeDays, inferCategory } from '../utils/food.js';
import { ensureNotificationPreferences } from '../services/user.service.js';

/**
 * Demo seed.
 *
 * Makes a fresh clone immediately useful: one signed-in demo account, the whole
 * recipe corpus published as public recipes, and a realistic pantry with a few
 * items about to expire so the Home screen, the expiring-soon carousel and the
 * recipe ranking all have something to show on first launch.
 *
 * Fully idempotent — running it twice changes nothing. Safe to call from
 * `server.ts` when `SEED_DEMO_USER=true`, or directly via `npm run db:seed`.
 */

/** ISO date string — `users.date_of_birth` is a Postgres `date` column. */
const DEMO_DATE_OF_BIRTH = '1994-05-12';

export interface SeedResult {
  user: { id: string; email: string; created: boolean };
  recipes: { created: number; skipped: number; total: number };
  pantry: { created: number };
  allergies: { created: number };
}

/** A fridge that tells a story: fresh, about-to-expire, and long-life items. */
const DEMO_PANTRY: Array<{
  name: string;
  quantity: number;
  unit: string;
  /** Days from today. Negative means it already went off (and is flagged). */
  expiresIn: number;
  location: 'fridge' | 'freezer' | 'pantry';
}> = [
  { name: 'Chicken breast', quantity: 500, unit: 'g', expiresIn: 2, location: 'fridge' },
  { name: 'Spinach', quantity: 200, unit: 'g', expiresIn: 1, location: 'fridge' },
  { name: 'Greek yoghurt', quantity: 500, unit: 'g', expiresIn: 4, location: 'fridge' },
  { name: 'Eggs', quantity: 8, unit: 'pcs', expiresIn: 9, location: 'fridge' },
  { name: 'Milk', quantity: 1, unit: 'l', expiresIn: 3, location: 'fridge' },
  { name: 'Cheddar cheese', quantity: 200, unit: 'g', expiresIn: 12, location: 'fridge' },
  { name: 'Butter', quantity: 250, unit: 'g', expiresIn: 30, location: 'fridge' },
  { name: 'Carrots', quantity: 400, unit: 'g', expiresIn: 6, location: 'fridge' },
  { name: 'Bell pepper', quantity: 3, unit: 'pcs', expiresIn: 3, location: 'fridge' },
  { name: 'Tomatoes', quantity: 4, unit: 'pcs', expiresIn: 2, location: 'pantry' },
  { name: 'Cucumber', quantity: 2, unit: 'pcs', expiresIn: 5, location: 'fridge' },
  { name: 'Bananas', quantity: 5, unit: 'pcs', expiresIn: 2, location: 'pantry' },
  { name: 'Apples', quantity: 6, unit: 'pcs', expiresIn: 14, location: 'pantry' },
  { name: 'Lemon', quantity: 3, unit: 'pcs', expiresIn: 10, location: 'pantry' },
  { name: 'Garlic', quantity: 1, unit: 'pcs', expiresIn: 60, location: 'pantry' },
  { name: 'Onion', quantity: 4, unit: 'pcs', expiresIn: 30, location: 'pantry' },
  { name: 'Basmati rice', quantity: 1, unit: 'kg', expiresIn: 300, location: 'pantry' },
  { name: 'Pasta', quantity: 500, unit: 'g', expiresIn: 240, location: 'pantry' },
  { name: 'Olive oil', quantity: 500, unit: 'ml', expiresIn: 365, location: 'pantry' },
  { name: 'Chickpeas', quantity: 400, unit: 'g', expiresIn: 400, location: 'pantry' },
  { name: 'Black beans', quantity: 400, unit: 'g', expiresIn: 400, location: 'pantry' },
  { name: 'Frozen peas', quantity: 500, unit: 'g', expiresIn: 120, location: 'freezer' },
  { name: 'Frozen berries', quantity: 300, unit: 'g', expiresIn: 150, location: 'freezer' },
  { name: 'Salmon fillet', quantity: 300, unit: 'g', expiresIn: 90, location: 'freezer' },
];

/** Allergies that make the allergen guard visibly do its job in the demo. */
const DEMO_ALLERGIES: Array<{ allergen: string; severity: 'mild' | 'moderate' | 'severe' }> = [
  { allergen: 'peanuts', severity: 'severe' },
  { allergen: 'shellfish', severity: 'moderate' },
];

export async function seedDemoData(options: { force?: boolean } = {}): Promise<SeedResult> {
  const db = getDb();
  const email = (env.SEED_DEMO_EMAIL ?? 'demo@platematch.app').toLowerCase();
  const password = env.SEED_DEMO_PASSWORD ?? 'PlateMatch!2026';

  const result: SeedResult = {
    user: { id: '', email, created: false },
    recipes: { created: 0, skipped: 0, total: RECIPE_CORPUS.length },
    pantry: { created: 0 },
    allergies: { created: 0 },
  };

  // ---- 1. Demo user ------------------------------------------------------
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  let userId: string;

  if (existing) {
    userId = existing.id;
    logger.info({ email }, 'Demo user already exists — reusing');
  } else {
    const targets = calculateNutritionTargets({
      healthGoal: 'eat_healthy',
      activityLevel: 'moderate',
      dateOfBirth: DEMO_DATE_OF_BIRTH,
      gender: 'other',
      heightCm: 172,
      weightKg: 70,
    });

    const [created] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(password),
        fullName: 'Demo Cook',
        timezone: 'UTC',
        locale: 'en',
        dateOfBirth: DEMO_DATE_OF_BIRTH,
        gender: 'other',
        heightCm: 172,
        weightKg: 70,
        healthGoal: 'eat_healthy',
        activityLevel: 'moderate',
        dietaryPreference: 'none',
        familySize: 2,
        weeklyBudget: 80,
        currency: 'USD',
        dailyCalorieTarget: targets.dailyCalorieTarget,
        dailyProteinTargetG: targets.dailyProteinTargetG,
        dailyCarbsTargetG: targets.dailyCarbsTargetG,
        dailyFatTargetG: targets.dailyFatTargetG,
        cookingSkillLevel: 'intermediate',
        preferredCuisines: ['Mediterranean', 'Italian', 'Mexican', 'Indian'],
        maxCookingTimeMin: 45,
        onboardingCompleted: true,
        subscriptionTier: env.SEED_DEMO_PREMIUM ? 'premium' : 'free',
      })
      .returning({ id: users.id });

    userId = created!.id;
    result.user.created = true;
    await ensureNotificationPreferences(userId);
    logger.info({ userId, email }, 'Demo user created');
  }

  result.user.id = userId;

  // ---- 2. Allergies ------------------------------------------------------
  for (const allergy of DEMO_ALLERGIES) {
    const [row] = await db
      .select({ id: userAllergies.id })
      .from(userAllergies)
      .where(and(eq(userAllergies.userId, userId), eq(userAllergies.allergen, allergy.allergen)))
      .limit(1);

    if (row) continue;

    await db.insert(userAllergies).values({ userId, allergen: allergy.allergen, severity: allergy.severity });
    result.allergies.created += 1;
  }

  // ---- 3. Recipe corpus (public, shared catalogue) -----------------------
  for (const entry of RECIPE_CORPUS) {
    const [row] = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.title, entry.title), eq(recipes.source, 'seed')))
      .limit(1);

    if (row && !options.force) {
      result.recipes.skipped += 1;
      continue;
    }

    await persistCorpusRecipe(userId, entry);
    result.recipes.created += 1;
  }

  // ---- 4. Pantry ---------------------------------------------------------
  const existingPantry = await db
    .select({ name: pantryItems.ingredientName })
    .from(pantryItems)
    .where(and(eq(pantryItems.userId, userId), eq(pantryItems.isUsed, false)));

  const have = new Set(existingPantry.map((p) => p.name.toLowerCase()));
  const today = new Date();

  for (const item of DEMO_PANTRY) {
    if (have.has(item.name.toLowerCase())) continue;

    const expiry = toIsoDate(addDays(toIsoDate(today), item.expiresIn));

    await db.insert(pantryItems).values({
      userId,
      ingredientName: item.name,
      normalizedKey: item.name.toLowerCase(),
      category: inferCategory(item.name),
      quantity: item.quantity,
      unit: item.unit,
      expiryDate: expiry,
      purchaseDate: toIsoDate(addDays(toIsoDate(today), -Math.max(1, defaultShelfLifeDays(item.name) - item.expiresIn))),
      location: item.location,
      addedVia: 'manual',
      freshness: item.expiresIn <= 0 ? 'spoiled' : item.expiresIn <= 2 ? 'overripe' : 'fresh',
      isExpired: item.expiresIn < 0,
    });

    result.pantry.created += 1;
  }

  logger.info(
    {
      userId,
      recipesCreated: result.recipes.created,
      recipesSkipped: result.recipes.skipped,
      pantryItems: result.pantry.created,
    },
    'Demo seed complete',
  );

  return result;
}

/** Persist one corpus recipe as a public, seeded recipe with real nutrition. */
async function persistCorpusRecipe(ownerId: string, entry: CorpusRecipe): Promise<string | null> {
  const db = getDb();
  const aiRecipe = toAiRecipe(entry, { model: 'seed' });

  // Prefer the corpus's own numbers; fall back to the composition table so a
  // hand-written entry without nutrition still gets a plausible value.
  const nutrition: NutritionSummary = entry.nutrition
    ? {
        calories: entry.nutrition.calories,
        protein_g: entry.nutrition.protein_g,
        carbs_g: entry.nutrition.carbs_g,
        fat_g: entry.nutrition.fat_g,
        fiber_g: entry.nutrition.fiber_g,
        sugar_g: 0,
        sodium_mg: entry.nutrition.sodium_mg,
        cholesterol_mg: 0,
        saturated_fat_g: 0,
        vitamin_a_pct: 0,
        vitamin_c_pct: 0,
        calcium_pct: 0,
        iron_pct: 0,
        potassium_mg: 0,
        per_serving: true,
        source: 'local',
      }
    : analyseLocally(
        aiRecipe.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
        aiRecipe.servings,
      );

  const dto = await persistAiRecipe(ownerId, aiRecipe, nutrition, 'seed', { isPublic: true });

  // Tag it as seed data so re-runs and `--force` can find it again.
  await db.update(recipes).set({ source: 'seed' }).where(eq(recipes.id, dto.id));

  // A few corpus entries benefit from verified micronutrients; the backfill job
  // fills the rest, so we only ensure a row exists.
  const [row] = await db
    .select({ id: recipeNutrition.id })
    .from(recipeNutrition)
    .where(eq(recipeNutrition.recipeId, dto.id))
    .limit(1);

  if (!row) {
    await db
      .insert(recipeNutrition)
      .values({
        recipeId: dto.id,
        calories: nutrition.calories,
        proteinG: nutrition.protein_g,
        carbsG: nutrition.carbs_g,
        fatG: nutrition.fat_g,
        fiberG: nutrition.fiber_g,
        sugarG: nutrition.sugar_g,
        sodiumMg: nutrition.sodium_mg,
        cholesterolMg: nutrition.cholesterol_mg,
        saturatedFatG: nutrition.saturated_fat_g,
        vitaminAPct: nutrition.vitamin_a_pct,
        vitaminCPct: nutrition.vitamin_c_pct,
        calciumPct: nutrition.calcium_pct,
        ironPct: nutrition.iron_pct,
        potassiumMg: nutrition.potassium_mg,
        source: 'local',
        perServing: true,
      })
      .catch((err: unknown) => {
        logger.debug({ err: (err as Error).message, recipe: dto.title }, 'Nutrition row already present');
      });
  }

  return dto.id;
}

/** CLI entrypoint: `npm run db:seed [-- --force]`. */
export async function runSeedCli(): Promise<void> {
  const force = process.argv.includes('--force');

  logger.info({ force, email: env.SEED_DEMO_EMAIL }, 'Seeding demo data');
  const result = await seedDemoData({ force });

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  PlateMatch demo data ready',
      '  ─────────────────────────────────────────────',
      `  Email      ${result.user.email}`,
      `  Password   ${env.SEED_DEMO_PASSWORD ?? 'PlateMatch!2026'}`,
      `  User       ${result.user.created ? 'created' : 'already existed'}`,
      `  Recipes    ${result.recipes.created} created · ${result.recipes.skipped} existing · ${result.recipes.total} in corpus`,
      `  Pantry     ${result.pantry.created} items`,
      `  Allergies  ${result.allergies.created} added`,
      '',
    ].join('\n'),
  );

  void sql;
}

if (process.argv[1] && /seed\.(ts|js|mjs)$/.test(process.argv[1])) {
  runSeedCli()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.fatal({ err }, 'Seed failed');
      process.exit(1);
    });
}
