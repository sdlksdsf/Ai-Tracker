import { ALLERGEN_INGREDIENT_KEYWORDS, DIETARY_EXCLUSIONS, type DietaryPreference } from '@platematch/shared';
import { normalizeIngredient, pluralize, singularize } from '../../utils/food.js';
import { logger } from '../../lib/logger.js';
import type { AiRecipe } from './types.js';

/**
 * Allergen & diet safety guard  ⚠️ SAFETY-CRITICAL
 * ===========================================================================
 * The model is *instructed* never to use an allergen — but instructions are not
 * a guarantee, and an allergy mistake can be fatal. This module is the
 * deterministic, offline safety net that runs on EVERY model output before it
 * is persisted or shown to a user.
 *
 * It is intentionally over-blocking: substring matches on normalised names,
 * plural folding, and explicit keyword families per allergen. A false positive
 * costs a recipe; a false negative costs a hospital visit.
 *
 * Called from:
 *   • recipe.service   — after generation, before DB write
 *   • mealplan.service — after generation, before DB write
 *   • scan → confirm   — advisory warnings on pantry items
 */

export interface GuardContext {
  allergies: Array<{ allergen: string; severity: string }>;
  dietaryPreference: DietaryPreference | string;
  /** Extra ingredients the user asked to avoid. */
  avoid: string[];
}

export interface Violation {
  ingredient: string;
  matched: string;
  kind: 'allergen' | 'diet' | 'avoid';
  allergen?: string;
  severity?: string;
}

export interface GuardReport {
  safe: boolean;
  violations: Violation[];
  /** Human-readable warnings surfaced in the UI. */
  warnings: string[];
}

/**
 * Build the keyword set for an allergen (family keywords + the name itself).
 *
 * ⚠️ The lookup MUST try every spelling variant of the allergen name. The
 * keyword table is keyed by the *display* form used in `COMMON_ALLERGENS`
 * ("peanuts", "tree nuts", "shellfish"), but `normalizeIngredient` singularises,
 * so a naive `TABLE[normalizeIngredient('peanuts')]` looks up "peanut" and
 * silently finds nothing — losing the whole groundnut/arachis/monkey-nuts
 * family for exactly the users who need it most.
 *
 * Failing closed here means an unknown allergen still matches its own name, so
 * the guard degrades to "literal name matching" rather than "no matching".
 */
function keywordsFor(allergen: string): string[] {
  const raw = allergen.trim().toLowerCase();
  const key = normalizeIngredient(allergen);

  // Every plausible spelling of the declared allergen, so the family table is
  // actually found whichever form the user (or the onboarding UI) stored.
  const candidateKeys = new Set<string>([raw, key, singularize(key), pluralize(key)]);

  const family = new Set<string>();
  for (const candidate of candidateKeys) {
    for (const keyword of ALLERGEN_INGREDIENT_KEYWORDS[candidate] ?? []) family.add(keyword);
  }

  // The allergen's own names are keywords too: a user who declares "groundnut"
  // is protected against "peanut butter" via the reverse family membership.
  const reverse = reverseFamilyFor(candidateKeys);

  const set = new Set<string>([...candidateKeys, ...family, ...reverse].map(normalizeIngredient));
  set.delete('');
  return [...set];
}

/**
 * Aliases that point back at the declared allergen.
 *
 * `ALLERGEN_INGREDIENT_KEYWORDS.peanuts` contains "groundnut"; a user who
 * declares "groundnut" therefore needs "peanut" treated as the same allergen.
 * Built once and memoised — the table is static.
 */
let reverseFamilyCache: Map<string, string[]> | null = null;

function reverseFamily(): Map<string, string[]> {
  if (reverseFamilyCache) return reverseFamilyCache;

  const map = new Map<string, string[]>();
  for (const [allergen, keywords] of Object.entries(ALLERGEN_INGREDIENT_KEYWORDS)) {
    const names = [allergen, ...keywords].map(normalizeIngredient).filter(Boolean);
    for (const name of names) {
      const bucket = map.get(name) ?? [];
      for (const sibling of names) {
        if (sibling !== name && !bucket.includes(sibling)) bucket.push(sibling);
      }
      map.set(name, bucket);
    }
  }

  reverseFamilyCache = map;
  return map;
}

