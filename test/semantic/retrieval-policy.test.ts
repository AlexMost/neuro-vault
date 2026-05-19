import { describe, expect, it, vi } from 'vitest';

import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchResult,
  SmartSource,
} from '../../src/types.js';
import {
  executeMultiRetrieval,
  executeRetrieval,
} from '../../src/modules/semantic/retrieval-policy.js';

function makeSource(path: string, embedding: number[] = [1, 0]): SmartSource {
  return {
    path,
    embedding,
    blocks: [{ key: `${path}#block`, heading: '#block', lines: [1, 3], embedding }],
  };
}

function makeSearchResult(path: string, similarity: number): SearchResult {
  return { path, similarity };
}

function makeBlockResult(path: string, similarity: number): BlockSearchResult {
  return { path, heading: '#block', lines: [1, 3], similarity };
}

function makeSources(entries: Array<[string, number[]]>): Map<string, SmartSource> {
  return new Map(entries.map(([path, emb]) => [path, makeSource(path, emb)]));
}

function makeEmbeddingProvider(vector: number[] = [1, 0]): EmbeddingProvider {
  return {
    initialize: vi.fn(),
    embed: vi.fn().mockResolvedValue(vector),
  };
}

function makeSearchEngine(
  overrides: Partial<{
    findNeighbors: SearchEngine['findNeighbors'];
    findBlockNeighbors: SearchEngine['findBlockNeighbors'];
    findDuplicates: SearchEngine['findDuplicates'];
  }> = {},
): SearchEngine {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('executeRetrieval', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
    ['note-c.md', [0, 1]],
  ]);

  describe('quick mode defaults', () => {
    it('calls findNeighbors with threshold 0.5 and limit 3', async () => {
      const searchEngine = makeSearchEngine();
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.5, limit: 3 }),
      );
    });

    it('attaches blocks scoped to matched notes when there are vector results', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
        findBlockNeighbors: vi.fn().mockReturnValue([makeBlockResult('note-a.md', 0.75)]),
      });
      const embeddingProvider = makeEmbeddingProvider();

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.75 }]);
      expect(noteA.related).toEqual([]);
      const blockCall = (searchEngine.findBlockNeighbors as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(blockCall[0]).toMatchObject({ threshold: 0, limit: 5 });
    });

    it('emits blocks: [] and related: [] when there are no matches', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([]),
      });
      const embeddingProvider = makeEmbeddingProvider();

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toEqual([]);
      expect(searchEngine.findBlockNeighbors).not.toHaveBeenCalled();
    });
  });

  describe('deep mode defaults', () => {
    it('calls findNeighbors with threshold 0.35 and limit 8', async () => {
      const searchEngine = makeSearchEngine();
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.35, limit: 8 }),
      );
    });

    it('drops orphan blocks (blocks whose note is not in results)', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
        findBlockNeighbors: vi.fn().mockReturnValue([
          makeBlockResult('note-a.md', 0.7),
          makeBlockResult('note-c.md', 0.85), // orphan — note-c not in results
        ]),
      });
      const embeddingProvider = makeEmbeddingProvider();

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      const allBlockPaths = output.results.flatMap((r) => r.blocks.map(() => r.path));
      expect(allBlockPaths).not.toContain('note-c.md');
      expect(output.results.find((r) => r.path === 'note-a.md')!.blocks).toHaveLength(1);
    });
  });

  describe('fallback to lower threshold', () => {
    it('retries with threshold 0.3 when initial search returns empty', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.35)]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(2);
      const secondCall = (searchEngine.findNeighbors as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall[0]).toMatchObject({ threshold: 0.3 });
      expect(output.results).toHaveLength(1);
    });

    it('does not retry if initial threshold is already <= 0.3', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([]),
      });

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        threshold: 0.3,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(1);
    });
  });

  describe('expansion (per-seed, deep mode)', () => {
    it('attaches each seed its own related[] populated from its own neighbours', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.7),
          ])
          .mockReturnValueOnce([makeSearchResult('note-c.md', 0.65)]) // for seed note-a.md
          .mockReturnValueOnce([]), // for seed note-b.md
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 3,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      const noteB = output.results.find((r) => r.path === 'note-b.md')!;
      expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
      expect(noteB.related).toEqual([]);
    });

    it('the same neighbour appears in related[] of every seed it neighbours (no global dedup)', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.7),
          ])
          .mockReturnValueOnce([makeSearchResult('note-c.md', 0.65)]) // for seed a
          .mockReturnValueOnce([makeSearchResult('note-c.md', 0.55)]), // for seed b
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 3,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      const noteB = output.results.find((r) => r.path === 'note-b.md')!;
      expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
      expect(noteB.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.55 }]);
    });

    it('drops a neighbour from related[] if it is itself a seed', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.7),
          ])
          .mockReturnValueOnce([
            makeSearchResult('note-b.md', 0.6), // note-b is a seed → filtered
            makeSearchResult('note-c.md', 0.55),
          ])
          .mockReturnValueOnce([]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 3,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.related.map((r) => r.path)).not.toContain('note-b.md');
      expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.55 }]);
    });

    it('caps related[] per note at expansionLimit', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const fiveNeighbours = [
        makeSearchResult('n1.md', 0.9),
        makeSearchResult('n2.md', 0.8),
        makeSearchResult('n3.md', 0.7),
        makeSearchResult('n4.md', 0.6),
        makeSearchResult('n5.md', 0.5),
      ];
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)]) // seed
          .mockReturnValueOnce(fiveNeighbours), // expansion for the seed
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 2,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.related).toHaveLength(2);
      expect(noteA.related.map((r) => r.path)).toEqual(['n1.md', 'n2.md']);
    });

    it('honours per-note cap even when some top neighbours are filtered out as seeds', async () => {
      // 3 seeds, all densely connected. Engine returns 5 neighbours per seed,
      // of which the top 2 are themselves seeds. After filter, only 3 remain;
      // per-seed cap is 3, so all 3 survivors must appear.
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const seedSources = makeSources([
        ['seed-a.md', [1, 0]],
        ['seed-b.md', [0.9, 0.1]],
        ['seed-c.md', [0.8, 0.2]],
        ['n1.md', [0.7, 0.3]],
        ['n2.md', [0.6, 0.4]],
        ['n3.md', [0.5, 0.5]],
      ]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([
            makeSearchResult('seed-a.md', 0.95),
            makeSearchResult('seed-b.md', 0.93),
            makeSearchResult('seed-c.md', 0.91),
          ])
          .mockReturnValueOnce([
            // expansion for seed-a: top 2 are seeds → filtered out
            makeSearchResult('seed-b.md', 0.93),
            makeSearchResult('seed-c.md', 0.91),
            makeSearchResult('n1.md', 0.8),
            makeSearchResult('n2.md', 0.7),
            makeSearchResult('n3.md', 0.6),
          ])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([]),
      });

      const output = await executeRetrieval({
        query: 'q',
        mode: 'deep',
        expansion: true,
        expansionLimit: 3,
        sources: seedSources,
        embeddingProvider,
        searchEngine,
      });

      const seedA = output.results.find((r) => r.path === 'seed-a.md')!;
      expect(seedA.related.map((r) => r.path)).toEqual(['n1.md', 'n2.md', 'n3.md']);
    });

    it('does not run expansion when expansion is false (related is empty)', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        expansion: false,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(1);
      expect(output.results.every((r) => r.related.length === 0)).toBe(true);
    });

    it('deep single-query default has non-empty related on seeds when neighbours exist', async () => {
      const extendedSources = makeSources([
        ['note-a.md', [1, 0]],
        ['note-b.md', [0.8, 0.2]],
        ['note-c.md', [0, 1]],
      ]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)])
          .mockReturnValueOnce([makeSearchResult('note-b.md', 0.7)]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources: extendedSources,
        embeddingProvider: makeEmbeddingProvider([1, 0]),
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.related[0]).toEqual({
        path: 'note-b.md',
        expansion_similarity: 0.7,
      });
    });
  });

  describe('shape invariants', () => {
    it('every result has blocks: [] and related: [] when no leaves apply', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
        findBlockNeighbors: vi.fn().mockReturnValue([]),
      });
      const output = await executeRetrieval({
        query: 'q',
        mode: 'quick',
        expansion: false,
        sources,
        embeddingProvider: makeEmbeddingProvider(),
        searchEngine,
      });

      expect(output.results[0]).toMatchObject({
        path: 'note-a.md',
        similarity: 0.9,
        blocks: [],
        related: [],
      });
    });

    it('related items never carry a similarity field — only expansion_similarity', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)])
          .mockReturnValueOnce([makeSearchResult('note-b.md', 0.7)]),
      });
      const output = await executeRetrieval({
        query: 'q',
        mode: 'deep',
        sources,
        embeddingProvider: makeEmbeddingProvider(),
        searchEngine,
      });
      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      for (const rel of noteA.related) {
        expect(rel).not.toHaveProperty('similarity');
        expect(rel).not.toHaveProperty('via_expansion');
        expect(typeof rel.expansion_similarity).toBe('number');
      }
    });

    it('sorts blocks[] within a note by similarity desc', async () => {
      // Engine returns blocks in arbitrary order; the assembly must sort them.
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
        findBlockNeighbors: vi.fn().mockReturnValue([
          { path: 'note-a.md', heading: '#low', lines: [10, 12], similarity: 0.3 },
          { path: 'note-a.md', heading: '#high', lines: [1, 3], similarity: 0.9 },
          { path: 'note-a.md', heading: '#mid', lines: [5, 7], similarity: 0.6 },
        ]),
      });
      const output = await executeRetrieval({
        query: 'q',
        mode: 'deep',
        sources,
        embeddingProvider: makeEmbeddingProvider(),
        searchEngine,
      });
      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.blocks.map((b) => b.similarity)).toEqual([0.9, 0.6, 0.3]);
    });

    it('output never has a top-level blockResults field', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
        findBlockNeighbors: vi.fn().mockReturnValue([makeBlockResult('note-a.md', 0.8)]),
      });
      const output = await executeRetrieval({
        query: 'q',
        mode: 'deep',
        sources,
        embeddingProvider: makeEmbeddingProvider(),
        searchEngine,
      });
      expect(output).not.toHaveProperty('blockResults');
    });
  });

  describe('threshold override', () => {
    it('passes custom threshold to findNeighbors instead of mode default', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        threshold: 0.7,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.7 }),
      );
    });
  });

  describe('final limit', () => {
    it('slices results to mode limit', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const manyResults = Array.from({ length: 10 }, (_, i) =>
        makeSearchResult(`note-${i}.md`, 0.9 - i * 0.05),
      );
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue(manyResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(3);
    });
  });

  describe('user-supplied limit', () => {
    it('overrides the mode default', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const manyResults = Array.from({ length: 10 }, (_, i) =>
        makeSearchResult(`note-${i}.md`, 0.9 - i * 0.05),
      );
      const findNeighbors = vi.fn().mockReturnValue(manyResults);
      const searchEngine = makeSearchEngine({ findNeighbors });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        limit: 7,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(7);
      expect(findNeighbors).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
    });
  });
});

