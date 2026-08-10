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
    it('calls findNeighbors with threshold 0.5 and limit 4 (mode limit 3 + 1 truncation-detection overfetch)', async () => {
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
        expect.objectContaining({ threshold: 0.5, limit: 4 }),
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
    it('calls findNeighbors with threshold 0.35 and limit 9 (mode limit 8 + 1 truncation-detection overfetch)', async () => {
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
        expect.objectContaining({ threshold: 0.35, limit: 9 }),
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

  describe('leg-level pool truncation', () => {
    it('truncated is true when the engine yields more than the mode limit (quick: 4 hits, limit 3)', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValue([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.8),
            makeSearchResult('note-c.md', 0.7),
            makeSearchResult('note-d.md', 0.6),
          ]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(3);
      expect(output.truncated).toBe(true);
    });

    it('truncated is false when the engine yields at most the mode limit', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValue([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.8),
          ]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(2);
      expect(output.truncated).toBe(false);
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
      // requests limit + 1 (8) so an overflow beyond the user-supplied limit
      // is observable; `seeds`/`output.results` still bound to 7.
      expect(findNeighbors).toHaveBeenCalledWith(expect.objectContaining({ limit: 8 }));
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
      embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
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
    expect(byPath.get('note-b.md')!.similarity).toBe(0.7);
    expect(byPath.get('note-c.md')!.matched_queries).toEqual(['beta']);
    for (const r of output.results) {
      expect(r.blocks).toEqual([]);
      expect(r.related).toEqual([]);
    }
  });

  it('caps results at limit (final) regardless of N queries', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([1, 0]),
    };
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
      limit: 5,
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

  it("truncated is true when a single query's own pool overflows, even though the merged list fits under limit", async () => {
    // limit defaults to 3 (quick). Query 'a' yields 4 hits — more than its
    // own pool cap — so it overflows and is sliced to its top 3. Query 'b'
    // returns exactly those same 3 paths, contributing no new unique paths,
    // so the CROSS-QUERY merge cap never fires (merged.length === limit).
    // `truncated` must still be true, driven by query 'a's per-query overflow.
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([
          makeSearchResult('note-a.md', 0.95),
          makeSearchResult('note-b.md', 0.9),
          makeSearchResult('note-c.md', 0.85),
          makeSearchResult('note-d.md', 0.8),
        ])
        .mockReturnValueOnce([
          makeSearchResult('note-a.md', 0.5),
          makeSearchResult('note-b.md', 0.4),
          makeSearchResult('note-c.md', 0.3),
        ]),
    });

    const output = await executeMultiRetrieval({
      queries: ['a', 'b'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.results.map((r) => r.path).sort()).toEqual([
      'note-a.md',
      'note-b.md',
      'note-c.md',
    ]);
    expect(output.results.length).toBeLessThanOrEqual(3);
    expect(output.truncated).toBe(true);
  });

  describe('expansion (per-seed, deep mode)', () => {
    it('the same neighbour appears in related[] of multiple seeds (deduplication is per-seed only)', async () => {
      const extendedSources = makeSources([
        ['note-a.md', [1, 0]],
        ['note-b.md', [0.9, 0.1]],
        ['shared.md', [0.85, 0.15]],
      ]);

      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0.9, 0.1]),
      };

      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.95)]) // q1 seed
          .mockReturnValueOnce([makeSearchResult('note-b.md', 0.92)]) // q2 seed
          .mockReturnValueOnce([makeSearchResult('shared.md', 0.85)]) // related for note-a
          .mockReturnValueOnce([makeSearchResult('shared.md', 0.81)]), // related for note-b
      });

      const output = await executeMultiRetrieval({
        queries: ['q1', 'q2'],
        mode: 'deep',
        limit: 2,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      const noteB = output.results.find((r) => r.path === 'note-b.md')!;
      expect(noteA.related).toEqual([{ path: 'shared.md', expansion_similarity: 0.85 }]);
      expect(noteB.related).toEqual([{ path: 'shared.md', expansion_similarity: 0.81 }]);
    });

    it('expansionLimit caps related[] per seed (not globally)', async () => {
      const extendedSources = makeSources([
        ['seed-1.md', [1, 0]],
        ['seed-2.md', [0.9, 0.1]],
        ['n1.md', [0.8, 0.2]],
        ['n2.md', [0.7, 0.3]],
        ['n3.md', [0.6, 0.4]],
        ['n4.md', [0.5, 0.5]],
        ['n5.md', [0.4, 0.6]],
      ]);
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
      };
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
          .mockReturnValueOnce([makeSearchResult('seed-1.md', 0.95)])
          .mockReturnValueOnce([makeSearchResult('seed-2.md', 0.92)])
          .mockReturnValueOnce(fiveNeighbours)
          .mockReturnValueOnce(fiveNeighbours),
      });

      const output = await executeMultiRetrieval({
        queries: ['a', 'b'],
        mode: 'deep',
        limit: 2,
        expansionLimit: 2,
        sources: extendedSources,
        embeddingProvider,
        searchEngine,
      });

      for (const r of output.results) {
        expect(r.related.length).toBeLessThanOrEqual(2);
        expect(r.related.map((rel) => rel.path)).toEqual(['n1.md', 'n2.md']);
      }
    });

    it('quick mode never populates related (multi-query)', async () => {
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

      expect(output.results.every((r) => r.related.length === 0)).toBe(true);
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(2);
    });

    it("does not include seeds in any seed's related[]", async () => {
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
          .mockReturnValueOnce([
            makeSearchResult('seed.md', 0.9), // itself — must be filtered
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

      const seed = output.results.find((r) => r.path === 'seed.md')!;
      expect(seed.related.map((r) => r.path)).not.toContain('seed.md');
      expect(seed.related.map((r) => r.path)).toContain('exp.md');
    });
  });

  it('reports per-query hits before the cross-query cap', async () => {
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([
          makeSearchResult('note-a.md', 0.9),
          makeSearchResult('note-b.md', 0.7),
        ])
        .mockReturnValueOnce([]) // 'dead' initial threshold
        .mockReturnValueOnce([]), // 'dead' fallback threshold (still no hits)
    });

    const output = await executeMultiRetrieval({
      queries: ['a', 'dead'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.per_query_hits).toEqual({ a: 2, dead: 0 });
  });

  it('reports pre-cap hit counts for a query whose hits are all dropped by the cross-query cap', async () => {
    // limit=2. Query 'a' contributes 2 high-similarity notes that alone fill the cap.
    // Query 'b' contributes 1 lower-similarity note that survives the merge sort but
    // is sliced off by the Step-3 cap. per_query_hits must still report b's pre-cap
    // count (1), taken from perQueryOutputs, not from the post-cap seeds.
    const embeddingProvider: EmbeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
    };
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([
          makeSearchResult('note-a1.md', 0.9),
          makeSearchResult('note-a2.md', 0.85),
        ])
        .mockReturnValueOnce([makeSearchResult('note-b1.md', 0.5)]),
    });

    const output = await executeMultiRetrieval({
      queries: ['a', 'b'],
      mode: 'quick',
      limit: 2,
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.results.map((r) => r.path)).toEqual(['note-a1.md', 'note-a2.md']);
    expect(output.truncated).toBe(true);
    expect(output.per_query_hits).toEqual({ a: 2, b: 1 });
  });

  describe('blocks (multi-query)', () => {
    it('dedupes blocks across queries, keeping max similarity', async () => {
      // Two queries each surface the same block at different similarities.
      // The merged block must carry the higher similarity (0.8), not the lower (0.5).
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
      };
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.9)]) // q1 seed
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.85)]), // q2 seed (same note)
        findBlockNeighbors: vi
          .fn()
          .mockReturnValueOnce([
            {
              path: 'note-a.md',
              heading: '#h',
              lines: [1, 3] as [number, number],
              similarity: 0.5,
            },
          ])
          .mockReturnValueOnce([
            {
              path: 'note-a.md',
              heading: '#h',
              lines: [1, 3] as [number, number],
              similarity: 0.8,
            },
          ]),
      });

      const output = await executeMultiRetrieval({
        queries: ['q1', 'q2'],
        mode: 'deep',
        expansion: false,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.blocks).toEqual([{ heading: '#h', lines: [1, 3], similarity: 0.8 }]);
    });

    it('drops orphan blocks — only blocks belonging to result notes are attached', async () => {
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
        findBlockNeighbors: vi.fn().mockReturnValue([
          makeBlockResult('note-a.md', 0.7),
          makeBlockResult('note-c.md', 0.85), // orphan
        ]),
      });

      const output = await executeMultiRetrieval({
        queries: ['q'],
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      const allPaths = new Set(output.results.map((r) => r.path));
      expect(allPaths.has('note-c.md')).toBe(false);
      const noteA = output.results.find((r) => r.path === 'note-a.md')!;
      expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.7 }]);
    });
  });
});

