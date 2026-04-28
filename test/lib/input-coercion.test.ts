import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { coerceInput } from '../../src/lib/input-coercion.js';

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

  it('leaves a non-numeric string alone (zod will reject)', () => {
    expect(coerceInput(schema, { limit: 'abc' })).toEqual({ limit: 'abc' });
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

  it('leaves other strings alone (zod will reject)', () => {
    expect(coerceInput(schema, { overwrite: 'yes' })).toEqual({ overwrite: 'yes' });
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

  it('leaves unparseable JSON alone', () => {
    expect(coerceInput(schema, { filter: 'not json' })).toEqual({ filter: 'not json' });
  });

  it('leaves a JSON-parseable array alone (object expected, not array)', () => {
    expect(coerceInput(schema, { filter: '["a","b"]' })).toEqual({ filter: '["a","b"]' });
  });

  it('leaves a JSON-parseable primitive alone', () => {
    expect(coerceInput(schema, { filter: '5' })).toEqual({ filter: '5' });
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