function reverseFamilyFor(candidateKeys: Iterable<string>): string[] {
  const table = reverseFamily();
  const out = new Set<string>();
  for (const candidate of candidateKeys) {
    for (const sibling of table.get(candidate) ?? []) out.add(sibling);
  }
  return [...out];
}

/** Does one ingredient string trip a restriction list? */
export function findViolation(
  ingredientName: string,
  context: GuardContext,
): Violation | null {
  const key = normalizeIngredient(ingredientName);
  if (!key) return null;

  // 1. Allergens — highest priority.
  for (const { allergen, severity } of context.allergies) {
    for (const keyword of keywordsFor(allergen)) {
      if (matches(key, keyword)) {
        return { ingredient: ingredientName, matched: keyword, kind: 'allergen', allergen, severity };
      }
    }
  }

  // 2. Dietary preference exclusions.
  const exclusions = DIETARY_EXCLUSIONS[context.dietaryPreference as DietaryPreference] ?? [];
  for (const excluded of exclusions) {
    const ex = normalizeIngredient(excluded);
    if (ex && matches(key, ex)) {
      return { ingredient: ingredientName, matched: ex, kind: 'diet', allergen: excluded };
    }
  }

  // 3. User's explicit "avoid" list.
  for (const avoided of context.avoid) {
    const av = normalizeIngredient(avoided);
    if (av && matches(key, av)) {
      return { ingredient: ingredientName, matched: av, kind: 'avoid', allergen: avoided };
    }
  }

  return null;
}

/**
 * Match rule: exact, word-boundary, or containment in either direction.
 * Containment in either direction is aggressive by design — "cashew butter"
 * must trip "cashew", and "peanut" must trip "roasted peanuts".
 */
function matches(ingredientKey: string, keyword: string): boolean {
  if (!keyword) return false;
  if (ingredientKey === keyword) return true;
  if (ingredientKey.includes(keyword)) return true;
  if (keyword.length >= 4 && keyword.includes(ingredientKey)) return true;
  return false;
}

/** Audit a whole recipe. */
export function auditRecipe(recipe: AiRecipe, context: GuardContext): GuardReport {
  const violations: Violation[] = [];

  const checkText = (text: string, source: 'ingredient' | 'step' | 'title') => {
    // Ingredients are checked as whole names; steps are tokenised loosely so we
    // catch "stir in the peanut oil" hidden inside an instruction.
    if (source === 'ingredient') {
      const violation = findViolation(text, context);
      if (violation) violations.push(violation);
      return;
    }
    const key = normalizeIngredient(text);
    for (const { allergen, severity } of context.allergies) {
      for (const keyword of keywordsFor(allergen)) {
        // Only flag multi-word-safe keywords inside prose to limit false hits.
        if (keyword.length >= 5 && key.includes(keyword)) {
          violations.push({ ingredient: `${source}: "${truncate(text)}"`, matched: keyword, kind: 'allergen', allergen, severity });
        }
      }
    }
  };

  checkText(recipe.title, 'title');
  for (const ingredient of recipe.ingredients) {
    checkText(ingredient.name, 'ingredient');
    for (const sub of ingredient.substitutes ?? []) {
      const violation = findViolation(sub, context);
      if (violation) {
        violations.push({
          ...violation,
          ingredient: `${ingredient.name} → substitute "${sub}"`,
        });
      }
    }
  }
  for (const step of recipe.steps) checkText(step.instruction, 'step');

  const deduped = dedupeViolations(violations);
  const severe = deduped.filter((v) => v.kind === 'allergen' && v.severity === 'severe');

  return {
    safe: deduped.length === 0,
    violations: deduped,
    warnings: buildWarnings(deduped, severe.length > 0),
  };
}

