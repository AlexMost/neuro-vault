import { describe, expect, it, vi } from 'vitest';

import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchResult,
  SmartSource,
} from '../../src/types.js';
import { executeRetrieval } from '../../src/modules/semantic/retrieval-policy.js';

// The vector every fixture below embeds every query to. A single shared ARRAY
// INSTANCE on purpose: `embed` is mocked with `mockResolvedValue(QUERY_VECTOR)`,
// so a `findNeighbors` call whose `queryVector` is this exact instance is a
// seed-pass call, while any other instance is a seed's own `embedding` — i.e.
// the per-seed expansion leg. Routing on identity rather than call order is
// what lets one fixture serve both arities: N queries means N seed-pass calls
// before the first expansion call ever happens.
const QUERY_VECTOR = [1, 0];

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

function makeEmbeddingProvider(vector: number[] = QUERY_VECTOR): EmbeddingProvider {
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

// A `findNeighbors` fake that tells the seed pass apart from the per-seed
// expansion pass by which vector drove the call (see QUERY_VECTOR above),
// instead of by call order. `seeds` may be a function of `threshold` so a
// fixture can make the mode-default pass come back empty and let only the
// 0.3 retry find anything.
function routedNeighbors(args: {
  sources: Map<string, SmartSource>;
  seeds: SearchResult[] | ((threshold: number) => SearchResult[]);
  relatedBySeed?: Record<string, SearchResult[]>;
}): SearchEngine['findNeighbors'] {
  const { sources, seeds, relatedBySeed = {} } = args;
  return vi.fn(({ queryVector, threshold }: { queryVector: number[]; threshold: number }) => {
    if (queryVector === QUERY_VECTOR) {
      return typeof seeds === 'function' ? seeds(threshold) : seeds;
    }
    for (const [path, source] of sources) {
      if (source.embedding === queryVector) return relatedBySeed[path] ?? [];
    }
    return [];
  });
}

const sources = makeSources([
  ['note-a.md', [1, 0]],
  ['note-b.md', [0.8, 0.2]],
  ['note-c.md', [0, 1]],
]);

// One pipeline, two arities. Every invariant below that has meaning at both
// is asserted once, over this table — a single query is the degenerate case
// of the query array, not a separate code path.
const arities: Array<[label: string, queries: string[]]> = [
  ['single query', ['test query']],
  ['query array', ['test query', 'друга']],
];

const allTrue = (queries: string[]): Record<string, boolean> =>
  Object.fromEntries(queries.map((q) => [q, true]));
const allFalse = (queries: string[]): Record<string, boolean> =>
  Object.fromEntries(queries.map((q) => [q, false]));

describe.each(arities)('mode defaults (%s)', (_label, queries) => {
  // A hit on the first pass in both tests below, so neither the 0.3 retry nor
  // (deep) the expansion leg adds calls — every recorded call is a seed pass.
  const oneHit = () => vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]);

  it('quick mode calls findNeighbors with threshold 0.5 and limit 4 (mode limit 3 + 1 truncation-detection overfetch)', async () => {
    const searchEngine = makeSearchEngine({ findNeighbors: oneHit() });
    const embeddingProvider = makeEmbeddingProvider();

    await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    // Called once per query — assert every call's shape, not just the first.
    expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const call of vi.mocked(searchEngine.findNeighbors).mock.calls) {
      expect(call[0]).toMatchObject({ threshold: 0.5, limit: 4 });
    }
  });

  it('deep mode calls findNeighbors with threshold 0.35 and limit 9 (mode limit 8 + 1 truncation-detection overfetch)', async () => {
    const searchEngine = makeSearchEngine({ findNeighbors: oneHit() });
    const embeddingProvider = makeEmbeddingProvider();

    await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: false,
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const call of vi.mocked(searchEngine.findNeighbors).mock.calls) {
      expect(call[0]).toMatchObject({ threshold: 0.35, limit: 9 });
    }
  });

  it('quick mode attaches blocks scoped to matched notes when there are vector results', async () => {
    const findBlockNeighbors = vi.fn().mockReturnValue([makeBlockResult('note-a.md', 0.75)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.75 }]);
    expect(noteA.related).toEqual([]);
    // One shared-pass block call per query, all with the quick-mode shape; no
    // backfill call, since note-a already has evidence.
    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [args] of findBlockNeighbors.mock.calls) {
      expect(args).toMatchObject({ threshold: 0, limit: 5 });
    }
  });

  it('emits no results and never runs block search when there are no matches', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toEqual([]);
    expect(searchEngine.findBlockNeighbors).not.toHaveBeenCalled();
  });

  it('deep mode drops orphan blocks — only blocks belonging to result notes are attached', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
      findBlockNeighbors: vi.fn().mockReturnValue([
        makeBlockResult('note-a.md', 0.7),
        makeBlockResult('note-c.md', 0.85), // orphan — note-c is not a seed
      ]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.map((r) => r.path)).not.toContain('note-c.md');
    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.7 }]);
  });
});

