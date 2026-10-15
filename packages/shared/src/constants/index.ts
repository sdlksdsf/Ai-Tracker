/**
 * Domain constants shared by the API and the mobile app.
 *
 * These mirror the PostgreSQL ENUM types declared in `packages/api/src/db/schema.ts`
 * so a single source of truth drives both the database and the client.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const DIETARY_PREFERENCES = [
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
] as const;
export type DietaryPreference = (typeof DIETARY_PREFERENCES)[number];

export const HEALTH_GOALS = [
  'lose_weight',
  'gain_muscle',
  'maintain',
  'eat_healthy',
  'manage_diabetes',
] as const;
export type HealthGoal = (typeof HEALTH_GOALS)[number];

export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very_active'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const INGREDIENT_CATEGORIES = [
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
] as const;
export type IngredientCategory = (typeof INGREDIENT_CATEGORIES)[number];

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard'] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export const WASTE_REASONS = ['expired', 'spoiled', 'leftover', 'overcooked', 'didnt_like', 'other'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const SCAN_SOURCES = ['camera', 'gallery', 'manual'] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export const SUBSCRIPTION_TIERS = ['free', 'premium', 'family'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const FRESHNESS_LEVELS = ['fresh', 'ripening', 'overripe', 'spoiled'] as const;
export type FreshnessLevel = (typeof FRESHNESS_LEVELS)[number];

export const STORAGE_LOCATIONS = ['fridge', 'pantry', 'freezer'] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const COOKING_SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type CookingSkillLevel = (typeof COOKING_SKILL_LEVELS)[number];

export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const;
export type Gender = (typeof GENDERS)[number];

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'PKR', 'INR', 'AUD', 'CAD', 'AED'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DAYS_OF_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

/** 1 = Monday … 7 = Sunday (matches `meal_plan_entries.day_of_week`). */
export const DAY_NAMES: Record<DayOfWeek, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export const DAY_SHORT_NAMES: Record<DayOfWeek, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

export const SCAN_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

// ---------------------------------------------------------------------------
// Human-readable labels (used by onboarding, filters and settings screens)
// ---------------------------------------------------------------------------

export const DIETARY_PREFERENCE_LABELS: Record<DietaryPreference, string> = {
  none: 'No restriction',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  pescatarian: 'Pescatarian',
  keto: 'Keto',
  paleo: 'Paleo',
  mediterranean: 'Mediterranean',
  halal: 'Halal',
  kosher: 'Kosher',
  low_fodmap: 'Low FODMAP',
  carnivore: 'Carnivore',
};

export const HEALTH_GOAL_LABELS: Record<HealthGoal, string> = {
  lose_weight: 'Lose weight',
  gain_muscle: 'Gain muscle',
  maintain: 'Maintain',
  eat_healthy: 'Eat healthier',
  manage_diabetes: 'Manage diabetes',
};

export const ACTIVITY_LEVEL_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Sedentary — desk job, little exercise',
  light: 'Lightly active — 1-3 workouts/week',
  moderate: 'Moderately active — 3-5 workouts/week',
  active: 'Very active — 6-7 workouts/week',
  very_active: 'Athlete — physical job + daily training',
};

export const INGREDIENT_CATEGORY_LABELS: Record<IngredientCategory, string> = {
  vegetable: 'Vegetables',
  fruit: 'Fruits',
  dairy: 'Dairy & Eggs',
  meat: 'Meat & Poultry',
  seafood: 'Seafood',
  grain: 'Grains & Pasta',
  spice: 'Spices & Herbs',
  condiment: 'Condiments & Sauces',
  beverage: 'Beverages',
  snack: 'Snacks',
  frozen: 'Frozen',
  canned: 'Canned & Jarred',
  bakery: 'Bakery',
  legume: 'Legumes & Beans',
  nut_seed: 'Nuts & Seeds',
  oil_fat: 'Oils & Fats',
  sweetener: 'Sweeteners',
  other: 'Other',
};

export const INGREDIENT_CATEGORY_EMOJI: Record<IngredientCategory, string> = {
  vegetable: '🥬',
  fruit: '🍎',
  dairy: '🥛',
  meat: '🥩',
  seafood: '🐟',
  grain: '🌾',
  spice: '🌶️',
  condiment: '🥫',
  beverage: '🧃',
  snack: '🍿',
  frozen: '🧊',
  canned: '🥫',
  bakery: '🍞',
  legume: '🫘',
  nut_seed: '🥜',
  oil_fat: '🫒',
  sweetener: '🍯',
  other: '🧺',
};

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

