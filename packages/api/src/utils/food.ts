import {
  CO2_PER_KG_BY_CATEGORY,
  INGREDIENT_CATEGORIES,
  UNIT_TO_GRAMS,
  type IngredientCategory,
} from '@platematch/shared';

/**
 * Food dictionary & ingredient normalisation
 * ===========================================================================
 * The glue that makes "what's in my fridge" and "what does this recipe need"
 * speak the same language. Everything here is deterministic and offline, which
 * is what lets PlateMatch work with zero AI API keys and what powers the
 * pantry-match percentage on every recipe card.
 */

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

const NOISE_WORDS = new Set([
  'fresh', 'organic', 'raw', 'frozen', 'canned', 'chopped', 'sliced', 'diced', 'grated',
  'minced', 'crushed', 'whole', 'large', 'medium', 'small', 'boneless', 'skinless',
  'skin', 'bone', 'low', 'fat', 'free', 'full', 'cream', 'lite', 'light', 'extra',
  'virgin', 'pure', 'natural', 'packed', 'of', 'the', 'a', 'an', 'and', 'or',
  'approx', 'approximately', 'about', 'roughly', 'some', 'few', 'pieces', 'piece',
]);

/** Irregular plurals that the regex rules get wrong. */
const IRREGULAR_PLURALS: Record<string, string> = {
  tomatoes: 'tomato',
  potatoes: 'potato',
  leaves: 'leaf',
  loaves: 'loaf',
  knives: 'knife',
  lives: 'life',
  mushrooms: 'mushroom',
  onions: 'onion',
  cheeses: 'cheese',
  sauces: 'sauce',
  spices: 'spice',
  lettuce: 'lettuce',
  rice: 'rice',
  pasta: 'pasta',
  quinoa: 'quinoa',
  broccoli: 'broccoli',
  cauliflower: 'cauliflower',
  asparagus: 'asparagus',
  hummus: 'hummus',
  couscous: 'couscous',
  molasses: 'molasses',
  oats: 'oats',
  beans: 'bean',
  lentils: 'lentil',
  eggs: 'egg',
  noodles: 'noodle',
  peas: 'pea',
  grapes: 'grape',
  cherries: 'cherry',
  berries: 'berry',
  anchovies: 'anchovy',
  children: 'child',
  halves: 'half',
  shelves: 'shelf',
  wives: 'wife',
  mice: 'mouse',
  geese: 'goose',
  teeth: 'tooth',
  feet: 'foot',
  people: 'person',
};

/**
 * Canonical matching key for an ingredient name.
 *   "Fresh Cherry Tomatoes (250g)" → "cherry tomato"
 */
export function normalizeIngredient(name: string): string {
  if (!name) return '';

  let out = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\(.*?\)/g, ' ') // drop parentheticals
    .replace(/\[.*?\]/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(g|kg|mg|ml|l|oz|lb|cups?|tbsp|tsp|pieces?)\b/gi, ' ')
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Drop leading brand-ish qualifiers and noise words.
  const words = out.split(' ').filter((w) => w.length > 0);
  const kept = words.filter((w, i) => !(NOISE_WORDS.has(w) && i !== words.length - 1));
  out = (kept.length ? kept : words).join(' ').trim();

  // Nothing survived filtering. Only fall back to the raw string when it at
  // least contained a letter or digit — "!!!" is not an ingredient name.
  if (!out) return /[a-z0-9]/i.test(name) ? name.toLowerCase().trim() : '';

  // Singularise the LAST word only ("green beans" → "green bean").
  const parts = out.split(' ');
  const last = parts[parts.length - 1] as string;
  const singular = singularize(last);
  parts[parts.length - 1] = singular;
  return parts.join(' ');
}

export function singularize(word: string): string {
  if (word.length <= 2) return word;
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word] as string;
  // Uncountables stay as they are.
  if (['rice', 'pasta', 'quinoa', 'lettuce', 'bread', 'butter', 'cheese', 'milk', 'water', 'oil', 'salt', 'sugar', 'flour', 'honey', 'yogurt', 'oats', 'couscous', 'hummus'].includes(word)) {
    return word;
  }
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/ves$/.test(word)) return `${word.slice(0, -3)}f`;
  // "tomatoes" -> "tomato", "potatoes" -> "potato" (but "shoes" -> "shoe").
  if (/(t|p|e)o(es)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word) && !/us$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Words ending in -o that take a plain -s ("photo" -> "photos"). */
