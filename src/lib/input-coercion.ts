import { z, type ZodTypeAny } from 'zod';

export class CoerceError extends Error {
  readonly fieldName: string;
  readonly bareMessage: string;
  /** Where under the field the value sat (`[1, 'lines', 0]`); empty for the field itself. */
  readonly path: readonly (string | number)[];

  constructor(fieldName: string, bareMessage: string, path: readonly (string | number)[] = []) {
    super(`${[fieldName, ...path].join('.')}: ${bareMessage}`);
    this.name = 'CoerceError';
    this.fieldName = fieldName;
    this.bareMessage = bareMessage;
    this.path = path;
  }
}

/** A value's place: its top-level field and the path below it. */
interface Where {
  field: string;
  path: readonly (string | number)[];
}

function below(where: Where, segment: string | number): Where {
  return { field: where.field, path: [...where.path, segment] };
}

function coerceError(where: Where, bareMessage: string): CoerceError {
  return new CoerceError(where.field, bareMessage, where.path);
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
    current = unwrapped;
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

function arrayElement(array: ZodTypeAny): ZodTypeAny | undefined {
  const def = (array as unknown as { _def: { element?: ZodTypeAny; type?: ZodTypeAny } })._def;
  return def.element ?? def.type;
}

function tupleItems(tuple: ZodTypeAny): ZodTypeAny[] {
  const def = (tuple as unknown as { _def: { items?: ZodTypeAny[] } })._def;
  return def.items ?? [];
}

/**
 * Whether `value`'s JSON kind is one `schema` can hold — a string for a string-like
 * schema, an array for an array or tuple, a plain object for an object or record.
 * Only these three kinds steer coercion; any other value fits nothing.
 */
function fitsStructurally(schema: ZodTypeAny, value: unknown): boolean {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodUnion) {
    return getUnionOptions(inner as z.ZodUnion<z.ZodTypeAny[]>).some((o) =>
      fitsStructurally(o, value),
    );
  }
  if (typeof value === 'string') {
    return (
      inner instanceof z.ZodString || inner instanceof z.ZodEnum || inner instanceof z.ZodLiteral
    );
  }
  if (Array.isArray(value)) return inner instanceof z.ZodArray || inner instanceof z.ZodTuple;
  if (isPlainObject(value)) return inner instanceof z.ZodObject || inner instanceof z.ZodRecord;
  return false;
}

/** A numeric string as its number; `CoerceError` for any other non-blank string. */
function toNumber(value: unknown, where: Where): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  throw coerceError(where, `expected number or numeric string, got ${JSON.stringify(value)}`);
}

/** An array or tuple value's elements, each coerced by the beneath-an-array rules. */
function coerceElements(schema: ZodTypeAny, value: unknown[], where: Where): unknown[] {
  if (schema instanceof z.ZodTuple) {
    const items = tupleItems(schema);
    const rest = (schema as unknown as { _def: { rest?: ZodTypeAny | null } })._def.rest ?? null;
    return value.map((v, i) => {
      const item = i < items.length ? items[i] : rest;
      return item === null ? v : coerceBeneathArray(item, v, below(where, i));
    });
  }
  const element = arrayElement(schema);
  if (!element) return value;
  return value.map((v, i) => coerceBeneathArray(element, v, below(where, i)));
}

/**
 * A value beneath an array: an element, a declared key of an object element, or a tuple
 * item. The only conversion here is a numeric string to a number. A nested string is never
 * JSON-parsed, a nested boolean string stays a string, and a `z.record` is left alone.
 */
function coerceBeneathArray(schema: ZodTypeAny, value: unknown, where: Where): unknown {
  if (value === null || value === undefined) return value;
  const inner = unwrap(schema);

  if (inner instanceof z.ZodNumber) return toNumber(value, where);

  if (inner instanceof z.ZodObject && isPlainObject(value)) {
    const shape = inner.shape as Record<string, ZodTypeAny>;
    const out: Record<string, unknown> = { ...value };
    for (const key of Object.keys(shape)) {
      if (key in out) out[key] = coerceBeneathArray(shape[key], out[key], below(where, key));
    }
    return out;
  }

  if ((inner instanceof z.ZodArray || inner instanceof z.ZodTuple) && Array.isArray(value)) {
    return coerceElements(inner, value as unknown[], where);
  }

  if (inner instanceof z.ZodUnion && typeof value !== 'string') {
    // A value one branch already accepts is the caller's intent: never re-shape it.
    if (inner.safeParse(value).success) return value;
    const option = getUnionOptions(inner as z.ZodUnion<z.ZodTypeAny[]>).find((o) =>
      fitsStructurally(o, value),
    );
    return option === undefined ? value : coerceBeneathArray(option, value, where);
  }

  return value;
}

export function coerceFieldValue(schema: ZodTypeAny, value: unknown, fieldName = 'value'): unknown {
  return coerceAt(schema, value, { field: fieldName, path: [] });
}