export const MEAL_TYPE_EMOJI: Record<MealType, string> = {
  breakfast: '🍳',
  lunch: '🥗',
  dinner: '🍽️',
  snack: '🍎',
};

export const WASTE_REASON_LABELS: Record<WasteReason, string> = {
  expired: 'Passed expiry date',
  spoiled: 'Spoiled / went bad',
  leftover: 'Leftovers not eaten',
  overcooked: 'Overcooked / burnt',
  didnt_like: "Didn't like the taste",
  other: 'Other',
};

export const FRESHNESS_LABELS: Record<FreshnessLevel, string> = {
  fresh: 'Fresh',
  ripening: 'Ripening',
  overripe: 'Overripe',
  spoiled: 'Spoiled',
};

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

// ---------------------------------------------------------------------------
// Allergens — safety-critical list used for AI prompt hard-blocking
// ---------------------------------------------------------------------------

export const COMMON_ALLERGENS = [
  'peanuts',
  'tree nuts',
  'milk',
  'eggs',
  'fish',
  'shellfish',
  'crustacean',
  'mollusk',
  'soy',
  'wheat',
  'gluten',
  'sesame',
  'mustard',
  'celery',
  'lupin',
  'sulphites',
  'corn',
  'gelatin',
  'pork',
  'beef',
  'alcohol',
  'caffeine',
] as const;
export type CommonAllergen = (typeof COMMON_ALLERGENS)[number];

export const ALLERGEN_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type AllergenSeverity = (typeof ALLERGEN_SEVERITIES)[number];

/**
 * Allergen → ingredient keywords that must NEVER appear in a generated recipe.
 * The recipe pipeline uses this as a deterministic post-generation safety net
 * (see `packages/api/src/services/ai/allergen-guard.ts`).
 */
