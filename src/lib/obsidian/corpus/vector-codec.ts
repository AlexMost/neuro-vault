import os from 'node:os';

if (os.endianness() !== 'LE') {
  throw new Error('neuro-vault corpus: little-endian host required for the vector format');
}

export function encodeVector(values: number[]): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length % 4 !== 0) {
    throw new Error('neuro-vault corpus: vector payload is not a whole number of float32 values');
  }
  // byteOffset/length are mandatory — Buffer allocates small buffers from a pool.
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}