const O_EXCEPTIONS = new Set(['photo', 'piano', 'radio', 'video', 'memo', 'zero', 'avocado', 'mango', 'studio', 'kilo']);

/**
 * Reverse of `IRREGULAR_PLURALS`, built once.
 *
 * Both directions are needed: `normalizeIngredient` singularises the last word
 * to build a matching key, while grocery-line merging and prompt text pluralise
 * it again. Without the reverse map "child" pluralised to "childs", so the two
 * operations did not round-trip and the same ingredient could land under two
 * different normalised keys.
 */
const IRREGULAR_SINGULARS: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURALS).map(([plural, singular]) => [singular, plural]),
);

export function pluralize(word: string): string {
  if (IRREGULAR_SINGULARS[word]) return IRREGULAR_SINGULARS[word] as string;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  // "tomato" -> "tomatoes", "potato" -> "potatoes", but "avocado" -> "avocados".
  if (/[^aeiou]o$/.test(word) && !O_EXCEPTIONS.has(word)) return `${word}es`;
  if (/(f|fe)$/.test(word)) return `${word.replace(/(f|fe)$/, '')}ves`;
  return `${word}s`;
}

/**
 * Normalise a name for *categorisation* rather than for matching.
 *
 * `normalizeIngredient` deliberately drops storage-state words ("frozen peas"
 * → "pea") because they carry no weight when deciding whether two names are the
 * same ingredient. But `frozen` and `canned` ARE the category for grocery aisle
 * grouping, CO₂ factor selection and shelf-life estimation — so those callers
 * use this variant instead.
 */
