import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CoerceError, coerceInput, wrapSchemaWithCoercion } from '../../src/lib/input-coercion.js';

describe('coerceInput — number fields', () => {
  const schema = z.object({
    limit: z.number().int().positive().optional(),
    threshold: z.number().min(0).max(1).optional(),
  });

  it('coerces a numeric string to a number', () => {
    expect(coerceInput(schema, { limit: '5' })).toEqual({ limit: 5 });
  });

  it('coerces a fractional numeric string', () => {
    expect(coerceInput(schema, { threshold: '0.35' })).toEqual({ threshold: 0.35 });
  });

  it('throws CoerceError on a non-numeric string', () => {
    expect(() => coerceInput(schema, { limit: 'abc' })).toThrow(CoerceError);
  });

  it('leaves an empty string alone', () => {
    expect(coerceInput(schema, { limit: '' })).toEqual({ limit: '' });
  });

  it('leaves a whitespace-only string alone', () => {
    expect(coerceInput(schema, { limit: '   ' })).toEqual({ limit: '   ' });
  });

  it('leaves a number alone', () => {
    expect(coerceInput(schema, { limit: 5 })).toEqual({ limit: 5 });
  });

  it('does not introduce keys absent from the input', () => {
    expect(coerceInput(schema, {})).toEqual({});
  });
});

describe('coerceInput — boolean fields', () => {
  const schema = z.object({
    overwrite: z.boolean().optional(),
    include_content: z.boolean().optional(),
  });

  it('coerces "true"/"false" to booleans', () => {
    expect(coerceInput(schema, { overwrite: 'true', include_content: 'false' })).toEqual({
      overwrite: true,
      include_content: false,
    });
  });

  it('throws CoerceError on a string that is not "true"/"false"', () => {
    expect(() => coerceInput(schema, { overwrite: 'yes' })).toThrow(CoerceError);
  });

  it('leaves a boolean alone', () => {
    expect(coerceInput(schema, { overwrite: true })).toEqual({ overwrite: true });
  });
});

describe('coerceInput — record/object fields', () => {
  const schema = z.object({
    filter: z.record(z.string(), z.unknown()),
    sort: z.object({ field: z.string(), order: z.enum(['asc', 'desc']) }).optional(),
  });

  it('parses a stringified JSON object into the record', () => {
    expect(coerceInput(schema, { filter: '{"tags":"x"}' })).toEqual({ filter: { tags: 'x' } });
  });

  it('parses a stringified JSON object into a nested z.object', () => {
    expect(coerceInput(schema, { filter: {}, sort: '{"field":"path","order":"asc"}' })).toEqual({
      filter: {},
      sort: { field: 'path', order: 'asc' },
    });
  });

  it('throws CoerceError on unparseable JSON', () => {
    expect(() => coerceInput(schema, { filter: 'not json' })).toThrow(CoerceError);
  });

  it('throws CoerceError when JSON parses to an array (object expected)', () => {
    expect(() => coerceInput(schema, { filter: '["a","b"]' })).toThrow(CoerceError);
  });

  it('throws CoerceError when JSON parses to a primitive (object expected)', () => {
    expect(() => coerceInput(schema, { filter: '5' })).toThrow(CoerceError);
  });

  it('does not recurse into the parsed object (filter values stay as-is)', () => {
    expect(coerceInput(schema, { filter: '{"limit":"5"}' })).toEqual({ filter: { limit: '5' } });
  });
});

describe('coerceInput — unions and arrays (no coercion)', () => {
  const schema = z.object({
    query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
    value: z.union([z.string(), z.number(), z.boolean()]),
  });

  it('passes string queries through', () => {
    expect(coerceInput(schema, { query: 'hello', value: 'world' })).toEqual({
      query: 'hello',
      value: 'world',
    });
  });

  it('passes array queries through', () => {
    expect(coerceInput(schema, { query: ['a', 'b'], value: 'x' })).toEqual({
      query: ['a', 'b'],
      value: 'x',
    });
  });

  it('does NOT coerce "5" → 5 when the schema accepts strings (set_property.value case)', () => {
    expect(coerceInput(schema, { query: 'q', value: '5' })).toEqual({
      query: 'q',
      value: '5',
    });
  });
});

describe('coerceInput — top-level oddities', () => {
  it('returns non-object input unchanged when schema is z.object', () => {
    const schema = z.object({ x: z.number() });
    expect(coerceInput(schema, '{"x":5}')).toBe('{"x":5}');
  });

  it('handles unknown extra keys without dropping them', () => {
    const schema = z.object({ a: z.number().optional() });
    expect(coerceInput(schema, { a: '1', extra: 'keep' })).toEqual({ a: 1, extra: 'keep' });
  });
});

