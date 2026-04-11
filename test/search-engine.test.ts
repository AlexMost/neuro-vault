import { describe, expect, it } from 'vitest';

import type { SmartSource } from '../src/types.js';
import { cosineSimilarity, findDuplicates, findNeighbors } from '../src/search-engine.js';

function makeSource(
  path: string,
  embedding: number[],
  blocks: SmartSource['blocks'] = [
    { key: `${path}#block`, heading: '#block', lines: [1, 3] as [number, number], embedding: [] },
  ],
): SmartSource {
  return {
    path,
    embedding,
    blocks,
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});

describe('findNeighbors', () => {
  const sources = [
    makeSource('alpha.md', [1, 0]),
    makeSource('bravo.md', [0.8, 0.2]),
    makeSource('charlie.md', [0, 1]),
    makeSource('delta.md', [1, 0.1]),
  ];

  it('returns sorted results above threshold', () => {
    const results = findNeighbors({
      queryVector: [1, 0],
      sources,
      threshold: 0.5,
      limit: 10,
    });

    expect(results.map((result) => result.path)).toEqual(['alpha.md', 'delta.md', 'bravo.md']);
    expect(results.every((result) => result.similarity >= 0.5)).toBe(true);
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
    expect(results[1]!.similarity).toBeGreaterThan(results[2]!.similarity);
  });

  it('breaks ties deterministically and includes exact-threshold matches', () => {
    const results = findNeighbors({
      queryVector: [1, 0],
      sources: [
        makeSource('zeta.md', [1, 0]),
        makeSource('beta.md', [0.5, 0.5]),
        makeSource('alpha.md', [1, 0]),
      ],
      threshold: 1,
      limit: 10,
    });

    expect(results.map((result) => result.path)).toEqual(['alpha.md', 'zeta.md']);
    expect(results.every((result) => result.similarity >= 1)).toBe(true);
  });

  it('respects the limit after sorting', () => {
    const results = findNeighbors({
      queryVector: [1, 0],
      sources,
      threshold: 0.1,
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.path)).toEqual(['alpha.md', 'delta.md']);
  });

  it('excludes the source note path from the results', () => {
    const results = findNeighbors({
      queryVector: [1, 0],
      sources,
      threshold: 0.1,
      limit: 10,
      excludePath: 'alpha.md',
    });

    expect(results.map((result) => result.path)).not.toContain('alpha.md');
    expect(results.map((result) => result.path)).toEqual(['delta.md', 'bravo.md']);
  });
});

describe('findDuplicates', () => {
  it('returns only pairs above the threshold', () => {
    const sources = [
      makeSource('alpha.md', [1, 0]),
      makeSource('bravo.md', [0.99, 0.01]),
      makeSource('charlie.md', [0, 1]),
      makeSource('delta.md', [0.1, 0.9]),
    ];

    const results = findDuplicates({
      sources,
      threshold: 0.95,
    });

    expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
      ['alpha.md', 'bravo.md'],
      ['charlie.md', 'delta.md'],
    ]);
    expect(results.every((result) => result.similarity >= 0.95)).toBe(true);
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
    expect(results[0]).toMatchObject({
      note_a: 'alpha.md',
      note_b: 'bravo.md',
    });
    expect(results[0]!.similarity).toBeCloseTo(0.9999499987499375);
  });

  it('breaks ties deterministically and includes exact-threshold pairs', () => {
    const results = findDuplicates({
      sources: [
        makeSource('zeta.md', [1, 0]),
        makeSource('beta.md', [0, 1]),
        makeSource('alpha.md', [1, 0]),
        makeSource('gamma.md', [0, 1]),
      ],
      threshold: 1,
    });

    expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
      ['alpha.md', 'zeta.md'],
      ['beta.md', 'gamma.md'],
    ]);
    expect(results.every((result) => result.similarity >= 1)).toBe(true);
  });
});