export function normalizeForCategory(name: string): string {
  if (!name) return '';

  const out = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(g|kg|mg|ml|l|oz|lb|cups?|tbsp|tsp|pieces?)\b/gi, ' ')
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!out) return '';

  const parts = out.split(' ').filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1] as string;
  parts[parts.length - 1] = singularize(last);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Category inference
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS: Array<[IngredientCategory, string[]]> = [
  // Storage-state and prepared-drink categories come first: they are more
  // specific than the base ingredient class, and the loop keeps the first
  // highest-scoring match.
  ['frozen', ['ice cream', 'frozen pea', 'frozen corn', 'frozen berry', 'frozen berries', 'frozen vegetable', 'frozen vegetables', 'frozen pizza', 'frozen chicken', 'frozen fish', 'frozen', 'sorbet', 'gelato', 'popsicle']],
  ['canned', ['canned', 'tin', 'jar', 'preserved', 'condensed', 'evaporated', 'tomato paste', 'coconut milk', 'baked bean']],
  ['beverage', ['juice', 'coffee', 'tea', 'soda', 'cola', 'water', 'wine', 'beer', 'smoothie', 'lemonade', 'coconut water', 'beverage', 'drink', 'milkshake']],
  ['vegetable', ['tomato', 'onion', 'garlic', 'potato', 'carrot', 'spinach', 'lettuce', 'cabbage', 'broccoli', 'cauliflower', 'pepper', 'chili', 'chilli', 'cucumber', 'zucchini', 'courgette', 'aubergine', 'eggplant', 'mushroom', 'celery', 'asparagus', 'green bean', 'pea', 'corn', 'sweetcorn', 'beetroot', 'beet', 'radish', 'turnip', 'leek', 'shallot', 'scallion', 'spring onion', 'ginger', 'kale', 'arugula', 'rocket', 'basil', 'coriander', 'cilantro', 'parsley', 'mint', 'dill', 'okra', 'pumpkin', 'squash', 'yam', 'artichoke', 'fennel', 'bok choy', 'vegetable', 'veggie', 'salad', 'herb']],
  ['fruit', ['apple', 'banana', 'orange', 'lemon', 'lime', 'mango', 'pineapple', 'grape', 'strawberry', 'blueberry', 'raspberry', 'blackberry', 'cherry', 'peach', 'plum', 'pear', 'melon', 'watermelon', 'cantaloupe', 'kiwi', 'papaya', 'pomegranate', 'avocado', 'coconut', 'fig', 'date', 'apricot', 'nectarine', 'guava', 'lychee', 'cranberry', 'fruit', 'berry', 'berries', 'citrus']],
  ['dairy', ['milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'ghee', 'paneer', 'mozzarella', 'cheddar', 'parmesan', 'feta', 'ricotta', 'mascarpone', 'brie', 'gouda', 'halloumi', 'curd', 'egg', 'whipping', 'sour cream', 'cream cheese', 'cottage cheese', 'dairy', 'kefir', 'buttermilk']],
  ['meat', ['chicken', 'beef', 'pork', 'lamb', 'mutton', 'goat', 'veal', 'turkey', 'duck', 'bacon', 'ham', 'sausage', 'salami', 'prosciutto', 'pancetta', 'chorizo', 'mince', 'ground beef', 'steak', 'ribs', 'wings', 'thigh', 'breast', 'liver', 'keema', 'meat']],
  ['seafood', ['fish', 'salmon', 'tuna', 'cod', 'trout', 'mackerel', 'sardine', 'anchovy', 'shrimp', 'prawn', 'crab', 'lobster', 'squid', 'octopus', 'clam', 'mussel', 'oyster', 'scallop', 'tilapia', 'herring', 'sea bass', 'seafood', ' calamari']],
  ['grain', ['rice', 'pasta', 'bread', 'noodle', 'flour', 'oats', 'quinoa', 'barley', 'couscous', 'bulgur', 'semolina', 'cereal', 'wheat', 'cornmeal', 'polenta', 'tortilla', 'pita', 'naan', 'roti', 'bagel', 'cracker', 'breadcrumb', 'grain', 'spaghetti', 'penne', 'macaroni', 'lasagna', 'basmati', 'jasmine']],
  ['spice', ['salt', 'pepper', 'cumin', 'turmeric', 'coriander powder', 'paprika', 'chili powder', 'garam masala', 'curry powder', 'cinnamon', 'cardamom', 'clove', 'nutmeg', 'oregano', 'thyme', 'rosemary', 'bay leaf', 'mustard seed', 'fenugreek', 'asafoetida', 'hing', 'saffron', 'star anise', 'fennel seed', 'spice', 'masala', 'seasoning', 'chili flake']],
  ['condiment', ['ketchup', 'mustard', 'mayonnaise', 'soy sauce', 'vinegar', 'hot sauce', 'sriracha', 'salsa', 'chutney', 'pickle', 'jam', 'hummus', 'tahini', 'pesto', 'bbq sauce', 'worcestershire', 'fish sauce', 'oyster sauce', 'hoisin', 'teriyaki', 'relish', 'condiment', 'sauce', 'dressing', 'dip']],
  ['snack', ['chips', 'crisps', 'popcorn', 'pretzel', 'chocolate', 'biscuit', 'cookie', 'candy', 'granola bar', 'protein bar', 'snack', 'trail mix']],
  ['bakery', ['cake', 'muffin', 'croissant', 'brownie', 'cupcake', 'pastry', 'donut', 'doughnut', 'pie', 'bakery', 'brioche', 'scone']],
  ['legume', ['bean', 'lentil', 'chickpea', 'pea', 'black bean', 'kidney bean', 'pinto bean', 'green gram', 'moong', 'toor dal', 'masoor', 'chana', 'rajma', 'legume', 'dal', 'soybean', 'edamame']],
  ['nut_seed', ['almond', 'cashew', 'walnut', 'peanut', 'pistachio', 'pecan', 'hazelnut', 'macadamia', 'brazil nut', 'pine nut', 'sunflower seed', 'pumpkin seed', 'chia', 'flax', 'flaxseed', 'sesame', 'nut', 'seed']],
  ['oil_fat', ['oil', 'olive oil', 'vegetable oil', 'canola', 'sunflower oil', 'coconut oil', 'sesame oil', 'ghee', 'lard', 'shortening', 'margarine', 'cooking spray', 'fat']],
  ['sweetener', ['sugar', 'honey', 'maple syrup', 'agave', 'stevia', 'brown sugar', 'powdered sugar', 'jaggery', 'molasses', 'sweetener', 'syrup']],
];

/** Infer an ingredient category from its name. */
export function inferCategory(name: string): IngredientCategory {
  const key = normalizeForCategory(name);
  if (!key) return 'other';

  let best: { category: IngredientCategory; score: number } = { category: 'other', score: 0 };

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      const kw = keyword.trim();
      if (!kw) continue;
      let score = 0;
      if (key === kw) score = 100;
      else if (key.startsWith(`${kw} `) || key.endsWith(` ${kw}`)) score = 60;
      else if (key.includes(kw)) score = 30;
      if (score > best.score) best = { category, score };
      if (best.score === 100) return best.category;
    }
  }
  return best.category;
}

