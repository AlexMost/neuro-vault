import { z, type ZodTypeAny } from 'zod';

export class CoerceError extends Error {
  readonly fieldName: string;
  readonly bareMessage: string;

  constructor(fieldName: string, bareMessage: string) {
    super(`${fieldName}: ${bareMessage}`);
    this.name = 'CoerceError';
    this.fieldName = fieldName;
    this.bareMessage = bareMessage;
  }
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    const unwrapped = (current as z.ZodOptional<ZodTypeAny>).unwrap();
    if (!unwrapped) break;
    current = unwrapped as ZodTypeAny;
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonShape(parsed: unknown): string {
  if (parsed === null) return 'null';
  if (Array.isArray(parsed)) return 'array';
  return typeof parsed;
}

function getUnionOptions(union: z.ZodUnion<z.ZodTypeAny[]>): ZodTypeAny[] {
  const def = (union as unknown as { _def: { options?: ZodTypeAny[] } })._def;
  return def.options ?? [];
}

function isStringArraySchema(schema: ZodTypeAny): boolean {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodArray)) return false;
  const def = (inner as unknown as { _def: { element?: ZodTypeAny; type?: ZodTypeAny } })._def;
  const element = def.element ?? def.type;
  if (!element) return false;
  return unwrap(element) instanceof z.ZodString;
}

export function coerceFieldValue(schema: ZodTypeAny, value: unknown, fieldName = 'value'): unknown {
  if (value === null || value === undefined) return value;
  const inner = unwrap(schema);

  if (inner instanceof z.ZodNumber) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.trim() === '') return value;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      throw new CoerceError(
        fieldName,
        `expected number or numeric string, got ${JSON.stringify(value)}`,
      );
    }
    return value;
  }

  if (inner instanceof z.ZodBoolean) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (typeof value === 'string') {
      throw new CoerceError(
        fieldName,
        `expected boolean or "true"/"false", got ${JSON.stringify(value)}`,
      );
    }
    return value;
  }

  if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) {
    if (isPlainObject(value)) return value;
    if (typeof value === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        throw new CoerceError(
          fieldName,
          `expected object or JSON-string of one, failed to parse: ${JSON.stringify(value)}`,
        );
      }
      if (isPlainObject(parsed)) return parsed;
      throw new CoerceError(
        fieldName,
        `expected object, parsed JSON resolved to ${describeJsonShape(parsed)}`,
      );
    }
    return value;
  }

  if (inner instanceof z.ZodUnion && typeof value === 'string') {
    const options = getUnionOptions(inner as z.ZodUnion<z.ZodTypeAny[]>);
    if (options.some(isStringArraySchema)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          return parsed;
        }
      } catch {
        /* not JSON — fall through, union's string branch will accept it */
      }
    }
    return value;
  }

  if (inner instanceof z.ZodArray && typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new CoerceError(
        fieldName,
        `expected array or JSON-string of one, failed to parse: ${JSON.stringify(value)}`,
      );
    }
    if (Array.isArray(parsed)) return parsed;
    throw new CoerceError(
      fieldName,
      `expected array, parsed JSON resolved to ${describeJsonShape(parsed)}`,
    );
  }

  return value;
}

export function coerceInput(schema: ZodTypeAny, value: unknown): unknown {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return value;
  if (!isPlainObject(value)) return value;

  const shape = inner.shape as Record<string, ZodTypeAny>;
  const out: Record<string, unknown> = { ...value };
  for (const key of Object.keys(shape)) {
    if (key in out) {
      out[key] = coerceFieldValue(shape[key], out[key], key);
    }
  }
  return out;
}

function wrapField(field: ZodTypeAny, fieldName: string): ZodTypeAny {
  let inner: ZodTypeAny = field;
  let isOptional = false;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    if (inner instanceof z.ZodOptional) isOptional = true;
    const next = (inner as z.ZodOptional<ZodTypeAny>).unwrap();
    if (!next) break;
    inner = next as ZodTypeAny;
  }
  const wrapped = z.preprocess((v, ctx) => {
    try {
      return coerceFieldValue(inner, v, fieldName);
    } catch (err) {
      if (err instanceof CoerceError) {
        ctx.addIssue({ code: 'custom', message: err.bareMessage });
        return z.NEVER;
      }
      throw err;
    }
  }, inner);
  return isOptional ? wrapped.optional() : wrapped;
}

function applyAliases(value: unknown, aliases: Record<string, string>): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in out) {
      if (!(canonical in out)) out[canonical] = out[alias];
      delete out[alias];
    }
  }
  return out;
}

function buildCoercedShape(schema: z.ZodObject): Record<string, ZodTypeAny> {
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const newShape: Record<string, ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    newShape[key] = wrapField(field, key);
  }
  return newShape;
}

export function wrapSchemaWithCoercion(
  schema: ZodTypeAny,
  aliases?: Record<string, string>,
): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const strict = z.object(buildCoercedShape(schema)).strict();
  if (!aliases || Object.keys(aliases).length === 0) return strict;
  return z.preprocess((v) => applyAliases(v, aliases), strict);
}

/**
 * The schema the MCP SDK receives for a tool: used BOTH to advertise the tool's
 * JSON input schema AND as the SDK's own pre-validation gate, which parses raw
 * args and throws BEFORE the handler runs. It must be a top-level `ZodObject`
 * (a `ZodPipe` from `z.preprocess` would advertise as an empty object).
 *
 * When the tool declares aliases the object is `.loose()` so the SDK passes the
 * alias key through to the handler (whose strict alias-renaming gate from
 * `wrapSchemaWithCoercion` is the real source of truth). In addition, every
 * alias-TARGET canonical field is made `.optional()` here: an alias-only call
 * (e.g. `{ filters }`) omits the required canonical key, and `.loose()` does not
 * relax required-field enforcement, so without this the SDK gate would reject the
 * call before the rename. Required-ness is still enforced by the handler gate
 * after the rename. (Consequence: for an alias tool the advertised schema is
 * looser than the real contract — `additionalProperties` is permissive and
 * alias-target fields show as not-required — an accepted minor inaccuracy; the
 * handler's strict gate is the real contract. Advertising the alias name itself
 * would violate the one-parameter-name rule, ADR-0005.) Without aliases it is
 * `.strict()`, identical to the handler schema (unchanged behavior).
 */
export function wrapSchemaForSdk(schema: ZodTypeAny, aliases?: Record<string, string>): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = buildCoercedShape(schema);
  if (!aliases || Object.keys(aliases).length === 0) {
    return z.object(shape).strict();
  }
  const relaxed: Record<string, ZodTypeAny> = { ...shape };
  for (const canonical of new Set(Object.values(aliases))) {
    if (canonical in relaxed) {
      relaxed[canonical] = relaxed[canonical].optional();
    }
  }
  return z.object(relaxed).loose();
}
