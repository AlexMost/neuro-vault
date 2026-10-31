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

function coerceElements(array: ZodTypeAny, value: unknown[], where: Where): unknown[] | undefined {
  const element = arrayElement(array);
  if (!element) return undefined;
  return value.map((v, i) => coerceAt(element, v, below(where, i)));
}

export function coerceFieldValue(schema: ZodTypeAny, value: unknown, fieldName = 'value'): unknown {
  return coerceAt(schema, value, { field: fieldName, path: [] });
}

function coerceAt(schema: ZodTypeAny, value: unknown, where: Where): unknown {
  if (value === null || value === undefined) return value;
  const inner = unwrap(schema);

  if (inner instanceof z.ZodNumber) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.trim() === '') return value;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      throw coerceError(where, `expected number or numeric string, got ${JSON.stringify(value)}`);
    }
    return value;
  }

  if (inner instanceof z.ZodBoolean) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (typeof value === 'string') {
      throw coerceError(where, `expected boolean or "true"/"false", got ${JSON.stringify(value)}`);
    }
    return value;
  }

  if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) {
    if (isPlainObject(value)) return objectFields(inner, value, where);
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
      if (isPlainObject(parsed)) return objectFields(inner, parsed, where);
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
    // A value one branch already accepts is the caller's intent: never re-shape it.
    if (inner.safeParse(value).success) return value;
    const option = options.find((o) => fitsStructurally(o, value));
    return option === undefined ? value : coerceAt(option, value, where);
  }

  if (inner instanceof z.ZodTuple && Array.isArray(value)) {
    const items = tupleItems(inner);
    const rest = (inner as unknown as { _def: { rest?: ZodTypeAny | null } })._def.rest ?? null;
    return (value as unknown[]).map((v, i) => {
      const item = i < items.length ? items[i] : rest;
      return item === null ? v : coerceAt(item, v, below(where, i));
    });
  }

  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return coerceElements(inner, value, where) ?? value;
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
    if (Array.isArray(parsed)) return coerceElements(inner, parsed, where) ?? parsed;
    throw coerceError(
      where,
      `expected array, parsed JSON resolved to ${describeJsonShape(parsed)}`,
    );
  }

  return value;
}

/**
 * A string sent for a union. When a branch is an array and the string is a JSON array
 * whose every element is a string or a plain object its element schema can hold, it is
 * that array, coerced element-wise. Otherwise it stays a string: JSON failure does not
 * throw here, because the union's string branch may still accept the raw value.
 */
function unionString(options: ZodTypeAny[], value: string, where: Where): unknown {
  const array = options.map(unwrap).find((o) => o instanceof z.ZodArray);
  const element = array === undefined ? undefined : arrayElement(array);
  if (array === undefined || element === undefined) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return value;
  }
  const fits =
    Array.isArray(parsed) &&
    parsed.every(
      (x) => (typeof x === 'string' || isPlainObject(x)) && fitsStructurally(element, x),
    );
  return fits ? (coerceElements(array, parsed as unknown[], where) ?? parsed) : value;
}

/**
 * Coerces each declared key of a `z.object` value against its own schema, keeping
 * undeclared keys as sent so the strict schema can still reject them. A `z.record`'s
 * values are left alone: their schema is open, so there is no target shape.
 */
function objectFields(
  schema: ZodTypeAny,
  value: Record<string, unknown>,
  where: Where | null,
): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return value;
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const out: Record<string, unknown> = { ...value };
  for (const key of Object.keys(shape)) {
    if (key in out) {
      const at = where === null ? { field: key, path: [] } : below(where, key);
      out[key] = coerceAt(shape[key], out[key], at);
    }
  }
  return out;
}

export function coerceInput(schema: ZodTypeAny, value: unknown): unknown {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return value;
  if (!isPlainObject(value)) return value;
  return objectFields(inner, value, null);
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
