import os from 'node:os';

/**
 * The stored format is little-endian float32 and Float32Array uses host byte
 * order, so a big-endian host would silently read and write byte-swapped
 * vectors. Checked per call rather than at import time: a module in `src/lib`
 * must not throw as a side effect of being imported.
 */
function assertLittleEndian(): void {
  if (os.endianness() !== 'LE') {
    throw new Error('neuro-vault corpus: little-endian host required for the vector format');
  }
}

export function encodeVector(values: number[]): string {
  assertLittleEndian();
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

/**
 * Decodes to a Float32Array rather than a JS `number[]`: the snapshot holds every
 * vector of the corpus for the life of the session, and a number array costs 8+
 * bytes a dimension (plus the spare capacity `Array.from` grows) against 4.
 */
export function decodeVector(encoded: string): Float32Array {
  assertLittleEndian();
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length % 4 !== 0) {
    throw new Error('neuro-vault corpus: vector payload is not a whole number of float32 values');
  }
  // Copy out of the Buffer: small buffers are slices of a shared pool, and a view
  // would keep that whole slab alive (and need byteOffset/length to read it right).
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