describe.each(arities)('fallback to lower threshold (%s)', (_label, queries) => {
  it('retries with threshold 0.3 when the initial search returns empty', async () => {
    const findNeighbors = vi.fn(({ threshold }: { threshold: number }) =>
      threshold <= 0.3 ? [makeSearchResult('note-a.md', 0.35)] : [],
    );
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    // Two passes per query: the mode default, then the 0.3 retry.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length * 2);
    const retries = findNeighbors.mock.calls.filter(([args]) => args.threshold === 0.3);
    expect(retries).toHaveLength(queries.length);
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
  });

  it('does not retry when the initial threshold is already <= 0.3', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });

    await executeRetrieval({
      queries,
      mode: 'quick',
      threshold: 0.3,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
  });
});

describe.each(arities)('explicit threshold is a hard filter (%s)', (_label, queries) => {
  const oneNote = makeSources([['note-a.md', [1, 0]]]);

  it('does not retry at 0.3 when an explicit threshold filters everything', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      threshold: 0.99,
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toEqual([]);
    // One pass per query, no retries.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [args] of findNeighbors.mock.calls) expect(args.threshold).toBe(0.99);
    expect(output.per_query_fallback).toEqual(allFalse(queries));
  });

  it('retries at 0.3 for the default threshold and reports per-query fallback true', async () => {
    const findNeighbors = vi.fn(({ threshold }: { threshold: number }) =>
      threshold <= 0.3 ? [makeSearchResult('note-a.md', 0.4)] : [],
    );
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    // Each query retries independently; the retries interleave with the
    // mode-default passes, so count them rather than pinning call positions.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length * 2);
    expect(findNeighbors.mock.calls.filter(([args]) => args.threshold === 0.3)).toHaveLength(
      queries.length,
    );
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
    expect(output.per_query_fallback).toEqual(allTrue(queries));
  });

  it('reports per-query fallback false when the first pass already had hits', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.per_query_fallback).toEqual(allFalse(queries));
  });

  it('passes a custom threshold to findNeighbors instead of the mode default', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });

    await executeRetrieval({
      queries,
      mode: 'quick',
      threshold: 0.7,
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [args] of findNeighbors.mock.calls) expect(args.threshold).toBe(0.7);
  });
});