/** A top-level field's value. Only an array (or a union's array branch) is descended into. */
function coerceAt(schema: ZodTypeAny, value: unknown, where: Where): unknown {
  if (value === null || value === undefined) return value;
  const inner = unwrap(schema);

  if (inner instanceof z.ZodNumber) return toNumber(value, where);

  if (inner instanceof z.ZodBoolean) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (typeof value === 'string') {
      throw coerceError(where, `expected boolean or "true"/"false", got ${JSON.stringify(value)}`);
    }
    return value;
  }

  // A top-level object's keys are never coerced: only a JSON-string is parsed.
  if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) {
    if (isPlainObject(value)) return value;
    if (typeof value === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        throw coerceError(
          where,
          `expected object or JSON-string of one, failed to parse: ${JSON.stringify(value)}`,
        );
      }
      if (isPlainObject(parsed)) return parsed;
      throw coerceError(
        where,
        `expected object, parsed JSON resolved to ${describeJsonShape(parsed)}`,
      );
    }
    return value;
  }

  if (inner instanceof z.ZodUnion) {
    const options = getUnionOptions(inner as z.ZodUnion<z.ZodTypeAny[]>);
    if (typeof value === 'string') return unionString(options, value, where);
    if (!Array.isArray(value)) return value;
    // A value one branch already accepts is the caller's intent: never re-shape it.
    if (inner.safeParse(value).success) return value;
    const option = options
      .map(unwrap)
      .find(
        (o) => (o instanceof z.ZodArray || o instanceof z.ZodTuple) && fitsStructurally(o, value),
      );
    return option === undefined ? value : coerceElements(option, value as unknown[], where);
  }

  if ((inner instanceof z.ZodArray || inner instanceof z.ZodTuple) && Array.isArray(value)) {
    return coerceElements(inner, value as unknown[], where);
  }

  if (inner instanceof z.ZodArray && typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw coerceError(
        where,
        `expected array or JSON-string of one, failed to parse: ${JSON.stringify(value)}`,
      );
    }
    if (Array.isArray(parsed)) return coerceElements(inner, parsed as unknown[], where);
    throw coerceError(
      where,
      `expected array, parsed JSON resolved to ${describeJsonShape(parsed)}`,
    );
  }

  return value;
}

/**
 * A string sent for a top-level union. It becomes an array only when it is a JSON array
 * whose every element is a string or a plain object, and some array branch's element
 * schema can hold every one of them: the first such branch wins, and the elements are
 * coerced by the beneath-an-array rules. A string that is not such a JSON array stays a
 * string, because the union's string branch may still accept it. Once parsed, though, an
 * element whose coercion fails (`lines: ["x", "2"]`) raises `CoerceError`.
 */
function unionString(options: ZodTypeAny[], value: string, where: Where): unknown {
  const arrays = options.map(unwrap).filter((o) => o instanceof z.ZodArray);
  if (arrays.length === 0) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return value;
  }
  if (!Array.isArray(parsed)) return value;
  const elements = parsed as unknown[];
  if (!elements.every((x) => typeof x === 'string' || isPlainObject(x))) return value;
  const array = arrays.find((a) => {
    const element = arrayElement(a);
    return element !== undefined && elements.every((x) => fitsStructurally(element, x));
  });
  return array === undefined ? value : coerceElements(array, elements, where);
}

export function coerceInput(schema: ZodTypeAny, value: unknown): unknown {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return value;
  if (!isPlainObject(value)) return value;

  const shape = inner.shape as Record<string, ZodTypeAny>;
  const out: Record<string, unknown> = { ...value };
  for (const key of Object.keys(shape)) {
    if (key in out) out[key] = coerceFieldValue(shape[key], out[key], key);
  }
  return out;
}

type WrapperLayer =
  | z.ZodOptional<ZodTypeAny>
  | z.ZodNullable<ZodTypeAny>
  | z.ZodDefault<ZodTypeAny>;

function isWrapperLayer(schema: ZodTypeAny): schema is WrapperLayer {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  );
}

/**
 * Re-applies one unwrapped layer around the rebuilt field, with the metadata
 * (`.describe()` / `.meta()`) zod keeps for that layer instance — `registerTool`
 * advertises the rebuilt schema, so a layer's description must not be lost.
 */
function rewrapLayer(layer: WrapperLayer, schema: ZodTypeAny): ZodTypeAny {
  let rebuilt: ZodTypeAny;
  if (layer instanceof z.ZodOptional) {
    rebuilt = schema.optional();
  } else if (layer instanceof z.ZodNullable) {
    rebuilt = schema.nullable();
  } else {
    // A thunk re-reads the original default on every parse, so a function
    // default stays fresh instead of being frozen into one value.
    const def = (layer as unknown as { _def: { defaultValue: unknown } })._def;
    rebuilt = schema.default(() => def.defaultValue);
  }
  const meta = z.globalRegistry.get(layer);
  return meta === undefined ? rebuilt : rebuilt.meta(meta);
}

function wrapField(field: ZodTypeAny, fieldName: string): ZodTypeAny {
  const layers: WrapperLayer[] = [];
  let inner: ZodTypeAny = field;
  while (isWrapperLayer(inner)) {
    const next = (inner as z.ZodOptional<ZodTypeAny>).unwrap();
    if (!next) break;
    layers.push(inner);
    inner = next;
  }
  const wrapped = z.preprocess((v, ctx) => {
    try {
      return coerceFieldValue(inner, v, fieldName);
    } catch (err) {
      if (err instanceof CoerceError) {
        // A nested value's issue sits at its own path below the field
        // (`paths.1.lines.0`), the way zod reports its own nested issues.
        ctx.addIssue({ code: 'custom', message: err.bareMessage, path: [...err.path] });
        return z.NEVER;
      }
      throw err;
    }
  }, inner);
  return layers.reduceRight<ZodTypeAny>((schema, layer) => rewrapLayer(layer, schema), wrapped);
}

export function wrapSchemaWithCoercion(schema: ZodTypeAny): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const newShape: Record<string, ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    newShape[key] = wrapField(field, key);
  }
  return z.object(newShape).strict();
}
