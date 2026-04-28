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

export function wrapSchemaWithCoercion(schema: ZodTypeAny): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const newShape: Record<string, ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    newShape[key] = wrapField(field, key);
  }
  return z.object(newShape);
}
