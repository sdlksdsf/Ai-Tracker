import { z } from 'zod';
import {
  FRESHNESS_LEVELS,
  INGREDIENT_CATEGORIES,
  SCAN_SOURCES,
  SCAN_STATUSES,
  STORAGE_LOCATIONS,
  UPLOAD_LIMITS,
} from '../constants/index.js';

// ---------------------------------------------------------------------------
// Pantry items
// ---------------------------------------------------------------------------

export const ingredientNameSchema = z
  .string()
  .trim()
  .min(1, 'Ingredient name is required')
  .max(100, 'Ingredient name is too long');

export const quantitySchema = z.number().positive('Quantity must be positive').max(99999).optional().nullable();

export const unitSchema = z.string().trim().max(20).optional().nullable();

export const expiryDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD')
  .optional()
  .nullable();

export const purchaseDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Purchase date must be YYYY-MM-DD')
  .optional()
  .nullable();

export const createPantryItemSchema = z.object({
  ingredient_name: ingredientNameSchema,
  category: z.enum(INGREDIENT_CATEGORIES).default('other'),
  quantity: quantitySchema,
  unit: unitSchema,
  expiry_date: expiryDateSchema,
  purchase_date: purchaseDateSchema,
  added_via: z.enum(SCAN_SOURCES).default('manual'),
  ai_confidence: z.number().min(0).max(1).optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
  barcode: z.string().max(50).optional().nullable(),
  location: z.enum(STORAGE_LOCATIONS).default('fridge'),
});
export type CreatePantryItemInput = z.infer<typeof createPantryItemSchema>;

export const updatePantryItemSchema = createPantryItemSchema
  .partial()
  .extend({
    is_expired: z.boolean().optional(),
    is_used: z.boolean().optional(),
  });
export type UpdatePantryItemInput = z.infer<typeof updatePantryItemSchema>;

export const batchUsePantrySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export type BatchUsePantryInput = z.infer<typeof batchUsePantrySchema>;

export const listPantryQuerySchema = z.object({
  category: z.enum(INGREDIENT_CATEGORIES).optional(),
  location: z.enum(STORAGE_LOCATIONS).optional(),
  expired: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  used: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Free-text search on ingredient_name. */
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['expiry_date', 'created_at', 'name', 'category']).default('expiry_date'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListPantryQuery = z.infer<typeof listPantryQuerySchema>;

export const expiringSoonQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(3),
});
export type ExpiringSoonQuery = z.infer<typeof expiringSoonQuerySchema>;

// ---------------------------------------------------------------------------
// Fridge scanning
// ---------------------------------------------------------------------------

/** One item as returned by the vision models (normalised across providers). */
export const detectedItemSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(INGREDIENT_CATEGORIES).default('other'),
  estimated_quantity: z.string().max(40).optional().nullable(),
  estimated_unit: z.string().max(20).optional().nullable(),
  quantity: z.number().positive().optional().nullable(),
  unit: z.string().max(20).optional().nullable(),
  freshness: z.enum(FRESHNESS_LEVELS).default('fresh'),
  confidence: z.number().min(0).max(1).default(0),
  location_in_image: z.string().max(60).optional().nullable(),
  expiry_label_read: z.string().max(60).optional().nullable(),
  /** Normalised ISO date parsed from `expiry_label_read`, when parseable. */
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  /** Suggested shelf life in days when no label was readable. */
  suggested_shelf_life_days: z.number().int().min(0).max(3650).optional().nullable(),
  /** Bounding box from Cloud Vision (normalised 0..1). */
  bounding_box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional()
    .nullable(),
  /** Which model produced/confirmed this item. */
  detected_by: z.string().max(60).optional().nullable(),
});
export type DetectedItem = z.infer<typeof detectedItemSchema>;

export const scanRequestSchema = z.object({
  source: z.enum(['camera', 'gallery']).default('camera'),
  /** When true the caller waits for the AI result instead of polling. */
  wait: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Skip object-localisation (Cloud Vision) — saves cost/latency. */
  skip_boxes: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const confirmedItemSchema = z.object({
  name: ingredientNameSchema,
  category: z.enum(INGREDIENT_CATEGORIES).optional(),
  quantity: quantitySchema,
  unit: unitSchema,
  expiry_date: expiryDateSchema,
  purchase_date: purchaseDateSchema,
  location: z.enum(STORAGE_LOCATIONS).default('fridge'),
  ai_confidence: z.number().min(0).max(1).optional().nullable(),
  photo_url: z.string().url().optional().nullable(),
});
export type ConfirmedItem = z.infer<typeof confirmedItemSchema>;

export const confirmScanSchema = z.object({
  confirmed: z.array(confirmedItemSchema).max(200).default([]),
  /** Names/keys of AI detections the user rejected. */
  removed: z.array(z.string().max(120)).max(200).default([]),
  /** Items the user added manually because the AI missed them. */
  added: z.array(confirmedItemSchema).max(200).default([]),
  /** Names of items the user edited before confirming. */
  corrected: z.array(z.string().max(120)).max(200).default([]),
});
export type ConfirmScanInput = z.infer<typeof confirmScanSchema>;

export const scanStatusSchema = z.object({
  scan_id: z.string().uuid(),
  status: z.enum(SCAN_STATUSES),
  progress: z.number().min(0).max(100).default(0),
  estimated_time_s: z.number().int().nonnegative().default(5),
  detected_items: z.array(detectedItemSchema).default([]),
  overall_fridge_status: z.string().nullable().optional(),
  suggestions: z.array(z.string()).default([]),
  error: z.string().nullable().optional(),
  ai_model_used: z.string().nullable().optional(),
  processing_time_ms: z.number().int().nullable().optional(),
});
export type ScanStatusDto = z.infer<typeof scanStatusSchema>;

export const scanDtoSchema = scanStatusSchema.extend({
  photo_url: z.string().nullable(),
  created_at: z.string(),
  items_confirmed_count: z.number().int(),
  items_corrected_count: z.number().int(),
  items_removed_count: z.number().int(),
  items_added_count: z.number().int(),
});
export type ScanDto = z.infer<typeof scanDtoSchema>;

export const scanHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ScanHistoryQuery = z.infer<typeof scanHistoryQuerySchema>;

/** Re-exported so the API multipart handler and the client agree on limits. */
export const SCAN_UPLOAD_LIMITS = UPLOAD_LIMITS;