export const ALLERGEN_INGREDIENT_KEYWORDS: Record<string, string[]> = {
  peanuts: ['peanut', 'groundnut', 'arachis', 'beer nuts', 'monkey nuts'],
  'tree nuts': [
    'almond',
    'cashew',
    'walnut',
    'pecan',
    'pistachio',
    'hazelnut',
    'macadamia',
    'brazil nut',
    'pine nut',
    'chestnut',
    'praline',
    'marzipan',
    'nut butter',
    'frangipane',
    'nougat',
  ],
  milk: [
    'milk',
    'butter',
    'cream',
    'cheese',
    'yogurt',
    'yoghurt',
    'ghee',
    'whey',
    'casein',
    'curd',
    'paneer',
    'mozzarella',
    'parmesan',
    'cheddar',
    'ricotta',
    'mascarpone',
    'custard',
    'dulce de leche',
    'condensed milk',
    'evaporated milk',
  ],
  eggs: ['egg', 'mayonnaise', 'mayo', 'meringue', 'aioli', 'albumin', 'lysozyme', 'quiche'],
  fish: ['fish', 'anchovy', 'sardine', 'tuna', 'salmon', 'cod', 'trout', 'mackerel', 'fish sauce', 'worcestershire'],
  shellfish: ['shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'scallop', 'clam', 'oyster', 'mussel', 'squid', 'octopus', 'calamari'],
  crustacean: ['shrimp', 'prawn', 'crab', 'lobster', 'crayfish'],
  mollusk: ['clam', 'oyster', 'mussel', 'scallop', 'squid', 'octopus', 'calamari'],
  soy: ['soy', 'soya', 'tofu', 'tempeh', 'edamame', 'miso', 'tamari', 'soy sauce', 'soybean', 'textured vegetable protein'],
  wheat: ['wheat', 'flour', 'bread', 'pasta', 'couscous', 'bulgur', 'semolina', 'farina', 'seitan', 'barley', 'rye', 'spelt', 'cracker', 'noodle'],
  gluten: ['wheat', 'gluten', 'barley', 'rye', 'malt', 'seitan', 'spelt', 'triticale', 'bread', 'pasta'],
  sesame: ['sesame', 'tahini', 'halva', 'gomashio', 'benne'],
  mustard: ['mustard'],
  celery: ['celery', 'celeriac'],
  lupin: ['lupin', 'lupini'],
  sulphites: ['sulphite', 'sulfite', 'sulphur dioxide', 'dried apricot', 'wine'],
  gelatin: ['gelatin', 'gelatine', 'jelly', 'marshmallow'],
  pork: ['pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'lard', 'sausage'],
  beef: ['beef', 'veal', 'steak', 'tallow'],
  alcohol: ['wine', 'beer', 'rum', 'vodka', 'whisky', 'whiskey', 'brandy', 'sherry', 'mirin', 'cooking wine', 'bourbon'],
  caffeine: ['coffee', 'espresso', 'tea', 'matcha', 'cola', 'energy drink'],
  // Corn is one of the most common hidden ingredients in processed food, so a
  // literal-name match would miss almost every product that contains it.
  corn: [
    'corn', 'maize', 'cornstarch', 'corn starch', 'corn syrup', 'corn flour',
    'cornmeal', 'corn oil', 'high fructose corn syrup', 'hfcs', 'polenta',
    'masa', 'masa harina', 'hominy', 'grits', 'popcorn', 'sweetcorn',
    'baby corn', 'cornflour', 'dextrose', 'maltodextrin',
  ],
};

/**
 * Ingredients excluded for each dietary preference. Used both for prompting
 * and for the deterministic allergen/diet safety guard.
 */
export const DIETARY_EXCLUSIONS: Record<DietaryPreference, string[]> = {
  none: [],
  vegetarian: [
    'beef', 'pork', 'chicken', 'lamb', 'veal', 'turkey', 'duck', 'bacon', 'ham', 'sausage',
    'fish', 'shrimp', 'prawn', 'crab', 'lobster', 'anchovy', 'sardine', 'tuna', 'salmon',
    'gelatin', 'lard', 'tallow', 'meat', 'mutton', 'goat',
  ],
  vegan: [
    'beef', 'pork', 'chicken', 'lamb', 'veal', 'turkey', 'duck', 'bacon', 'ham', 'sausage',
    'fish', 'shrimp', 'prawn', 'crab', 'lobster', 'anchovy', 'sardine', 'tuna', 'salmon',
    'milk', 'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'ghee', 'whey', 'casein',
    'egg', 'mayonnaise', 'honey', 'gelatin', 'lard', 'tallow', 'paneer', 'mozzarella',
    'parmesan', 'cheddar', 'mutton', 'goat', 'meat',
  ],
  pescatarian: [
    'beef', 'pork', 'chicken', 'lamb', 'veal', 'turkey', 'duck', 'bacon', 'ham', 'sausage',
    'gelatin', 'lard', 'tallow', 'mutton', 'goat', 'meat',
  ],
  keto: ['sugar', 'honey', 'flour', 'bread', 'rice', 'pasta', 'potato', 'banana', 'mango', 'grape', 'corn', 'oats', 'beans', 'lentil'],
  paleo: ['wheat', 'flour', 'bread', 'pasta', 'rice', 'oats', 'beans', 'lentil', 'peanut', 'soy', 'dairy', 'milk', 'cheese', 'butter', 'yogurt', 'sugar', 'corn'],
  mediterranean: ['bacon', 'sausage', 'hot dog', 'lard', 'butter', 'cream', 'refined sugar'],
  halal: ['pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'lard', 'gelatin', 'alcohol', 'wine', 'beer', 'rum', 'brandy', 'blood'],
  kosher: ['pork', 'bacon', 'ham', 'shellfish', 'shrimp', 'crab', 'lobster', 'clam', 'oyster', 'mussel', 'lard', 'gelatin'],
  low_fodmap: ['onion', 'garlic', 'wheat', 'beans', 'lentil', 'chickpea', 'cauliflower', 'mushroom', 'apple', 'pear', 'watermelon', 'honey', 'milk'],
  carnivore: ['vegetable', 'fruit', 'grain', 'bread', 'rice', 'pasta', 'sugar', 'flour', 'beans', 'lentil', 'nut'],
};

// ---------------------------------------------------------------------------
// Units & conversion
// ---------------------------------------------------------------------------

export const UNITS = [
  'g', 'kg', 'mg', 'ml', 'l', 'pieces', 'cups', 'cup', 'tbsp', 'tsp', 'oz', 'lb',
  'clove', 'cloves', 'slice', 'slices', 'can', 'cans', 'bunch', 'bunches', 'head',
  'heads', 'pinch', 'dash', 'handful', 'jar', 'bottle', 'packet', 'stick', 'medium',
  'large', 'small', 'whole',
] as const;
export type Unit = (typeof UNITS)[number];

/** Grams per unit for common volume/mass conversions (approximate, for nutrition math). */
export const UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  mg: 0.001,
  ml: 1,
  l: 1000,
  oz: 28.3495,
  lb: 453.592,
  cup: 240,
  cups: 240,
  tbsp: 15,
  tsp: 5,
  pinch: 0.36,
  dash: 0.62,
  handful: 40,
  clove: 5,
  cloves: 5,
  slice: 30,
  slices: 30,
  pieces: 100,
  medium: 120,
  large: 160,
  small: 80,
  whole: 150,
  can: 400,
  cans: 400,
  bunch: 150,
  bunches: 150,
  head: 400,
  heads: 400,
  jar: 350,
  bottle: 500,
  packet: 250,
  stick: 113,
};

// ---------------------------------------------------------------------------
// CO2e factors — kg CO2 equivalent per kg of food wasted
// (FAO / Our World in Data lifecycle averages)
// ---------------------------------------------------------------------------

export const CO2_PER_KG_BY_CATEGORY: Record<IngredientCategory, number> = {
  vegetable: 0.6,
  fruit: 0.7,
  dairy: 2.4,
  meat: 6.5,
  seafood: 5.1,
  grain: 1.4,
  spice: 1.2,
  condiment: 1.1,
  beverage: 0.9,
  snack: 1.8,
  frozen: 1.6,
  canned: 1.5,
  bakery: 0.8,
  legume: 0.9,
  nut_seed: 2.1,
  oil_fat: 3.4,
  sweetener: 1.0,
  other: 1.2,
};

/** One mature tree absorbs ≈ 21 kg CO2 per year (USDA Forest Service average). */
export const KG_CO2_PER_TREE_PER_YEAR = 21;

/** Litres of water saved per kg of food rescued. */
export const LITRES_WATER_PER_KG_FOOD = 962;

// ---------------------------------------------------------------------------
// Subscription plans & rate limits
// ---------------------------------------------------------------------------

export interface PlanLimits {
  /** Fridge scans per rolling 7 days. `Infinity` is serialised as `-1` over the wire. */
  scansPerWeek: number;
  /** AI recipe generations per day. */
  recipeGenerationsPerDay: number;
  /** AI meal plans per 30 days. */
  mealPlansPerMonth: number;
  /** Max pantry items. */
  maxPantryItems: number;
  priceComparison: boolean;
  advancedAnalytics: boolean;
  cookingModeVoice: boolean;
  exportGroceryLists: boolean;
  ads: boolean;
  sharedHouseholdMembers: number;
  label: string;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
}

export const PLAN_LIMITS: Record<SubscriptionTier, PlanLimits> = {
  free: {
    scansPerWeek: 3,
    recipeGenerationsPerDay: 5,
    mealPlansPerMonth: 1,
    maxPantryItems: 50,
    priceComparison: false,
    advancedAnalytics: false,
    cookingModeVoice: false,
    exportGroceryLists: false,
    ads: true,
    sharedHouseholdMembers: 0,
    label: 'Free',
    monthlyPriceUsd: 0,
    yearlyPriceUsd: 0,
  },
  premium: {
    scansPerWeek: -1,
    recipeGenerationsPerDay: -1,
    mealPlansPerMonth: -1,
    maxPantryItems: -1,
    priceComparison: true,
    advancedAnalytics: true,
    cookingModeVoice: true,
    exportGroceryLists: true,
    ads: false,
    sharedHouseholdMembers: 0,
    label: 'Premium',
    monthlyPriceUsd: 4.99,
    yearlyPriceUsd: 39.99,
  },
  family: {
    scansPerWeek: -1,
    recipeGenerationsPerDay: -1,
    mealPlansPerMonth: -1,
    maxPantryItems: -1,
    priceComparison: true,
    advancedAnalytics: true,
    cookingModeVoice: true,
    exportGroceryLists: true,
    ads: false,
    sharedHouseholdMembers: 6,
    label: 'Family',
    monthlyPriceUsd: 7.99,
    yearlyPriceUsd: 59.99,
  },
};

/** HTTP rate limits (Section 8 of the spec). */
export const RATE_LIMITS = {
  general: { max: 100, windowMs: 60_000 },
  ai: { max: 10, windowMs: 60_000 },
  scan: { max: 5, windowMs: 60_000 },
  auth: { max: 10, windowMs: 60_000 },
} as const;

/** Token lifetimes. */
export const TOKEN_TTL = {
  accessTokenSeconds: 15 * 60, // 15 minutes
  refreshTokenSeconds: 7 * 24 * 60 * 60, // 7 days
  resetPasswordTokenSeconds: 60 * 60, // 1 hour
} as const;

// ---------------------------------------------------------------------------
// AI / cache TTLs
// ---------------------------------------------------------------------------

export const CACHE_TTL_SECONDS = {
  recipeSearch: 10 * 60, // 10 min
  groceryPrices: 24 * 60 * 60, // 24 h
  nutrition: 30 * 24 * 60 * 60, // 30 days
  userPantry: 5 * 60, // 5 min
  session: 7 * 24 * 60 * 60, // 7 days
  recipeGeneration: 60 * 60, // 1 h (same ingredient combo dedupe)
  scanDedupe: 10 * 60, // 10 min
} as const;

/** Minimum model confidence before we accept a detected item. */
export const AI_CONFIDENCE = {
  /** Items below this are dropped entirely (prompt rule #8). */
  minAccept: 0.65,
  /** Average confidence below this triggers the fallback model. */
  fallbackThreshold: 0.75,
} as const;

// ---------------------------------------------------------------------------
// Upload constraints
// ---------------------------------------------------------------------------

export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // 10 MB
  maxLongestSidePx: 1536,
  jpegQuality: 85,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as string[],
} as const;

// ---------------------------------------------------------------------------
// Nutrition defaults
// ---------------------------------------------------------------------------

/** Mifflin–St Jeor activity multipliers. */
export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Macro split per health goal (protein / carbs / fat). */
export const MACRO_SPLIT_BY_GOAL: Record<HealthGoal, { protein: number; carbs: number; fat: number }> = {
  lose_weight: { protein: 0.35, carbs: 0.35, fat: 0.3 },
  gain_muscle: { protein: 0.3, carbs: 0.45, fat: 0.25 },
  maintain: { protein: 0.25, carbs: 0.5, fat: 0.25 },
  eat_healthy: { protein: 0.3, carbs: 0.4, fat: 0.3 },
  manage_diabetes: { protein: 0.3, carbs: 0.4, fat: 0.3 },
};

/** Calorie adjustment per health goal. */
export const CALORIE_ADJUSTMENT_BY_GOAL: Record<HealthGoal, number> = {
  lose_weight: -400,
  gain_muscle: 300,
  maintain: 0,
  eat_healthy: 0,
  manage_diabetes: -200,
};

// ---------------------------------------------------------------------------
// Cuisines
// ---------------------------------------------------------------------------

export const CUISINES = [
  'Indian', 'Italian', 'Mexican', 'Chinese', 'Thai', 'Japanese', 'Korean',
  'Mediterranean', 'Middle Eastern', 'French', 'Spanish', 'Greek', 'American',
  'Pakistani', 'Bangladeshi', 'Vietnamese', 'Lebanese', 'Turkish', 'Ethiopian',
  'Brazilian', 'Caribbean', 'British', 'German', 'Fusion', 'Any',
] as const;
export type Cuisine = (typeof CUISINES)[number];

// ---------------------------------------------------------------------------
// Deep-link routes (kept in sync with apps/mobile/app/**)
// ---------------------------------------------------------------------------

export const DEEP_LINK_ROUTES = {
  home: '/(tabs)',
  scan: '/(tabs)/scan',
  recipes: '/(tabs)/recipes',
  plan: '/(tabs)/plan',
  profile: '/(tabs)/profile',
  pantry: '/pantry',
  recipeDetail: (id: string) => `/recipe/${id}`,
  cookingMode: (id: string) => `/cooking/${id}`,
  scanResult: (id: string) => `/scan/result/${id}`,
  groceryList: (id: string) => `/grocery/${id}`,
  waste: '/waste',
  achievements: '/achievements',
  premium: '/premium',
} as const;

export const APP_SCHEME = 'platematch';
export const API_BASE_PATH = '/api/v1';