describe.each(arities)('per-seed expansion, deep mode (%s)', (_label, queries) => {
  it('attaches each seed its own related[] populated from its own neighbours', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)],
        relatedBySeed: {
          'note-a.md': [makeSearchResult('note-c.md', 0.65)],
          'note-b.md': [],
        },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
    expect(noteB.related).toEqual([]);
  });

  it('the same neighbour appears in related[] of every seed it neighbours (no global dedup)', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)],
        relatedBySeed: {
          'note-a.md': [makeSearchResult('note-c.md', 0.65)],
          'note-b.md': [makeSearchResult('note-c.md', 0.55)],
        },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
    expect(noteB.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.55 }]);
  });

  it("does not include a seed in any seed's related[]", async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)],
        relatedBySeed: {
          'note-a.md': [
            makeSearchResult('note-b.md', 0.6), // note-b is a seed → filtered
            makeSearchResult('note-c.md', 0.55),
          ],
          'note-b.md': [],
        },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.related.map((r) => r.path)).not.toContain('note-b.md');
    expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.55 }]);
  });

  it('caps related[] per note at expansionLimit', async () => {
    const fiveNeighbours = [
      makeSearchResult('n1.md', 0.9),
      makeSearchResult('n2.md', 0.8),
      makeSearchResult('n3.md', 0.7),
      makeSearchResult('n4.md', 0.6),
      makeSearchResult('n5.md', 0.5),
    ];
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': fiveNeighbours },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 2,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.related).toHaveLength(2);
    expect(noteA.related.map((r) => r.path)).toEqual(['n1.md', 'n2.md']);
  });

  it('honours the per-note cap even when some top neighbours are filtered out as seeds', async () => {
    // 3 seeds, all densely connected. The engine returns 5 neighbours for
    // seed-a, of which the top 2 are themselves seeds. After the filter only
    // 3 remain; the per-seed cap is 3, so all 3 survivors must appear.
    const seedSources = makeSources([
      ['seed-a.md', [1, 0]],
      ['seed-b.md', [0.9, 0.1]],
      ['seed-c.md', [0.8, 0.2]],
      ['n1.md', [0.7, 0.3]],
      ['n2.md', [0.6, 0.4]],
      ['n3.md', [0.5, 0.5]],
    ]);
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources: seedSources,
        seeds: [
          makeSearchResult('seed-a.md', 0.95),
          makeSearchResult('seed-b.md', 0.93),
          makeSearchResult('seed-c.md', 0.91),
        ],
        relatedBySeed: {
          'seed-a.md': [
            makeSearchResult('seed-b.md', 0.93),
            makeSearchResult('seed-c.md', 0.91),
            makeSearchResult('n1.md', 0.8),
            makeSearchResult('n2.md', 0.7),
            makeSearchResult('n3.md', 0.6),
          ],
        },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      sources: seedSources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const seedA = output.results.find((r) => r.path === 'seed-a.md')!;
    expect(seedA.related.map((r) => r.path)).toEqual(['n1.md', 'n2.md', 'n3.md']);
  });

  it('does not run expansion when expansion is false (related stays empty)', async () => {
    const findNeighbors = routedNeighbors({
      sources,
      seeds: [makeSearchResult('note-a.md', 0.9)],
      relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
    });
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      expansion: false,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    // Seed pass only — no per-seed expansion call.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('quick mode never populates related[]', async () => {
    const findNeighbors = routedNeighbors({
      sources,
      seeds: [makeSearchResult('note-a.md', 0.9)],
      relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
    });
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('deep defaults give seeds a non-empty related[] when neighbours exist', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.related[0]).toEqual({ path: 'note-b.md', expansion_similarity: 0.7 });
  });
});

describe.each(arities)('expansion floor and block decoupling (%s)', (_label, queries) => {
  const oneNote = makeSources([['note-a.md', [1, 0]]]);

  it('floors the per-seed neighbour lookup at expansionFloor, not threshold', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });

    await executeRetrieval({
      queries,
      mode: 'deep',
      threshold: 0.7, // explicit, must NOT reach expansion
      expansionFloor: 0.93,
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    // The seed pass runs once per query and completes (Promise.all) before
    // any expansion call, so everything past it is the expansion leg.
    const expansionCalls = findNeighbors.mock.calls.slice(queries.length);
    expect(expansionCalls.length).toBeGreaterThan(0);
    for (const [args] of expansionCalls) {
      expect(args.threshold).toBe(0.93);
    }
  });

  it('defaults the floor to 0.35 when expansionFloor is absent', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });

    await executeRetrieval({
      queries,
      mode: 'deep',
      threshold: 0.7,
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const expansionCalls = findNeighbors.mock.calls.slice(queries.length);
    expect(expansionCalls.length).toBeGreaterThan(0);
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
      queries,
      mode: 'deep',
      threshold: 0.7,
      sources: oneNote,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [args] of findBlockNeighbors.mock.calls) {
      expect(args.threshold).toBe(0.35);
    }
  });
});

describe.each(arities)('per-seed block backfill (%s)', (_label, queries) => {
  const twoNotes = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
  ]);
  // The backfill lookup is the only one scoped to a single source with
  // limit 1 — that shape, not call order, identifies it at either arity.
  const isBackfill = (scoped: unknown, limit: number | undefined): boolean =>
    Array.isArray(scoped) && scoped.length === 1 && limit === 1;

  it('backfills the best block for a seed starved by the shared pass', async () => {
    const findBlockNeighbors = vi.fn(
      ({ sources: scoped, limit }: { sources: Iterable<SmartSource>; limit?: number }) =>
        isBackfill(scoped, limit)
          ? [makeBlockResult('note-b.md', 0.42)]
          : [makeBlockResult('note-a.md', 0.9)], // shared pass: all to note-a
    );
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources: twoNotes,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.42 }]);
    // The backfill call is scoped to note-b's source alone, threshold 0, limit 1.
    expect(findBlockNeighbors).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: [twoNotes.get('note-b.md')], threshold: 0, limit: 1 }),
    );
  });

  it('leaves blocks empty when the note has no block embeddings', async () => {
    const blockless = new Map(twoNotes);
    blockless.set('note-b.md', { path: 'note-b.md', embedding: [0.8, 0.2], blocks: [] });
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources: blockless,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
  });

  it('ignores foreign-path results from a backfill lookup', async () => {
    // Defensive: a (mis)behaving engine returning another note's block for a
    // scoped lookup must not attach evidence to the wrong seed.
    const findBlockNeighbors = vi.fn(
      ({ sources: scoped, limit }: { sources: Iterable<SmartSource>; limit?: number }) =>
        isBackfill(scoped, limit)
          ? [makeBlockResult('note-a.md', 0.5)] // wrong note for a note-b lookup
          : [makeBlockResult('note-a.md', 0.9)],
    );
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources: twoNotes,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
    // One shared pass per query, plus one backfill lookup per query vector.
    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length * 2);
  });
});