describe('executeMultiRetrieval', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
    ['note-c.md', [0, 1]],
  ]);

  it('merges results by path and aggregates matched_queries', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi
        .fn()
        .mockResolvedValueOnce([1, 0]) // for query "alpha"
        .mockResolvedValueOnce([0, 1]), // for query "beta"
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([
          makeSearchResult('note-a.md', 0.9),
          makeSearchResult('note-b.md', 0.7),
        ])
        .mockReturnValueOnce([
          makeSearchResult('note-b.md', 0.6),
          makeSearchResult('note-c.md', 0.5),
        ]),
    });

    const output = await executeMultiRetrieval({
      queries: ['alpha', 'beta'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    const byPath = new Map(output.results.map((r) => [r.path, r]));
    expect(byPath.get('note-a.md')!.matched_queries).toEqual(['alpha']);
    expect(byPath.get('note-b.md')!.matched_queries).toEqual(['alpha', 'beta']);
    expect(byPath.get('note-b.md')!.similarity).toBe(0.7); // max wins
    expect(byPath.get('note-c.md')!.matched_queries).toEqual(['beta']);
  });

  it('caps multi-query results at limit (final), not limit × N', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
    // 3 queries × 5 unique results each = 15 merged.
    // limit: 5 → cap = 5 (not 5*3=15). 15 > 5, so truncated=true, results=5.
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) => makeSearchResult(`a-${i}.md`, 0.9 - i * 0.01)),
        )
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) => makeSearchResult(`b-${i}.md`, 0.9 - i * 0.01)),
        )
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) => makeSearchResult(`c-${i}.md`, 0.9 - i * 0.01)),
        ),
    });

    const output = await executeMultiRetrieval({
      queries: ['a', 'b', 'c'],
      mode: 'quick',
      limit: 5, // final cap = 5 regardless of N
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.results).toHaveLength(5);
    expect(output.truncated).toBe(true);
  });

  it('sets truncated=false when merged count fits in cap', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
    });

    const output = await executeMultiRetrieval({
      queries: ['a', 'b'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.truncated).toBe(false);
  });

  it('limit=10 with 8 disjoint queries → final length ≤ 10', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
    // 8 queries × 5 unique results each = 40 merged → cap = limit=10. 40 > 10, truncated=true.
    const mockResults = (offset: number) =>
      Array.from({ length: 5 }, (_, i) => makeSearchResult(`q${offset}-${i}.md`, 0.9 - i * 0.01));
    const findNeighbors = vi.fn();
    for (let i = 0; i < 8; i++) findNeighbors.mockReturnValueOnce(mockResults(i));
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeMultiRetrieval({
      queries: ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
      mode: 'quick',
      limit: 10,
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.results.length).toBeLessThanOrEqual(10);
    expect(output.truncated).toBe(true);
  });

  it('caps to limit when N=1 (single-element array path)', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue(
          Array.from({ length: 12 }, (_, i) => makeSearchResult(`a-${i}.md`, 0.9 - i * 0.01)),
        ),
    });

    const output = await executeMultiRetrieval({
      queries: ['only'],
      mode: 'quick',
      limit: 10,
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.results.length).toBeLessThanOrEqual(10);
  });

  describe('executeMultiRetrieval cap (final limit)', () => {
    it('truncated is false when unique merged candidates ≤ limit', async () => {
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      // Both queries return the same single result → 1 unique path ≤ limit=5
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
      });

      const output = await executeMultiRetrieval({
        queries: ['x', 'y'],
        mode: 'quick',
        limit: 5,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.truncated).toBe(false);
      expect(output.results).toHaveLength(1);
    });
  });

  describe('executeMultiRetrieval expansion (post-merge, deep mode)', () => {
    it('expansion runs after merge+cap on the final top-limit (multi-query, deep)', async () => {
      // Sources: 8 notes. Seeds: note-a.md, note-b.md (limit=2). Expansion finds 5 new neighbors.
      // Expected: 2 seeds (with matched_queries) + min(5, expansionLimit=3) expansion results.
      const extendedSources = makeSources([
        ['note-a.md', [1, 0]],
        ['note-b.md', [0.9, 0.1]],
        ['exp-1.md', [0.8, 0.2]],
        ['exp-2.md', [0.7, 0.3]],
        ['exp-3.md', [0.6, 0.4]],
        ['exp-4.md', [0.5, 0.5]],
        ['exp-5.md', [0.4, 0.6]],
      ]);

      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi
          .fn()
          .mockResolvedValueOnce([1, 0]) // query 'alpha'
          .mockResolvedValueOnce([0, 1]), // query 'beta'
      };

      const expansionResults = [
        makeSearchResult('exp-1.md', 0.75),
        makeSearchResult('exp-2.md', 0.65),
        makeSearchResult('exp-3.md', 0.55),
        makeSearchResult('exp-4.md', 0.45),
        makeSearchResult('exp-5.md', 0.35),
      ];

      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)]) // query alpha
          .mockReturnValueOnce([makeSearchResult('note-b.md', 0.8)]) // query beta
          .mockReturnValueOnce(expansionResults) // expansion for note-a.md
          .mockReturnValueOnce(expansionResults), // expansion for note-b.md
      });

      const output = await executeMultiRetrieval({
        queries: ['alpha', 'beta'],
        mode: 'deep',
        limit: 2,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      const seeds = output.results.filter((r) => !r.via_expansion);
      const expanded = output.results.filter((r) => r.via_expansion);

      expect(seeds).toHaveLength(2);
      expect(expanded.length).toBeLessThanOrEqual(3); // expansionLimit=3
      expect(expanded.every((r) => r.via_expansion === true)).toBe(true);
      expect(expanded.every((r) => r.matched_queries === undefined)).toBe(true);
      expect(seeds.every((r) => Array.isArray(r.matched_queries))).toBe(true);
    });

    it('expansion respects expansion_limit as total cap, not per-seed (deep)', async () => {
      // 2 seeds, each finds 5 expansion neighbors. expansionLimit defaults to 3.
      // Total unique expansion candidates: up to 10. Should be capped at 3.
      const extendedSources = makeSources([
        ['seed-1.md', [1, 0]],
        ['seed-2.md', [0.9, 0.1]],
        ['exp-1.md', [0.8, 0.2]],
        ['exp-2.md', [0.7, 0.3]],
        ['exp-3.md', [0.6, 0.4]],
        ['exp-4.md', [0.5, 0.5]],
        ['exp-5.md', [0.4, 0.6]],
        ['exp-6.md', [0.3, 0.7]],
      ]);

      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi
          .fn()
          .mockResolvedValueOnce([1, 0]) // query 'a'
          .mockResolvedValueOnce([0, 1]), // query 'b'
      };

      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('seed-1.md', 0.9)]) // query a
          .mockReturnValueOnce([makeSearchResult('seed-2.md', 0.85)]) // query b
          .mockReturnValueOnce([
            // expansion for seed-1.md
            makeSearchResult('exp-1.md', 0.75),
            makeSearchResult('exp-2.md', 0.65),
            makeSearchResult('exp-3.md', 0.55),
            makeSearchResult('exp-4.md', 0.45),
            makeSearchResult('exp-5.md', 0.35),
          ])
          .mockReturnValueOnce([
            // expansion for seed-2.md
            makeSearchResult('exp-3.md', 0.58),
            makeSearchResult('exp-4.md', 0.48),
            makeSearchResult('exp-5.md', 0.38),
            makeSearchResult('exp-6.md', 0.28),
          ]),
      });

      const output = await executeMultiRetrieval({
        queries: ['a', 'b'],
        mode: 'deep',
        limit: 2,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      const expanded = output.results.filter((r) => r.via_expansion);
      expect(expanded.length).toBe(3); // expansionLimit default = 3
    });

    it('quick mode never runs expansion (multi-query)', async () => {
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)])
          .mockReturnValueOnce([makeSearchResult('note-b.md', 0.8)]),
      });

      const output = await executeMultiRetrieval({
        queries: ['x', 'y'],
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results.every((r) => !r.via_expansion)).toBe(true);
      // findNeighbors called exactly once per query (2 calls), no expansion calls
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(2);
    });

    it('expansion does not include seeds in expansion output', async () => {
      // If expansion's findNeighbors returns a seed path, it should be filtered out.
      const extendedSources = makeSources([
        ['seed.md', [1, 0]],
        ['exp.md', [0.8, 0.2]],
      ]);
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('seed.md', 0.9)]) // query
          .mockReturnValueOnce([
            // expansion — returns seed itself + a new note
            makeSearchResult('seed.md', 0.9),
            makeSearchResult('exp.md', 0.7),
          ]),
      });

      const output = await executeMultiRetrieval({
        queries: ['q'],
        mode: 'deep',
        limit: 1,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      const expanded = output.results.filter((r) => r.via_expansion);
      expect(expanded.map((r) => r.path)).not.toContain('seed.md');
    });

    it('expansion-derived results never carry matched_queries', async () => {
      const extendedSources = makeSources([
        ['seed.md', [1, 0]],
        ['exp.md', [0.8, 0.2]],
      ]);
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('seed.md', 0.9)])
          .mockReturnValueOnce([makeSearchResult('exp.md', 0.7)]),
      });

      const output = await executeMultiRetrieval({
        queries: ['q'],
        mode: 'deep',
        limit: 1,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      const expanded = output.results.filter((r) => r.via_expansion);
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.every((r) => r.matched_queries === undefined)).toBe(true);
    });
  });
});