describe('per-seed block backfill', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
  ]);

  it('backfills the best block for a seed starved by the shared pass (single query)', async () => {
    const findBlockNeighbors = vi
      .fn()
      // shared pass: everything goes to note-a
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.9)])
      // backfill lookup for note-b, scoped to its own source
      .mockReturnValueOnce([makeBlockResult('note-b.md', 0.42)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.42 }]);
    // backfill call is scoped to note-b's source alone, threshold 0, limit 1
    expect(findBlockNeighbors).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: [sources.get('note-b.md')], threshold: 0, limit: 1 }),
    );
  });

  it('leaves blocks empty when the note has no block embeddings', async () => {
    const blockless = new Map(sources);
    blockless.set('note-b.md', { path: 'note-b.md', embedding: [0.8, 0.2], blocks: [] });
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources: blockless,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
  });

  it('backfills across query vectors keeping the best block (multi query)', async () => {
    const findBlockNeighbors = vi.fn().mockImplementation(({ sources: scoped, limit }) => {
      // backfill calls are the single-source, limit-1 ones
      if (Array.isArray(scoped) && scoped.length === 1 && limit === 1) {
        return [makeBlockResult('note-b.md', 0.3)];
      }
      return [makeBlockResult('note-a.md', 0.9)];
    });
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.3 }]);
  });

  it('ignores foreign-path results from a backfill lookup', async () => {
    // Defensive: a (mis)behaving engine returning another note's block for a
    // scoped lookup must not attach evidence to the wrong seed.
    const findBlockNeighbors = vi
      .fn()
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.9)])
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.5)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
    expect(findBlockNeighbors).toHaveBeenCalledTimes(2);
  });
});