describe.each(arities)('shape invariants (%s)', (_label, queries) => {
  it('every result has blocks: [] and related: [] when no leaves apply', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
    });

    const output = await executeRetrieval({
      queries,
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

  it('every result carries matched_queries naming the queries that reached it', async () => {
    // Post-fold, retrieval populates matched_queries at BOTH arities — for a
    // single query it is simply `[query]`. Whether the field reaches the MCP
    // response is decided in the tool layer, not here.
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results[0].matched_queries).toEqual(queries);
  });

  it('related items never carry a similarity field — only expansion_similarity', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: routedNeighbors({
        sources,
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'deep',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.related.length).toBeGreaterThan(0);
    for (const rel of noteA.related) {
      expect(rel).not.toHaveProperty('similarity');
      expect(rel).not.toHaveProperty('via_expansion');
      expect(typeof rel.expansion_similarity).toBe('number');
    }
  });

  it('sorts blocks[] within a note by similarity desc', async () => {
    // The engine returns blocks in arbitrary order; assembly must sort them.
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
      findBlockNeighbors: vi.fn().mockReturnValue([
        { path: 'note-a.md', heading: '#low', lines: [10, 12], similarity: 0.3 },
        { path: 'note-a.md', heading: '#high', lines: [1, 3], similarity: 0.9 },
        { path: 'note-a.md', heading: '#mid', lines: [5, 7], similarity: 0.6 },
      ]),
    });

    const output = await executeRetrieval({
      queries,
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
      queries,
      mode: 'deep',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output).not.toHaveProperty('blockResults');
  });
});

describe.each(arities)('result cap and leg-level pool truncation (%s)', (_label, queries) => {
  const manyResults = Array.from({ length: 10 }, (_, i) =>
    makeSearchResult(`note-${i}.md`, 0.9 - i * 0.05),
  );

  it('slices results to the mode limit', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue(manyResults),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toHaveLength(3);
  });

  it('a user-supplied limit overrides the mode default', async () => {
    const findNeighbors = vi.fn().mockReturnValue(manyResults);
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      limit: 7,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toHaveLength(7);
    // Requests limit + 1 (8) so an overflow beyond the user-supplied limit is
    // observable; `seeds`/`output.results` are still bound to 7.
    expect(findNeighbors).toHaveBeenCalledWith(expect.objectContaining({ limit: 8 }));
  });

  it('truncated is true when the engine yields more than the mode limit (quick: 4 hits, limit 3)', async () => {
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
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it('truncated is false when the engine yields at most the mode limit', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
    });

    const output = await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results).toHaveLength(2);
    expect(output.truncated).toBe(false);
  });
});

