/**
 * @platematch/shared
 * ---------------------------------------------------------------------------
 * Single source of truth for the PlateMatch domain: Zod schemas (validated on
 * both the API and the mobile client), inferred TypeScript types and the
 * constant tables (enums, allergens, CO₂ factors, plan limits, …).
 */
export * from './constants/index.js';
export * from './schemas/index.js';
export * from './types/index.js';