/** Coerce a free-form category string from an AI model to our enum. */
export function coerceCategory(value: unknown): IngredientCategory {
  if (typeof value !== 'string') return 'other';
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const direct = (INGREDIENT_CATEGORIES as readonly string[]).find((c) => c === v);
  if (direct) return direct as IngredientCategory;

  const ALIASES: Record<string, IngredientCategory> = {
    veggie: 'vegetable', vegetables: 'vegetable', veggies: 'vegetable', greens: 'vegetable',
    fruits: 'fruit', produce: 'fruit',
    egg: 'dairy', eggs: 'dairy', dairy_and_eggs: 'dairy', cheese: 'dairy', milk: 'dairy',
    poultry: 'meat', red_meat: 'meat', meat_and_poultry: 'meat',
    fish: 'seafood', shellfish: 'seafood', seafood_and_fish: 'seafood',
    grains: 'grain', grain_and_pasta: 'grain', bread: 'bakery', bakery_item: 'bakery',
    spices: 'spice', herbs: 'spice', herbs_and_spices: 'spice', seasoning: 'spice',
    sauces: 'condiment', condiments_and_sauces: 'condiment', sauce: 'condiment',
    drinks: 'beverage', beverages: 'beverage',
    snacks: 'snack',
    frozen_food: 'frozen', frozen_foods: 'frozen',
    canned_goods: 'canned', jarred: 'canned', pantry_staple: 'canned',
    beans: 'legume', legumes: 'legume', pulses: 'legume',
    nuts: 'nut_seed', nuts_and_seeds: 'nut_seed', seeds: 'nut_seed',
    oils: 'oil_fat', oils_and_fats: 'oil_fat', fats: 'oil_fat',
    sweeteners: 'sweetener', sugars: 'sweetener',
  };
  if (ALIASES[v]) return ALIASES[v] as IngredientCategory;
  return inferCategory(v);
}

// ---------------------------------------------------------------------------
// Units & quantity parsing
// ---------------------------------------------------------------------------

const UNIT_ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gm: 'g', gr: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp',
  piece: 'pieces', pcs: 'pieces', pc: 'pieces', unit: 'pieces', units: 'pieces', count: 'pieces',
  clove: 'cloves',
  slice: 'slices',
  can: 'cans', tin: 'cans',
  bunch: 'bunches',
  head: 'heads',
  medium: 'medium', large: 'large', small: 'small',
  pinch: 'pinch', dash: 'dash', handful: 'handful',
  cup: 'cups',
};

export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase();
  if (!u) return null;
  return UNIT_ALIASES[u] ?? u;
}

export interface ParsedQuantity {
  quantity: number | null;
  unit: string | null;
}

/**
 * Parse a free-text quantity such as "250 g", "3 pieces", "1/2 cup",
 * "about 2 large", "a pinch".
 */
