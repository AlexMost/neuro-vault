import type { BlockHit, NoteHit } from './corpus.js';

export function validateVector(vector: ArrayLike<number>, label: string): void {
  if (vector.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

export function ensureSameDimensions(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  leftLabel: string,
  rightLabel: string,
): void {
  if (left.length !== right.length) {
    throw new Error(
      `Vector dimension mismatch: ${leftLabel} has ${left.length}, but ${rightLabel} has ${right.length}`,
    );
  }
}

export function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export function compareNoteHits(left: NoteHit, right: NoteHit): number {
  return right.similarity - left.similarity || compareStrings(left.path, right.path);
}

export function compareBlockHits(left: BlockHit, right: BlockHit): number {
  return right.similarity - left.similarity || compareStrings(left.path, right.path);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  validateVector(a, 'Vector a');
  validateVector(b, 'Vector b');
  ensureSameDimensions(a, b, 'Vector a', 'Vector b');

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    dotProduct += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}
