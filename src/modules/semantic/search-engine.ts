import type { BlockSearchResult, DuplicatePair, SearchResult, SmartSource } from '../../types.js';

function validateVector(vector: number[], label: string): void {
  if (vector.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function ensureSameDimensions(
  left: number[],
  right: number[],
  leftLabel: string,
  rightLabel: string,
): void {
  if (left.length !== right.length) {
    throw new Error(
      `Vector dimension mismatch: ${leftLabel} has ${left.length}, but ${rightLabel} has ${right.length}`,
    );
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  return right.similarity - left.similarity || compareStrings(left.path, right.path);
}

function compareDuplicatePairs(left: DuplicatePair, right: DuplicatePair): number {
  return (
    right.similarity - left.similarity ||
    compareStrings(left.note_a, right.note_a) ||
    compareStrings(left.note_b, right.note_b)
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  validateVector(a, 'Vector a');
  validateVector(b, 'Vector b');
  ensureSameDimensions(a, b, 'Vector a', 'Vector b');

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dotProduct += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function toSearchResults(
  queryVector: number[],
  sources: Iterable<SmartSource>,
  threshold: number,
  excludePath?: string,
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const source of sources) {
    if (excludePath !== undefined && source.path === excludePath) {
      continue;
    }

    ensureSameDimensions(
      queryVector,
      source.embedding,
      'Query vector',
      `Source vector for ${source.path}`,
    );

    const similarity = cosineSimilarity(queryVector, source.embedding);

    if (similarity >= threshold) {
      results.push({ path: source.path, similarity });
    }
  }

  results.sort(compareSearchResults);

  return results;
}

export function findNeighbors({
  queryVector,
  sources,
  threshold,
  limit,
  excludePath,
}: {
  queryVector: number[];
  sources: Iterable<SmartSource>;
  threshold: number;
  limit?: number;
  excludePath?: string;
}): SearchResult[] {
  const results = toSearchResults(queryVector, sources, threshold, excludePath);

  return typeof limit === 'number' ? results.slice(0, limit) : results;
}

function compareBlockSearchResults(left: BlockSearchResult, right: BlockSearchResult): number {
  return right.similarity - left.similarity || compareStrings(left.path, right.path);
}

export function findBlockNeighbors({
  queryVector,
  sources,
  threshold,
  limit,
}: {
  queryVector: number[];
  sources: Iterable<SmartSource>;
  threshold: number;
  limit?: number;
}): BlockSearchResult[] {
  const results: BlockSearchResult[] = [];

  for (const source of sources) {
    for (const block of source.blocks) {
      if (block.embedding.length === 0) {
        continue;
      }

      ensureSameDimensions(
        queryVector,
        block.embedding,
        'Query vector',
        `Block vector for ${block.key}`,
      );

      const similarity = cosineSimilarity(queryVector, block.embedding);

      if (similarity >= threshold) {
        results.push({
          path: source.path,
          heading: block.heading,
          lines: block.lines,
          similarity,
        });
      }
    }
  }

  results.sort(compareBlockSearchResults);

  return typeof limit === 'number' ? results.slice(0, limit) : results;
}

export function findDuplicates({
  sources,
  threshold,
}: {
  sources: Iterable<SmartSource>;
  threshold: number;
}): DuplicatePair[] {
  const sourceList = [...sources];

  for (let index = 0; index < sourceList.length; index += 1) {
    const source = sourceList[index]!;
    validateVector(source.embedding, `Source vector for ${source.path}`);
  }

  const duplicates: DuplicatePair[] = [];

  for (let leftIndex = 0; leftIndex < sourceList.length; leftIndex += 1) {
    const left = sourceList[leftIndex]!;

    for (let rightIndex = leftIndex + 1; rightIndex < sourceList.length; rightIndex += 1) {
      const right = sourceList[rightIndex]!;

      ensureSameDimensions(
        left.embedding,
        right.embedding,
        `Source vector for ${left.path}`,
        `Source vector for ${right.path}`,
      );

      const similarity = cosineSimilarity(left.embedding, right.embedding);

      if (similarity >= threshold) {
        duplicates.push({
          note_a: compareStrings(left.path, right.path) <= 0 ? left.path : right.path,
          note_b: compareStrings(left.path, right.path) <= 0 ? right.path : left.path,
          similarity,
        });
      }
    }
  }

  duplicates.sort(compareDuplicatePairs);

  return duplicates;
}