// These invariants are about what happens BETWEEN queries — they have no
// single-query meaning, so they stay outside the arity table above. Each uses
// per-query embedding vectors and order-keyed engine mocks deliberately: the
// point is that the queries differ.
describe('cross-query behaviour (query array only)', () => {
  it('merges seeds by path, keeping max similarity, and aggregates matched_queries', async () => {
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

    const output = await executeRetrieval({
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

  it('tracks fallback independently per query', async () => {
    const fallbackSources = makeSources([
      ['note-a.md', [1, 0]],
      ['note-b.md', [0, 1]],
    ]);
    // Keyed by query vector, not call order — Promise.all interleaving must
    // not matter.
    const embeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockImplementation(async (q: string) => (q === 'q1' ? [1, 0] : [0, 1])),
    };
    const findNeighbors = vi.fn(
      ({ queryVector, threshold }: { queryVector: number[]; threshold: number }) => {
        if (queryVector[0] === 1) return [makeSearchResult('note-a.md', 0.8)];
        return threshold <= 0.3 ? [makeSearchResult('note-b.md', 0.4)] : [];
      },
    );
    const searchEngine = makeSearchEngine({ findNeighbors });

    const output = await executeRetrieval({
      queries: ['q1', 'q2'],
      mode: 'quick',
      sources: fallbackSources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.per_query_fallback).toEqual({ q1: false, q2: true });
  });

  it('dedupes blocks across query vectors, keeping max similarity', async () => {
    // Two queries each surface the same block at different similarities. The
    // merged block must carry the higher similarity (0.8), not the lower (0.5).
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
          { path: 'note-a.md', heading: '#h', lines: [1, 3] as [number, number], similarity: 0.5 },
        ])
        .mockReturnValueOnce([
          { path: 'note-a.md', heading: '#h', lines: [1, 3] as [number, number], similarity: 0.8 },
        ]),
    });

    const output = await executeRetrieval({
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
  // Step 4's shared-pass dedup (above) and Step 4b's per-seed backfill are two
  // separate max-keeping comparisons. This is the backfill one: a seed the
  // shared pass starved gets one scoped lookup per query vector, and must end
  // up with the highest-similarity block of them — whichever query order the
  // vectors arrive in. A fixture embedding every query to one vector cannot
  // observe this, so the two vectors here have to genuinely differ.
  it.each([
    { label: 'higher-similarity query last', queries: ['q-low', 'q-high'] },
    { label: 'higher-similarity query first', queries: ['q-high', 'q-low'] },
  ])(
    'backfills a starved seed with the best block across query vectors ($label)',
    async ({ queries }) => {
      const embeddingProvider: EmbeddingProvider = {
        initialize: vi.fn(),
        embed: vi.fn((query: string) => Promise.resolve(query === 'q-high' ? [0, 1] : [1, 0])),
      };
      const findBlockNeighbors = vi.fn(
        ({
          sources: scoped,
          queryVector,
          limit,
        }: {
          sources: Iterable<SmartSource>;
          queryVector: number[];
          limit?: number;
        }) => {
          // Same shape test the backfill suite uses: the scoped, limit-1 call.
          if (!(Array.isArray(scoped) && scoped.length === 1 && limit === 1)) {
            return [makeBlockResult('note-a.md', 0.9)]; // shared pass starves note-b
          }
          // The backfill lookup answers differently per vector: [0, 1] finds
          // a strictly better block than [1, 0] does.
          return [makeBlockResult('note-b.md', queryVector[1] === 1 ? 0.7 : 0.3)];
        },
      );
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValue([
            makeSearchResult('note-a.md', 0.9),
            makeSearchResult('note-b.md', 0.8),
          ]),
        findBlockNeighbors,
      });

      const output = await executeRetrieval({
        queries,
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteB = output.results.find((r) => r.path === 'note-b.md')!;
      expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.7 }]);
      // Both vectors were actually probed: 2 shared-pass calls + 2 backfill lookups.
      expect(findBlockNeighbors).toHaveBeenCalledTimes(4);
    },
  );

  it("truncated is true when a single query's own pool overflows, even though the merged list fits under limit", async () => {
    // limit defaults to 3 (quick). Query 'a' yields 4 hits — more than its own
    // pool cap — so it overflows and is sliced to its top 3. Query 'b' returns
    // exactly those same 3 paths, contributing no new unique paths, so the
    // CROSS-QUERY merge cap never fires (merged.length === limit). `truncated`
    // must still be true, driven by query 'a's per-query overflow.
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

    const output = await executeRetrieval({
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

    const output = await executeRetrieval({
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

    const output = await executeRetrieval({
      queries: ['a', 'dead'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    expect(output.per_query_hits).toEqual({ a: 2, dead: 0 });
  });

  it('reports pre-cap hit counts for a query whose hits are all dropped by the cross-query cap', async () => {
    // limit=2. Query 'a' contributes 2 high-similarity notes that alone fill
    // the cap. Query 'b' contributes 1 lower-similarity note that survives the
    // merge sort but is sliced off by the Step-3 cap. per_query_hits must still
    // report b's pre-cap count (1), taken from perQueryOutputs, not from the
    // post-cap seeds.
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

    const output = await executeRetrieval({
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
});