describe('wrapSchemaWithCoercion', () => {
  it('produces a schema whose safeParse coerces stringified primitives end-to-end', () => {
    const schema = z.object({
      filter: z.record(z.string(), z.unknown()),
      limit: z.number().int().min(1).max(1000).optional(),
      include_content: z.boolean().optional(),
    });
    const wrapped = wrapSchemaWithCoercion(schema);

    const result = wrapped.safeParse({
      filter: '{"frontmatter.status":"evergreen","frontmatter.type":"note"}',
      limit: '5',
      include_content: 'false',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        filter: { 'frontmatter.status': 'evergreen', 'frontmatter.type': 'note' },
        limit: 5,
        include_content: false,
      });
    }
  });

  it('preserves optional fields (omitted fields stay valid, not in required-list)', () => {
    const schema = z.object({
      filter: z.record(z.string(), z.unknown()),
      limit: z.number().int().optional(),
      flag: z.boolean().optional(),
    });
    const wrapped = wrapSchemaWithCoercion(schema);

    const result = wrapped.safeParse({ filter: { a: 1 } });
    expect(result.success).toBe(true);
  });

  it('still rejects values that cannot be coerced (e.g. limit: "abc")', () => {
    const schema = z.object({ limit: z.number().int() });
    const wrapped = wrapSchemaWithCoercion(schema);

    const result = wrapped.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('does not touch union-typed fields (paths: string | string[])', () => {
    const schema = z.object({
      paths: z.union([z.string().min(1), z.array(z.string()).min(1).max(50)]),
    });
    const wrapped = wrapSchemaWithCoercion(schema);

    expect(wrapped.safeParse({ paths: 'x.md' }).success).toBe(true);
    expect(wrapped.safeParse({ paths: ['a.md', 'b.md'] }).success).toBe(true);
    expect(wrapped.safeParse({ paths: '' }).success).toBe(false);
  });

  it('returns the schema unchanged when it is not a ZodObject', () => {
    const schema = z.string();
    expect(wrapSchemaWithCoercion(schema)).toBe(schema);
  });
});

describe('wrapSchemaWithCoercion — meaningful coerce errors', () => {
  function firstIssueMessage(
    schema: ReturnType<typeof wrapSchemaWithCoercion>,
    input: unknown,
  ): string {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    return result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join(' | ');
  }

  it('limit: "abc" → message names the field, mentions the bad value, and the expected shape', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ limit: z.number().int() }));
    const msg = firstIssueMessage(wrapped, { limit: 'abc' });
    expect(msg).toMatch(/limit/);
    expect(msg).toMatch(/abc/);
    expect(msg).toMatch(/numeric|number/i);
  });

  it('filter: "not json" → message says parse failed and includes the raw input', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ filter: z.record(z.string(), z.unknown()) }));
    const msg = firstIssueMessage(wrapped, { filter: 'not json' });
    expect(msg).toMatch(/filter/);
    expect(msg).toMatch(/parse/i);
    expect(msg).toMatch(/not json/);
  });

  it('filter: "[1,2,3]" → message reports parsed JSON resolved to array', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ filter: z.record(z.string(), z.unknown()) }));
    const msg = firstIssueMessage(wrapped, { filter: '[1,2,3]' });
    expect(msg).toMatch(/filter/);
    expect(msg).toMatch(/array/i);
  });

  it('filter: \'"hello"\' (valid JSON, primitive) → message reports primitive shape', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ filter: z.record(z.string(), z.unknown()) }));
    const msg = firstIssueMessage(wrapped, { filter: '"hello"' });
    expect(msg).toMatch(/filter/);
    expect(msg).toMatch(/string|primitive/i);
  });

  it('include_content: "maybe" → message names the field, mentions "true"/"false" and the bad value', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ include_content: z.boolean().optional() }));
    const msg = firstIssueMessage(wrapped, { include_content: 'maybe' });
    expect(msg).toMatch(/include_content/);
    expect(msg).toMatch(/true.*false|"true".*"false"/);
    expect(msg).toMatch(/maybe/);
  });

  it('issue path points at the offending field, not <root>', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ limit: z.number().int() }));
    const result = wrapped.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues[0]?.path).toEqual(['limit']);
  });

  it('happy-path coerce still works (no regression on "5" → 5)', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ limit: z.number().int() }));
    const result = wrapped.safeParse({ limit: '5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ limit: 5 });
  });

  it('happy-path strict-typed still works (no regression on { limit: 5 })', () => {
    const wrapped = wrapSchemaWithCoercion(z.object({ limit: z.number().int() }));
    const result = wrapped.safeParse({ limit: 5 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ limit: 5 });
  });
});
