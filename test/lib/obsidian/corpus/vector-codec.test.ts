import { describe, expect, it } from 'vitest';

import { decodeVector, encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';

describe('vector codec', () => {
  it('round-trips a vector bit-exactly', () => {
    const values = Array.from({ length: 384 }, (_, i) => Math.fround(Math.sin(i) / 3));
    expect(decodeVector(encodeVector(values))).toEqual(values);
  });

  it('round-trips correctly when many vectors are encoded in sequence', () => {
    // Small Buffers come from a shared pool: decoding via a bare `.buffer`
    // would read a neighbouring vector's bytes.
    const vectors = Array.from({ length: 50 }, (_, n) =>
      Array.from({ length: 384 }, (_, i) => Math.fround((n + 1) * 0.001 * i)),
    );
    const encoded = vectors.map(encodeVector);
    encoded.forEach((e, n) => expect(decodeVector(e)).toEqual(vectors[n]));
  });

  it('rejects a payload that is not whole float32 values', () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/float32/);
  });
});