export function parseQuantity(raw: string | null | undefined): ParsedQuantity {
  if (!raw) return { quantity: null, unit: null };
  const text = String(raw).trim().toLowerCase();
  if (!text) return { quantity: null, unit: null };

  // Special words first.
  const words: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, dozen: 12, half: 0.5, quarter: 0.25, pinch: 0.36, dash: 0.62, handful: 1,
  };

  let quantity: number | null = null;

  // Fractions like "1/2", "3/4", or mixed "1 1/2".
  const fractionMatch = text.match(/(\d+\s+)?(\d+)\s*\/\s*(\d+)/);
  if (fractionMatch) {
    const whole = fractionMatch[1] ? Number(fractionMatch[1].trim()) : 0;
    const num = Number(fractionMatch[2]);
    const den = Number(fractionMatch[3]);
    if (den > 0) quantity = whole + num / den;
  }

  if (quantity === null) {
    const numMatch = text.match(/\d+(?:\.\d+)?/);
    if (numMatch) quantity = Number(numMatch[0]);
  }

  if (quantity === null) {
    for (const [word, value] of Object.entries(words)) {
      if (text.startsWith(word) || text === word) {
        quantity = value;
        break;
      }
    }
  }

  // Unit: first alphabetic token that is a known unit (or alias).
  let unit: string | null = null;
  // Vision models and pack labels routinely emit "500ml" / "250g" with no space.
  // Split digit-letter boundaries first so those still yield a unit.
  const tokens = text
    .replace(/[^a-z0-9/\s]/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (/^\d/.test(token) || token.includes('/')) continue;
    const normalized = UNIT_ALIASES[token] ?? token;
    if (Object.prototype.hasOwnProperty.call(UNIT_TO_GRAMS, normalized) || UNIT_ALIASES[token]) {
      unit = normalized;
      break;
    }
  }

  return {
    quantity: quantity === null ? null : Math.round(quantity * 1000) / 1000,
    unit: unit ? normalizeUnit(unit) : null,
  };
}

/** Convert any quantity to grams (best effort) for nutrition math. */
export function toGrams(quantity: number | null, unit: string | null): number | null {
  if (quantity == null) return null;
  const u = normalizeUnit(unit);
  if (!u) return quantity; // treat a bare count as ~1 "unit"
  const factor = UNIT_TO_GRAMS[u];
  return factor != null ? quantity * factor : quantity;
}