function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.kind}:${v.matched}:${v.ingredient}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function buildWarnings(violations: Violation[], hasSevere: boolean): string[] {
  const warnings: string[] = [];
  const allergens = [...new Set(violations.filter((v) => v.kind === 'allergen').map((v) => v.allergen ?? v.matched))];
  if (allergens.length) {
    warnings.push(
      hasSevere
        ? `⚠️ Cross-contamination warning: this recipe references ${allergens.join(', ')}. With a severe allergy, do not prepare it in a shared kitchen without verified-safe equipment.`
        : `This recipe references ${allergens.join(', ')}, which is on your allergy list.`,
    );
  }
  const dietHits = [...new Set(violations.filter((v) => v.kind === 'diet').map((v) => v.matched))];
  if (dietHits.length) warnings.push(`Not compatible with your diet: contains ${dietHits.join(', ')}.`);
  const avoidHits = [...new Set(violations.filter((v) => v.kind === 'avoid').map((v) => v.matched))];
  if (avoidHits.length) warnings.push(`Contains ingredients you asked to avoid: ${avoidHits.join(', ')}.`);
  return warnings;
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Attempt to repair a recipe by removing offending ingredients and their
 * substitutes. Steps cannot be safely rewritten, so a violation *in a step*
 * always rejects the whole recipe.
 */
export interface SanitizeResult {
  recipe: AiRecipe | null;
  removed: string[];
  rejected: boolean;
  reason?: string;
}

export function sanitizeRecipe(recipe: AiRecipe, context: GuardContext): SanitizeResult {
  const report = auditRecipe(recipe, context);
  if (report.safe) return { recipe, removed: [], rejected: false };

  const stepOrTitleViolations = report.violations.filter((v) => v.ingredient.startsWith('step:') || v.ingredient.startsWith('title:'));
  if (stepOrTitleViolations.length) {
    logger.warn(
      { title: recipe.title, violations: stepOrTitleViolations.map((v) => v.matched) },
      'Recipe rejected by the allergen guard (violation in title/steps)',
    );
    return {
      recipe: null,
      removed: [],
      rejected: true,
      reason: `Unsafe content in the recipe text: ${[...new Set(stepOrTitleViolations.map((v) => v.matched))].join(', ')}`,
    };
  }

  // Ingredient-only violations: drop them (and keep the recipe if it is still viable).
  const removed: string[] = [];
  const cleaned = recipe.ingredients.filter((ingredient) => {
    const violation = findViolation(ingredient.name, context);
    const badSubstitutes = (ingredient.substitutes ?? []).some((s) => findViolation(s, context));
    if (violation || badSubstitutes) {
      removed.push(ingredient.name);
      return false;
    }
    return true;
  });

  if (cleaned.length < 2) {
    return { recipe: null, removed, rejected: true, reason: 'Too few safe ingredients remained after filtering' };
  }

  // A recipe whose main protein was removed is no longer the dish it claimed to be.
  const removedProtein = removed.some((name) =>
    ['chicken', 'beef', 'fish', 'shrimp', 'egg', 'tofu', 'paneer', 'pork', 'lamb'].some((p) =>
      normalizeIngredient(name).includes(p),
    ),
  );
  if (removedProtein) {
    return { recipe: null, removed, rejected: true, reason: 'Core ingredient removed by the allergen guard' };
  }

  const safeRecipe: AiRecipe = {
    ...recipe,
    ingredients: cleaned,
    allergen_warnings: [
      ...recipe.allergen_warnings,
      `Automatically removed for your safety: ${removed.join(', ')}.`,
    ],
  };

  // Re-audit; if it is still unsafe, reject outright.
  const second = auditRecipe(safeRecipe, context);
  if (!second.safe) {
    return { recipe: null, removed, rejected: true, reason: 'Still unsafe after sanitisation' };
  }

  logger.info({ title: recipe.title, removed }, 'Recipe sanitised by the allergen guard');
  return { recipe: safeRecipe, removed, rejected: false };
}

/** Filter a batch, keeping only safe recipes. */
export function guardBatch(recipes: AiRecipe[], context: GuardContext): { recipes: AiRecipe[]; notes: string[] } {
  const notes: string[] = [];
  const out: AiRecipe[] = [];

  for (const recipe of recipes) {
    const result = sanitizeRecipe(recipe, context);
    if (result.rejected) {
      notes.push(`Rejected "${recipe.title}": ${result.reason ?? 'failed the safety check'}`);
      continue;
    }
    if (result.removed.length) {
      notes.push(`Adjusted "${recipe.title}": removed ${result.removed.join(', ')} to match your restrictions`);
    }
    out.push(result.recipe as AiRecipe);
  }

  return { recipes: out, notes };
}
