import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODEL_DIMS } from '../../../../src/lib/obsidian/corpus/types.js';
import { decodeVector, encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';

afterEach(() => vi.restoreAllMocks());

describe('vector codec', () => {
  it('round-trips a vector bit-exactly', () => {
    const values = Array.from({ length: MODEL_DIMS }, (_, i) => Math.fround(Math.sin(i) / 3));
    expect(decodeVector(encodeVector(values))).toEqual(values);
  });

  it('round-trips correctly when many vectors are encoded in sequence', () => {
    // Small Buffers come from a shared pool: decoding via a bare `.buffer`
    // would read a neighbouring vector's bytes.
    const vectors = Array.from({ length: 50 }, (_, n) =>
      Array.from({ length: MODEL_DIMS }, (_, i) => Math.fround((n + 1) * 0.001 * i)),
    );
    const encoded = vectors.map(encodeVector);
    encoded.forEach((e, n) => expect(decodeVector(e)).toEqual(vectors[n]));
  });

  it('rejects a payload that is not whole float32 values', () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/float32/);
  });

  it('rejects a big-endian host from the functions, not from module import', () => {
    // Importing this module must never throw as a side effect: the guard has to
    // live inside the two functions.
    vi.spyOn(os, 'endianness').mockReturnValue('BE');
    expect(() => encodeVector([1, 2, 3])).toThrow(/little-endian/);
    expect(() => decodeVector(Buffer.alloc(4).toString('base64'))).toThrow(/little-endian/);
  });
});
