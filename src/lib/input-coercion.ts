import { z, type ZodTypeAny } from 'zod';

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

function coerceField(schema: ZodTypeAny, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const inner = unwrap(schema);

  if (inner instanceof z.ZodNumber) {
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }

  if (inner instanceof z.ZodBoolean) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }

  if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (isPlainObject(parsed)) return parsed;
      } catch {
        /* fall through */
      }
      return value;
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
      out[key] = coerceField(shape[key], out[key]);
    }
  }
  return out;
}
