import { describe, expect, it } from 'vitest';

import type { SmartSource } from '../../src/types.js';
import {
  cosineSimilarity,
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../src/modules/semantic/search-engine.js';

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

describe('findBlockNeighbors', () => {
  const sources: SmartSource[] = [
    {
      path: 'note-a.md',
      embedding: [1, 0, 0],
      blocks: [
        {
          key: 'note-a.md#intro',
          heading: '#intro',
          lines: [1, 5] as [number, number],
          embedding: [0.9, 0.1, 0],
        },
        {
          key: 'note-a.md#details',
          heading: '#details',
          lines: [6, 10] as [number, number],
          embedding: [0.1, 0.9, 0],
        },
      ],
    },
    {
      path: 'note-b.md',
      embedding: [0, 1, 0],
      blocks: [
        {
          key: 'note-b.md#summary',
          heading: '#summary',
          lines: [1, 4] as [number, number],
          embedding: [0.8, 0.2, 0],
        },
      ],
    },
    {
      path: 'note-c.md',
      embedding: [0, 0, 1],
      blocks: [
        {
          key: 'note-c.md#empty',
          heading: '#empty',
          lines: [1, 3] as [number, number],
          embedding: [],
        },
      ],
    },
  ];

  it('returns blocks ranked by similarity, skipping empty embeddings', () => {
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0,
    });

    // note-c.md#empty has empty embedding and must be skipped
    expect(results.map((r) => r.heading)).not.toContain('#empty');

    // Results should be sorted by similarity descending
    expect(results[0]!.similarity).toBeGreaterThanOrEqual(results[1]!.similarity);
    expect(results[1]!.similarity).toBeGreaterThanOrEqual(results[2]!.similarity);

    // The most similar block to [1,0,0] is note-a.md#intro with embedding [0.9,0.1,0]
    expect(results[0]!.path).toBe('note-a.md');
    expect(results[0]!.heading).toBe('#intro');

    // Each result has path, heading, lines and similarity
    expect(results[0]).toMatchObject({
      path: 'note-a.md',
      heading: '#intro',
      lines: [1, 5],
    });
    expect(typeof results[0]!.similarity).toBe('number');
  });

  it('respects threshold', () => {
    // note-a.md#details has embedding [0.1, 0.9, 0] which is not very similar to [1,0,0]
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0.8,
    });

    expect(results.every((r) => r.similarity >= 0.8)).toBe(true);
    expect(results.map((r) => r.heading)).not.toContain('#details');
  });

  it('respects limit', () => {
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0,
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.heading).toBe('#intro');
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
