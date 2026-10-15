/**
 * Zod → JSON Schema bridge for @fastify/swagger.
 *
 * Route handlers validate with Zod (so users see the friendly messages the app
 * is written against) while the OpenAPI document is generated from JSON Schema.
 * Deriving the document from the same Zod schema keeps the two from drifting.
 *
 * Only the subset of Zod that PlateMatch actually uses is translated; anything
 * unrecognised degrades to `{}` (accepts any value) rather than failing the
 * build, which keeps documentation generation non-fatal.
 */


/**
 * Convert a Zod schema into the JSON-Schema subset @fastify/swagger accepts.
 *
 * We keep the Zod schema as the runtime validator (it produces the friendly
 * messages the app shows) and derive the documented shape from it, so the two
 * can never disagree.
 */
export function jsonSchemaFrom(schema: { _def: unknown }): Record<string, unknown> {
  return zodDescriptionToJsonSchema(schema._def as Record<string, unknown>);
}

interface ZodNode {
  typeName?: string;
  type?: string;
  items?: ZodNode | ZodNode[];
  values?: unknown[];
  checks?: Array<{ kind: string; value?: number; regex?: { source: string; flags: string } }>;
  shape?: () => Record<string, ZodNode>;
  innerType?: ZodNode;
  options?: ZodNode[];
  keys?: Record<string, ZodNode>;
  valueType?: ZodNode;
}

/**
 * Unwrap whatever we were handed into a raw Zod `_def` node.
 *
 * `ZodObject._def.shape()` returns **ZodType instances**, not defs — the def
 * lives one level down at `instance._def`. Walking an instance as if it were a
 * def leaves `typeName` undefined, which silently degrades every property to `{}`
 * and marks every field required (so an `.optional()` field 422s on a valid
 * request). This normaliser accepts either shape, and recurses through the
 * nested structures that also hold instances rather than defs.
 */
/**
 * Unwrap whatever we were handed into a **copy** of its raw Zod `_def` node.
 *
 * Two things make this non-trivial, and both were bugs:
 *
 * 1. `ZodObject._def.shape()` returns ZodType *instances*, not defs — the def
 *    lives one level down at `instance._def`. Walking an instance as if it were
 *    a def leaves `typeName` undefined, which silently degrades every property
 *    to `{}` and marks every field required (so an `.optional()` field 422s on a
 *    valid request).
 *
 * 2. This must NOT mutate. The shared schemas are module-level singletons used
 *    by the API to validate real traffic; assigning `def.innerType = <plain
 *    object>` replaced a live `ZodOptional`'s inner schema and made every later
 *    `safeParse` throw `this._def.innerType._parse is not a function`. Route
 *    registration runs at boot, so that corruption would have been global.
 *
 * So: read-only traversal that builds fresh plain objects all the way down.
 */
function toDef(node: unknown): ZodNode {
  if (node === null || typeof node !== 'object') return {} as ZodNode;

  const candidate = node as { _def?: unknown };
  const source = (candidate._def ?? candidate) as Record<string, unknown>;

  const out: Record<string, unknown> = { ...source };

  if (source.innerType !== undefined) out.innerType = toDef(source.innerType);
  if (Array.isArray(source.options)) out.options = source.options.map((option) => toDef(option));
  if (Array.isArray(source.items)) out.items = source.items.map((item) => toDef(item));
  else if (source.items && typeof source.items === 'object') out.items = toDef(source.items);
  if (source.valueType && typeof source.valueType === 'object') out.valueType = toDef(source.valueType);

  // `shape` stays a function; zodDescriptionToJsonSchema calls it and unwraps
  // each child itself.
  return out as unknown as ZodNode;
}

function zodDescriptionToJsonSchema(node: Record<string, unknown>): Record<string, unknown> {
  const root = toDef(node);

  if (typeof root.shape === 'function') {
    const shape = root.shape() as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(shape)) {
      const childDef = toDef(child);
      properties[key] = zodNodeToJsonSchema(childDef);
      if (!isOptionalNode(childDef)) required.push(key);
    }

    return { type: 'object', properties, required, additionalProperties: false };
  }

  return zodNodeToJsonSchema(root);
}

function isOptionalNode(node: ZodNode): boolean {
  if (node.typeName === 'ZodOptional' || node.typeName === 'ZodDefault') return true;
  if (node.innerType) return isOptionalNode(node.innerType);
  return false;
}

function zodNodeToJsonSchema(node: ZodNode): Record<string, unknown> {
  switch (node.typeName) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const check of node.checks ?? []) {
        if (check.kind === 'max' && typeof check.value === 'number') out.maxLength = check.value;
        if (check.kind === 'min' && typeof check.value === 'number') out.minLength = check.value;
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'url') out.format = 'uri';
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' };
      let integer = false;
      for (const check of node.checks ?? []) {
        if (check.kind === 'int') integer = true;
        if (check.kind === 'max' && typeof check.value === 'number') out.maximum = check.value;
        if (check.kind === 'min' && typeof check.value === 'number') out.minimum = check.value;
      }
      if (integer) out.type = 'integer';
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: (node.values ?? []).map(String) };
    case 'ZodArray': {
      const inner = Array.isArray(node.items) ? node.items[0] : node.items;
      return { type: 'array', items: inner ? zodNodeToJsonSchema(inner) : {} };
    }
    case 'ZodOptional':
      return node.innerType ? zodNodeToJsonSchema(node.innerType) : {};
    case 'ZodDefault': {
      const inner = node.innerType ? zodNodeToJsonSchema(node.innerType) : {};
      return inner;
    }
    case 'ZodNullable': {
      const inner = node.innerType ? zodNodeToJsonSchema(node.innerType) : {};
      return { ...inner, nullable: true };
    }
    case 'ZodUnion': {
      const branches = (node.options ?? []).map(zodNodeToJsonSchema);
      return { anyOf: branches };
    }
    case 'ZodEffects':
      return node.innerType ? zodNodeToJsonSchema(node.innerType) : {};
    case 'ZodObject':
      return zodDescriptionToJsonSchema(node as unknown as Record<string, unknown>);
    case 'ZodRecord':
      return { type: 'object', additionalProperties: node.valueType ? zodNodeToJsonSchema(node.valueType) : {} };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    default:
      return {};
  }
}

/**
 * The `meta` block every paginated list endpoint returns.
 *
 * Declared once here so the OpenAPI document cannot drift from what
 * `buildMeta()` actually emits — a client doing infinite scroll reads
 * `meta.total` / `meta.has_more`, so it must exist on *every* list route.
 */
export const PAGINATION_META_SCHEMA = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    has_more: { type: 'boolean' },
    next_cursor: { type: ['string', 'null'] },
  },
} as const;

/** Standard `{ data: [...], meta }` response body for a paginated collection. */
export function paginatedResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      meta: PAGINATION_META_SCHEMA,
    },
  };
}

/** Shared OpenAPI response for every endpoint that returns a session. */
export function sessionResponse(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          user: { type: 'object', additionalProperties: true },
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          token_type: { type: 'string' },
          expires_in: { type: 'integer' },
        },
      },
    },
  };
}