describe('explicit threshold is a hard filter', () => {
  const sources = makeSources([['note-a.md', [1, 0]]]);

  it('does not retry at 0.3 when an explicit threshold filters everything', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.99,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(output.results).toEqual([]);
    expect(findNeighbors).toHaveBeenCalledTimes(1);
    expect(findNeighbors).toHaveBeenCalledWith(expect.objectContaining({ threshold: 0.99 }));
    expect(output.fallback).toBe(false);
  });

  it('retries at 0.3 for the default threshold and reports fallback: true', async () => {
    const findNeighbors = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([makeSearchResult('note-a.md', 0.4)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findNeighbors).toHaveBeenNthCalledWith(2, expect.objectContaining({ threshold: 0.3 }));
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
    expect(output.fallback).toBe(true);
  });

  it('reports fallback: false when the first pass already had hits', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
    });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(output.fallback).toBe(false);
  });
});

describe('expansion floor and block decoupling', () => {
  const sources = makeSources([['note-a.md', [1, 0]]]);

  it('floors the per-seed neighbour lookup at expansionFloor, not threshold', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7, // explicit, must NOT reach expansion
      expansionFloor: 0.93,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    const expansionCalls = findNeighbors.mock.calls.slice(1); // call 0 = Step 1 seeds
    expect(expansionCalls.length).toBeGreaterThan(0);
    for (const [args] of expansionCalls) {
      expect(args.threshold).toBe(0.93);
    }
  });

  it('defaults the floor to 0.35 when expansionFloor is absent', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    const expansionCalls = findNeighbors.mock.calls.slice(1);
    for (const [args] of expansionCalls) {
      expect(args.threshold).toBe(0.35);
    }
  });

  it('filters deep blocks at the internal default, not the user threshold', async () => {
    const findBlockNeighbors = vi.fn().mockReturnValue([makeBlockResult('note-a.md', 0.75)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
      findBlockNeighbors,
    });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findBlockNeighbors).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threshold: 0.35 }),
    );
  });
});

describe('multi-query fallback tracking', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0, 1]],
  ]);

  it('tracks fallback per query', async () => {
    // Keyed by query vector, not call order — Promise.all interleaving must
    // not matter.
    const embeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockImplementation(async (q: string) => (q === 'q1' ? [1, 0] : [0, 1])),
    };
    const findNeighbors = vi.fn().mockImplementation(({ queryVector, threshold }) => {
      if (queryVector[0] === 1) return [makeSearchResult('note-a.md', 0.8)];
      return threshold <= 0.3 ? [makeSearchResult('note-b.md', 0.4)] : [];
    });
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.per_query_fallback).toEqual({ q1: false, q2: true });
  });

  it('never falls back for an explicit threshold in the multi path', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'deep',
      threshold: 0.99,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findNeighbors).toHaveBeenCalledTimes(2); // one pass per query, no retries
    expect(output.per_query_fallback).toEqual({ q1: false, q2: false });
  });
});