/** Human-friendly quantity rendering: 250 g, 3 pieces, 1.5 cups. */
export function formatQuantity(quantity: number | null | undefined, unit: string | null | undefined): string {
  if (quantity == null) return unit ? `some ${unit}` : '';
  const rounded = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${rounded} ${unit}` : rounded;
}

/** Scale a recipe quantity for a different number of servings. */
export function scaleQuantity(quantity: number | null, fromServings: number, toServings: number): number | null {
  if (quantity == null || !fromServings) return quantity;
  const scaled = (quantity * toServings) / fromServings;
  // Keep kitchen-friendly precision.
  return Math.round(scaled * 100) / 100;
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/** Levenshtein distance (bounded, so long strings don't blow up). */
export function levenshtein(a: string, b: string, max = 12): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Similarity in 0..1 combining substring containment and edit distance.
 * Used to dedupe AI detections and to match pantry ⇄ recipe ingredients.
 */
export function similarity(a: string, b: string): number {
  const x = normalizeIngredient(a);
  const y = normalizeIngredient(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length);
    const longer = Math.max(x.length, y.length);
    return 0.75 + 0.25 * (shorter / longer);
  }
  const distance = levenshtein(x, y);
  const longest = Math.max(x.length, y.length);
  return Math.max(0, 1 - distance / longest);
}

/** Match threshold used when merging duplicate detections. */
export const SIMILARITY_THRESHOLD = 0.82;

export interface MatchedIngredient {
  pantryId: string;
  pantryName: string;
  score: number;
  quantity: number | null;
  unit: string | null;
}

/**
 * Find the best pantry item for a recipe ingredient name.
 * Returns null when nothing scores above the threshold.
 */
export function matchIngredient(
  recipeIngredient: string,
  pantry: Array<{ id: string; ingredientName: string; quantity: number | null; unit: string | null }>,
  threshold = SIMILARITY_THRESHOLD,
): MatchedIngredient | null {
  let best: MatchedIngredient | null = null;

  for (const item of pantry) {
    const score = similarity(recipeIngredient, item.ingredientName);
    if (score >= threshold && (!best || score > best.score)) {
      best = {
        pantryId: item.id,
        pantryName: item.ingredientName,
        score,
        quantity: item.quantity,
        unit: item.unit,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Shelf life & CO₂
// ---------------------------------------------------------------------------

/**
 * Default shelf life in days from purchase, by normalised ingredient key.
 * Conservative values — the app always prefers an AI-read label when present.
 */
export const SHELF_LIFE_DAYS: Array<[RegExp, number]> = [
  [/leafy|spinach|lettuce|kale|arugula|rocket|bok choy/, 4],
  [/mushroom/, 5],
  [/berry|berries|strawberr|raspberr|blueberr|blackberr/, 3],
  [/banana/, 5],
  [/avocado/, 4],
  [/tomato|cucumber|pepper|zucchini|eggplant|aubergine/, 7],
  [/apple|orange|lemon|lime|pear|peach|plum|grape|melon/, 14],
  [/potato|onion|garlic|carrot|beet|turnip|squash|pumpkin/, 30],
  [/milk|buttermilk|kefir/, 7],
  [/yogurt|yoghurt|curd/, 10],
  [/cream|sour cream/, 7],
  [/soft cheese|ricotta|cottage|cream cheese|mozzarella|feta|paneer/, 10],
  [/cheese/, 30],
  [/butter|ghee|margarine/, 90],
  [/egg/, 28],
  [/chicken|turkey|duck/, 2],
  [/beef|pork|lamb|mutton|veal|goat|steak|mince/, 3],
  [/bacon|ham|sausage|salami|chorizo/, 7],
  [/fish|salmon|tuna|cod|trout|tilapia|mackerel/, 2],
  [/shrimp|prawn|crab|lobster|squid|mussel|clam|oyster|scallop/, 2],
  [/bread|bagel|bun|roll/, 5],
  [/cake|muffin|pastry|croissant/, 3],
  [/cooked|leftover|prepared/, 3],
  [/rice|pasta|flour|oats|quinoa|barley|couscous|noodle/, 365],
  [/bean|lentil|chickpea|dal|legume/, 365],
  [/oil|vinegar/, 365],
  [/sugar|honey|salt|spice|masala/, 730],
  [/canned|tin|jar/, 730],
  [/frozen|ice cream/, 180],
];

export function defaultShelfLifeDays(name: string): number {
  const key = normalizeForCategory(name);
  for (const [pattern, days] of SHELF_LIFE_DAYS) {
    if (pattern.test(key)) return days;
  }
  return 7;
}

/** kg CO2e for a wasted quantity, based on category and mass. */
export function co2ForWaste(quantity: number | null, unit: string | null, category: IngredientCategory | string | null): number {
  const grams = toGrams(quantity, unit);
  if (grams == null) return 0;
  const kg = grams / 1000;
  const factor = CO2_PER_KG_BY_CATEGORY[(category as IngredientCategory) ?? 'other'] ?? 1.2;
  return Math.round(kg * factor * 100) / 100;
}

// ---------------------------------------------------------------------------
// Price index (fallback when no grocery API key is configured)
// ---------------------------------------------------------------------------

/** Approximate USD price per common unit — keeps cost estimates useful offline. */
export const PRICE_INDEX_USD: Array<[RegExp, { unitPrice: number; unit: string }]> = [
  [/chicken breast/, { unitPrice: 7.5, unit: 'kg' }],
  [/chicken|turkey/, { unitPrice: 6.0, unit: 'kg' }],
  [/beef|steak|lamb|mutton/, { unitPrice: 12.0, unit: 'kg' }],
  [/pork|bacon|ham|sausage/, { unitPrice: 8.0, unit: 'kg' }],
  [/salmon|tuna|fish/, { unitPrice: 14.0, unit: 'kg' }],
  [/shrimp|prawn|seafood/, { unitPrice: 16.0, unit: 'kg' }],
  [/egg/, { unitPrice: 0.35, unit: 'pieces' }],
  [/milk/, { unitPrice: 1.2, unit: 'l' }],
  [/cheese|paneer|mozzarella|cheddar/, { unitPrice: 12.0, unit: 'kg' }],
  [/yogurt|yoghurt|curd/, { unitPrice: 4.0, unit: 'kg' }],
  [/butter|ghee/, { unitPrice: 9.0, unit: 'kg' }],
  [/cream/, { unitPrice: 6.0, unit: 'l' }],
  [/rice|basmati/, { unitPrice: 2.5, unit: 'kg' }],
  [/pasta|spaghetti|noodle/, { unitPrice: 2.2, unit: 'kg' }],
  [/flour/, { unitPrice: 1.2, unit: 'kg' }],
  [/bread|naan|pita|tortilla/, { unitPrice: 2.8, unit: 'pieces' }],
  [/oats/, { unitPrice: 3.0, unit: 'kg' }],
  [/quinoa/, { unitPrice: 8.0, unit: 'kg' }],
  [/tomato/, { unitPrice: 2.5, unit: 'kg' }],
  [/onion/, { unitPrice: 1.4, unit: 'kg' }],
  [/garlic/, { unitPrice: 8.0, unit: 'kg' }],
  [/potato/, { unitPrice: 1.2, unit: 'kg' }],
  [/carrot/, { unitPrice: 1.6, unit: 'kg' }],
  [/spinach|lettuce|kale|leafy/, { unitPrice: 5.0, unit: 'kg' }],
  [/broccoli|cauliflower|cabbage/, { unitPrice: 2.8, unit: 'kg' }],
  [/pepper|chili|chilli/, { unitPrice: 4.0, unit: 'kg' }],
  [/mushroom/, { unitPrice: 7.0, unit: 'kg' }],
  [/cucumber|zucchini|eggplant/, { unitPrice: 2.4, unit: 'kg' }],
  [/banana/, { unitPrice: 1.3, unit: 'kg' }],
  [/apple|orange|pear/, { unitPrice: 2.6, unit: 'kg' }],
  [/avocado/, { unitPrice: 1.8, unit: 'pieces' }],
  [/lemon|lime/, { unitPrice: 0.5, unit: 'pieces' }],
  [/berry|berries|strawberr|blueberr/, { unitPrice: 9.0, unit: 'kg' }],
  [/mango|pineapple|melon/, { unitPrice: 3.5, unit: 'pieces' }],
  [/bean|lentil|chickpea|dal/, { unitPrice: 3.2, unit: 'kg' }],
  [/almond|cashew|walnut|nut/, { unitPrice: 16.0, unit: 'kg' }],
  [/oil|olive oil/, { unitPrice: 8.0, unit: 'l' }],
  [/sugar|honey/, { unitPrice: 4.0, unit: 'kg' }],
  [/spice|masala|cumin|turmeric|paprika/, { unitPrice: 24.0, unit: 'kg' }],
  [/sauce|ketchup|mustard|vinegar|soy/, { unitPrice: 4.5, unit: 'l' }],
];

/** Estimate a price for an ingredient quantity in USD. */
export function estimatePriceUsd(name: string, quantity: number | null, unit: string | null): number {
  const key = normalizeIngredient(name);
  let entry: { unitPrice: number; unit: string } | null = null;
  for (const [pattern, value] of PRICE_INDEX_USD) {
    if (pattern.test(key)) {
      entry = value;
      break;
    }
  }
  if (!entry) return 1.25; // sane default for unrecognised items

  if (quantity == null) {
    return entry.unit === 'pieces' ? round2(entry.unitPrice) : round2(entry.unitPrice * 0.5);
  }

  if (entry.unit === 'pieces') {
    return round2(entry.unitPrice * quantity);
  }
  const grams = toGrams(quantity, unit) ?? quantity;
  return round2((grams / 1000) * entry.unitPrice);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Staple detection
// ---------------------------------------------------------------------------

/** Pantry staples we assume the user always has (recipe prompt rule #4). */
export const ASSUMED_STAPLES = [
  'salt', 'black pepper', 'pepper', 'cooking oil', 'oil', 'vegetable oil', 'olive oil',
  'water', 'sugar', 'flour', 'butter',
];

export function isAssumedStaple(name: string): boolean {
  const key = normalizeIngredient(name);
  return ASSUMED_STAPLES.some((s) => key === s || key.includes(s));
}
