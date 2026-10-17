import { describe, expect, it, vi } from 'vitest';

import type {
  CorpusAnchor,
  IBlockHit,
  ICorpusReader,
  INearestBlocksOptions,
  INearestOptions,
  INoteHit,
} from '../../src/lib/obsidian/corpus/corpus.js';
import type { QueryEmbedder } from '../../src/types.js';
import type { SimilarityDefaults } from '../../src/lib/model-profiles.js';
import { executeRetrieval } from '../../src/modules/semantic/retrieval-policy.js';
import { TEST_SIMILARITY } from '../_identity.js';

// The vector every fixture below embeds every query to. A single shared ARRAY
// INSTANCE on purpose: `embedQuery` is mocked with `mockResolvedValue(QUERY_VECTOR)`,
// so an anchor holding this exact instance is a query anchor, while a
// `{ path }` anchor is a seed — i.e. the per-seed expansion leg. Routing on
// the anchor rather than call order is what lets one fixture serve both
// arities.
const QUERY_VECTOR = [1, 0];

function makeSearchResult(path: string, similarity: number): INoteHit {
  return { path, similarity };
}

function makeBlockResult(path: string, similarity: number): IBlockHit {
  return { path, heading: '#block', lines: [1, 3], similarity };
}

function makeEmbeddingProvider(vector: number[] = QUERY_VECTOR): QueryEmbedder {
  return {
    initialize: vi.fn(),
    embedQuery: vi.fn().mockResolvedValue(vector),
  };
}

type NearestFn = (anchor: CorpusAnchor, opts: INearestOptions) => INoteHit[] | null | undefined;
type BlocksFn = (
  anchor: CorpusAnchor,
  opts: INearestBlocksOptions,
) => IBlockHit[] | null | undefined;

// A fake corpus answering each anchor of a call through a per-anchor function.
// `findNeighbors` / `findBlockNeighbors` are those per-anchor spies: one call
// per anchor, with the call's options — so "called once per query" still
// reads as it did, while `corpus.nearest` / `corpus.nearestBlocks` count the
// corpus reads themselves (one per step).
function makeCorpus(overrides: { findNeighbors?: NearestFn; findBlockNeighbors?: BlocksFn } = {}) {
  const findNeighbors = vi.fn<NearestFn>(overrides.findNeighbors ?? (() => []));
  const findBlockNeighbors = vi.fn<BlocksFn>(overrides.findBlockNeighbors ?? (() => []));
  const corpus = {
    nearest: vi.fn((anchors: readonly CorpusAnchor[], opts: INearestOptions) =>
      Promise.resolve(anchors.map((anchor) => findNeighbors(anchor, opts) ?? null)),
    ),
    nearestBlocks: vi.fn((anchors: readonly CorpusAnchor[], opts: INearestBlocksOptions) =>
      Promise.resolve(anchors.map((anchor) => findBlockNeighbors(anchor, opts) ?? null)),
    ),
  } satisfies ICorpusReader;
  return { corpus, findNeighbors, findBlockNeighbors };
}

const isQueryAnchor = (anchor: CorpusAnchor): boolean =>
  'vector' in anchor && anchor.vector === QUERY_VECTOR;

// A per-anchor `nearest` that tells the seed pass apart from the per-seed
// expansion pass by its anchor (see QUERY_VECTOR above), instead of by call
// order. `seeds` may be a function of `threshold` so a fixture can make the
// mode-default pass come back empty and let only the 0.3 retry find anything.
function routedNeighbors(args: {
  seeds: INoteHit[] | ((threshold: number) => INoteHit[]);
  relatedBySeed?: Record<string, INoteHit[]>;
}): NearestFn {
  const { seeds, relatedBySeed = {} } = args;
  return (anchor, { threshold }) => {
    if (isQueryAnchor(anchor)) return typeof seeds === 'function' ? seeds(threshold) : seeds;
    if ('path' in anchor) return relatedBySeed[anchor.path] ?? [];
    return [];
  };
}

// The expansion read is the only one anchored on seed paths.
const expansionCalls = (findNeighbors: ReturnType<typeof makeCorpus>['findNeighbors']) =>
  findNeighbors.mock.calls.filter(([anchor]) => 'path' in anchor);

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
  const oneHit = () => () => [makeSearchResult('note-a.md', 0.9)];

  it('quick mode asks for threshold 0.5 and limit 4 (mode limit 3 + 1 truncation-detection overfetch)', async () => {
    const { corpus, findNeighbors } = makeCorpus({ findNeighbors: oneHit() });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    // One corpus read carrying one anchor per query — assert every anchor's shape.
    expect(corpus.nearest).toHaveBeenCalledTimes(1);
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [anchor, opts] of findNeighbors.mock.calls) {
      expect(isQueryAnchor(anchor)).toBe(true);
      expect(opts).toMatchObject({ threshold: 0.5, limit: 4 });
    }
  });

  it('deep mode asks for threshold 0.35 and limit 9 (mode limit 8 + 1 truncation-detection overfetch)', async () => {
    const { corpus, findNeighbors } = makeCorpus({ findNeighbors: oneHit() });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      expansion: false,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(corpus.nearest).toHaveBeenCalledTimes(1);
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [, opts] of findNeighbors.mock.calls) {
      expect(opts).toMatchObject({ threshold: 0.35, limit: 9 });
    }
  });

  it('quick mode attaches blocks scoped to matched notes when there are vector results', async () => {
    const { corpus, findBlockNeighbors } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.8)],
      findBlockNeighbors: () => [makeBlockResult('note-a.md', 0.75)],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.75 }]);
    expect(noteA.related).toEqual([]);
    // One shared-pass block read carrying every query, with the quick-mode
    // shape and the seeds as its notes; no backfill, since note-a already has
    // evidence.
    expect(corpus.nearestBlocks).toHaveBeenCalledTimes(1);
    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [, opts] of findBlockNeighbors.mock.calls) {
      expect(opts).toEqual({ paths: ['note-a.md'], threshold: 0, limit: 5 });
    }
  });

  it('emits no results and never runs block search when there are no matches', async () => {
    const { corpus } = makeCorpus();

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toEqual([]);
    expect(corpus.nearestBlocks).not.toHaveBeenCalled();
  });

  it('deep mode drops orphan blocks — only blocks belonging to result notes are attached', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.8)],
      findBlockNeighbors: () => [
        makeBlockResult('note-a.md', 0.7),
        makeBlockResult('note-c.md', 0.85), // orphan — note-c is not a seed
      ],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results.map((r) => r.path)).not.toContain('note-c.md');
    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.7 }]);
  });
});

describe.each(arities)('fallback to lower threshold (%s)', (_label, queries) => {
  it('retries with threshold 0.3 when the initial search returns empty', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: (_anchor, { threshold }) =>
        threshold <= 0.3 ? [makeSearchResult('note-a.md', 0.35)] : [],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    // Two reads, each carrying every query: the mode default, then the 0.3 retry.
    expect(corpus.nearest).toHaveBeenCalledTimes(2);
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length * 2);
    const retries = findNeighbors.mock.calls.filter(([, opts]) => opts.threshold === 0.3);
    expect(retries).toHaveLength(queries.length);
    for (const [, opts] of retries) expect(opts.limit).toBe(4);
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
  });

  it('does not retry when the initial threshold is already <= 0.3', async () => {
    const { corpus, findNeighbors } = makeCorpus();

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      threshold: 0.3,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
  });
});

describe.each(arities)('explicit threshold is a hard filter (%s)', (_label, queries) => {
  it('does not retry at 0.3 when an explicit threshold filters everything', async () => {
    const { corpus, findNeighbors } = makeCorpus();

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      threshold: 0.99,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toEqual([]);
    // One pass per query, no retries.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [, opts] of findNeighbors.mock.calls) expect(opts.threshold).toBe(0.99);
    expect(output.per_query_fallback).toEqual(allFalse(queries));
  });

  it('retries at 0.3 for the default threshold and reports per-query fallback true', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: (_anchor, { threshold }) =>
        threshold <= 0.3 ? [makeSearchResult('note-a.md', 0.4)] : [],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length * 2);
    expect(findNeighbors.mock.calls.filter(([, opts]) => opts.threshold === 0.3)).toHaveLength(
      queries.length,
    );
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
    expect(output.per_query_fallback).toEqual(allTrue(queries));
  });

  it('reports per-query fallback false when the first pass already had hits', async () => {
    const { corpus } = makeCorpus({ findNeighbors: () => [makeSearchResult('note-a.md', 0.8)] });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.per_query_fallback).toEqual(allFalse(queries));
  });

  it('passes a custom threshold to the corpus instead of the mode default', async () => {
    const { corpus, findNeighbors } = makeCorpus();

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      threshold: 0.7,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [, opts] of findNeighbors.mock.calls) expect(opts.threshold).toBe(0.7);
  });
});

describe.each(arities)('per-seed expansion, deep mode (%s)', (_label, queries) => {
  it('attaches each seed its own related[] populated from its own neighbours', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)],
        relatedBySeed: {
          'note-a.md': [makeSearchResult('note-c.md', 0.65)],
          'note-b.md': [],
        },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
    expect(noteB.related).toEqual([]);
  });

  it('the same neighbour appears in related[] of every seed it neighbours (no global dedup)', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)],
        relatedBySeed: {
          'note-a.md': [makeSearchResult('note-c.md', 0.65)],
          'note-b.md': [makeSearchResult('note-c.md', 0.55)],
        },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 3,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteA.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.65 }]);
    expect(noteB.related).toEqual([{ path: 'note-c.md', expansion_similarity: 0.55 }]);
  });

  it('asks for every seed in one read, every seed excluded, capped at expansionLimit', async () => {
    // Excluding the seeds before the per-seed cap is what keeps a seed out of
    // every related[] and still fills the cap when top neighbours are seeds.
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [
          makeSearchResult('seed-a.md', 0.95),
          makeSearchResult('seed-b.md', 0.93),
          makeSearchResult('seed-c.md', 0.91),
        ],
      }),
    });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      expansion: true,
      expansionLimit: 2,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    // Seeds, then expansion: two reads.
    expect(corpus.nearest).toHaveBeenCalledTimes(2);
    const [anchors, opts] = corpus.nearest.mock.calls[1];
    expect(anchors).toEqual([{ path: 'seed-a.md' }, { path: 'seed-b.md' }, { path: 'seed-c.md' }]);
    expect(opts).toEqual({
      threshold: 0.35,
      limit: 2,
      exclude: ['seed-a.md', 'seed-b.md', 'seed-c.md'],
      allowed: undefined,
    });
    expect(expansionCalls(findNeighbors)).toHaveLength(3);
  });

  it('a seed without a vector of its own gets an empty related[]', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: (anchor) =>
        isQueryAnchor(anchor) ? [makeSearchResult('note-a.md', 0.9)] : null,
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results.find((r) => r.path === 'note-a.md')!.related).toEqual([]);
  });

  it('does not run expansion when expansion is false (related stays empty)', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      expansion: false,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    // Seed pass only — no per-seed expansion read.
    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('quick mode never populates related[]', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(findNeighbors).toHaveBeenCalledTimes(queries.length);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('deep defaults give seeds a non-empty related[] when neighbours exist', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.related[0]).toEqual({ path: 'note-b.md', expansion_similarity: 0.7 });
  });
});

describe.each(arities)('expansion floor and block decoupling (%s)', (_label, queries) => {
  it('floors the per-seed neighbour lookup at expansionFloor, not threshold', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.8)],
    });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      threshold: 0.7, // explicit, must NOT reach expansion
      expansionFloor: 0.93,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const expansion = expansionCalls(findNeighbors);
    expect(expansion.length).toBeGreaterThan(0);
    for (const [, opts] of expansion) {
      expect(opts.threshold).toBe(0.93);
    }
  });

  it('defaults the floor to 0.35 when expansionFloor is absent', async () => {
    const { corpus, findNeighbors } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.8)],
    });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      threshold: 0.7,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const expansion = expansionCalls(findNeighbors);
    expect(expansion.length).toBeGreaterThan(0);
    for (const [, opts] of expansion) {
      expect(opts.threshold).toBe(0.35);
    }
  });

  it('filters deep blocks at the internal default, not the user threshold', async () => {
    const { corpus, findBlockNeighbors } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.8)],
      findBlockNeighbors: () => [makeBlockResult('note-a.md', 0.75)],
    });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      threshold: 0.7,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const [, opts] of findBlockNeighbors.mock.calls) {
      expect(opts).toEqual({ paths: ['note-a.md'], threshold: 0.35, limit: 8 });
    }
  });
});

describe.each(arities)('the allowed set (%s)', (_label, queries) => {
  it('reaches every note read — seeds, fallback and expansion — and not the block reads', async () => {
    const allowed = ['note-a.md', 'note-b.md'];
    const { corpus } = makeCorpus({
      findNeighbors: (anchor, { threshold }) =>
        isQueryAnchor(anchor) && threshold <= 0.3 ? [makeSearchResult('note-a.md', 0.31)] : [],
    });

    await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      allowed,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    // Seeds, fallback, expansion.
    expect(corpus.nearest).toHaveBeenCalledTimes(3);
    for (const [, opts] of corpus.nearest.mock.calls) expect(opts.allowed).toEqual(allowed);
    // Block reads are scoped to the seeds, which the allowed set already bounds.
    for (const [, opts] of corpus.nearestBlocks.mock.calls) {
      expect(opts).not.toHaveProperty('allowed');
    }
  });
});

describe.each(arities)('per-seed block backfill (%s)', (_label, queries) => {
  // The backfill read is the only one scoped to a single note with limit 1 —
  // that shape, not call order, identifies it at either arity.
  const isBackfill = ({ paths, limit }: INearestBlocksOptions): boolean =>
    paths.length === 1 && limit === 1;
  const twoSeeds = () => [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)];

  it('backfills the best block for a seed starved by the shared pass', async () => {
    const { corpus, findBlockNeighbors } = makeCorpus({
      findNeighbors: twoSeeds,
      findBlockNeighbors: (_anchor, opts) =>
        isBackfill(opts)
          ? [makeBlockResult('note-b.md', 0.42)]
          : [makeBlockResult('note-a.md', 0.9)], // shared pass: all to note-a
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.42 }]);
    // The backfill read is scoped to note-b alone, threshold 0, limit 1, and
    // carries every query.
    expect(corpus.nearestBlocks).toHaveBeenCalledTimes(2);
    const [anchors, opts] = corpus.nearestBlocks.mock.calls[1];
    expect(anchors).toHaveLength(queries.length);
    expect(opts).toEqual({ paths: ['note-b.md'], threshold: 0, limit: 1 });
    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length * 2);
  });

  it('leaves blocks empty when the note has no block embeddings', async () => {
    const { corpus } = makeCorpus({ findNeighbors: twoSeeds });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
  });

  it('ignores foreign-path results from a backfill lookup', async () => {
    // Defensive: a (mis)behaving corpus returning another note's block for a
    // scoped lookup must not attach evidence to the wrong seed.
    const { corpus, findBlockNeighbors } = makeCorpus({
      findNeighbors: twoSeeds,
      findBlockNeighbors: (_anchor, opts) =>
        isBackfill(opts)
          ? [makeBlockResult('note-a.md', 0.5)] // wrong note for a note-b lookup
          : [makeBlockResult('note-a.md', 0.9)],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
    // One shared pass per query, plus one backfill lookup per query vector.
    expect(findBlockNeighbors).toHaveBeenCalledTimes(queries.length * 2);
  });
});

describe.each(arities)('shape invariants (%s)', (_label, queries) => {
  it('every result has blocks: [] and related: [] when no leaves apply', async () => {
    const { corpus } = makeCorpus({ findNeighbors: () => [makeSearchResult('note-a.md', 0.9)] });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      expansion: false,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
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
    const { corpus } = makeCorpus({ findNeighbors: () => [makeSearchResult('note-a.md', 0.9)] });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results[0].matched_queries).toEqual(queries);
  });

  it('related items never carry a similarity field — only expansion_similarity', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: routedNeighbors({
        seeds: [makeSearchResult('note-a.md', 0.9)],
        relatedBySeed: { 'note-a.md': [makeSearchResult('note-b.md', 0.7)] },
      }),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
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
    // The corpus returns blocks in arbitrary order; assembly must sort them.
    const { corpus } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.9)],
      findBlockNeighbors: () => [
        { path: 'note-a.md', heading: '#low', lines: [10, 12], similarity: 0.3 },
        { path: 'note-a.md', heading: '#high', lines: [1, 3], similarity: 0.9 },
        { path: 'note-a.md', heading: '#mid', lines: [5, 7], similarity: 0.6 },
      ],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks.map((b) => b.similarity)).toEqual([0.9, 0.6, 0.3]);
  });

  it('output never has a top-level blockResults field', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.9)],
      findBlockNeighbors: () => [makeBlockResult('note-a.md', 0.8)],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'deep',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output).not.toHaveProperty('blockResults');
  });
});

describe.each(arities)('result cap and leg-level pool truncation (%s)', (_label, queries) => {
  const manyResults = Array.from({ length: 10 }, (_, i) =>
    makeSearchResult(`note-${i}.md`, 0.9 - i * 0.05),
  );

  it('slices results to the mode limit', async () => {
    const { corpus } = makeCorpus({ findNeighbors: () => manyResults });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toHaveLength(3);
  });

  it('a user-supplied limit overrides the mode default', async () => {
    const { corpus, findNeighbors } = makeCorpus({ findNeighbors: () => manyResults });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      limit: 7,
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toHaveLength(7);
    // Requests limit + 1 (8) so an overflow beyond the user-supplied limit is
    // observable; `seeds`/`output.results` are still bound to 7.
    expect(findNeighbors).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 8 }),
    );
  });

  it('truncated is true when the corpus yields more than the mode limit (quick: 4 hits, limit 3)', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: () => [
        makeSearchResult('note-a.md', 0.9),
        makeSearchResult('note-b.md', 0.8),
        makeSearchResult('note-c.md', 0.7),
        makeSearchResult('note-d.md', 0.6),
      ],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it('truncated is false when the corpus yields at most the mode limit', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries,
      mode: 'quick',
      corpus,
      embeddingProvider: makeEmbeddingProvider(),
    });

    expect(output.results).toHaveLength(2);
    expect(output.truncated).toBe(false);
  });
});

// These invariants are about what happens BETWEEN queries — they have no
// single-query meaning, so they stay outside the arity table above. Each uses
// per-query embedding vectors and anchor-order-keyed corpus answers
// deliberately: the point is that the queries differ.
describe('cross-query behaviour (query array only)', () => {
  // Embeds query `i` of `queries` to `vectors[i]`, whatever order the calls come in.
  function embedderFor(queries: string[], vectors: number[][]): QueryEmbedder {
    return {
      initialize: vi.fn(),
      embedQuery: vi.fn((q: string) => Promise.resolve(vectors[queries.indexOf(q)])),
    };
  }

  it('merges seeds by path, keeping max similarity, and aggregates matched_queries', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: (anchor) =>
        'vector' in anchor && anchor.vector[0] === 1
          ? [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.7)]
          : [makeSearchResult('note-b.md', 0.6), makeSearchResult('note-c.md', 0.5)],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['alpha', 'beta'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedderFor(
        ['alpha', 'beta'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
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

  it('tracks fallback independently per query, retrying only the queries left empty', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: (anchor, { threshold }) => {
        if ('vector' in anchor && anchor.vector[0] === 1)
          return [makeSearchResult('note-a.md', 0.8)];
        return threshold <= 0.3 ? [makeSearchResult('note-b.md', 0.4)] : [];
      },
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['q1', 'q2'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedderFor(
        ['q1', 'q2'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    });

    expect(output.per_query_fallback).toEqual({ q1: false, q2: true });
    // The retry carries q2's vector alone.
    expect(corpus.nearest.mock.calls[1][0]).toEqual([{ vector: [0, 1] }]);
  });

  it('dedupes blocks across query vectors, keeping max similarity', async () => {
    // Two queries each surface the same block at different similarities. The
    // merged block must carry the higher similarity (0.8), not the lower (0.5).
    const { corpus } = makeCorpus({
      findNeighbors: (anchor) =>
        'vector' in anchor && anchor.vector[0] === 1
          ? [makeSearchResult('note-a.md', 0.9)] // q1 seed
          : [makeSearchResult('note-a.md', 0.85)], // q2 seed (same note)
      findBlockNeighbors: (anchor) => [
        {
          path: 'note-a.md',
          heading: '#h',
          lines: [1, 3],
          similarity: 'vector' in anchor && anchor.vector[0] === 1 ? 0.5 : 0.8,
        },
      ],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['q1', 'q2'],
      mode: 'deep',
      expansion: false,
      corpus,
      embeddingProvider: embedderFor(
        ['q1', 'q2'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    });

    const noteA = output.results.find((r) => r.path === 'note-a.md')!;
    expect(noteA.blocks).toEqual([{ heading: '#h', lines: [1, 3], similarity: 0.8 }]);
  });
  // Step 4's shared-pass dedup (above) and Step 4b's per-seed backfill are two
  // separate max-keeping comparisons. This is the backfill one: a seed the
  // shared pass starved gets one scoped lookup carrying every query vector,
  // and must end up with the highest-similarity block of them — whichever
  // query order the vectors arrive in. A fixture embedding every query to one
  // vector cannot observe this, so the two vectors here have to genuinely
  // differ.
  it.each([
    { label: 'higher-similarity query last', queries: ['q-low', 'q-high'] },
    { label: 'higher-similarity query first', queries: ['q-high', 'q-low'] },
  ])(
    'backfills a starved seed with the best block across query vectors ($label)',
    async ({ queries }) => {
      const embeddingProvider: QueryEmbedder = {
        initialize: vi.fn(),
        embedQuery: vi.fn((query: string) => Promise.resolve(query === 'q-high' ? [0, 1] : [1, 0])),
      };
      const { corpus, findBlockNeighbors } = makeCorpus({
        findNeighbors: () => [
          makeSearchResult('note-a.md', 0.9),
          makeSearchResult('note-b.md', 0.8),
        ],
        findBlockNeighbors: (anchor, { paths, limit }) => {
          // Same shape test the backfill suite uses: the scoped, limit-1 call.
          if (!(paths.length === 1 && limit === 1)) {
            return [makeBlockResult('note-a.md', 0.9)]; // shared pass starves note-b
          }
          // The backfill lookup answers differently per vector: [0, 1] finds
          // a strictly better block than [1, 0] does.
          const high = 'vector' in anchor && anchor.vector[1] === 1;
          return [makeBlockResult('note-b.md', high ? 0.7 : 0.3)];
        },
      });

      const output = await executeRetrieval({
        similarity: TEST_SIMILARITY,
        queries,
        mode: 'quick',
        corpus,
        embeddingProvider,
      });

      const noteB = output.results.find((r) => r.path === 'note-b.md')!;
      expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.7 }]);
      // Both vectors were actually probed: 2 shared-pass anchors + 2 backfill anchors.
      expect(findBlockNeighbors).toHaveBeenCalledTimes(4);
    },
  );

  it("on a backfill tie across query vectors, the first query's block wins", async () => {
    const { corpus } = makeCorpus({
      findNeighbors: () => [makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)],
      findBlockNeighbors: (anchor, { paths, limit }) => {
        if (!(paths.length === 1 && limit === 1)) return [makeBlockResult('note-a.md', 0.9)];
        const first = 'vector' in anchor && anchor.vector[0] === 1;
        return [
          {
            path: 'note-b.md',
            heading: first ? '#first' : '#second',
            lines: [1, 3],
            similarity: 0.4,
          },
        ];
      },
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['one', 'two'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedderFor(
        ['one', 'two'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([
      { heading: '#first', lines: [1, 3], similarity: 0.4 },
    ]);
  });

  it("truncated is true when a single query's own pool overflows, even though the merged list fits under limit", async () => {
    // limit defaults to 3 (quick). Query 'a' yields 4 hits — more than its own
    // pool cap — so it overflows and is sliced to its top 3. Query 'b' returns
    // exactly those same 3 paths, contributing no new unique paths, so the
    // CROSS-QUERY merge cap never fires (merged.length === limit). `truncated`
    // must still be true, driven by query 'a's per-query overflow.
    const { corpus } = makeCorpus({
      findNeighbors: (anchor) =>
        'vector' in anchor && anchor.vector[0] === 1
          ? [
              makeSearchResult('note-a.md', 0.95),
              makeSearchResult('note-b.md', 0.9),
              makeSearchResult('note-c.md', 0.85),
              makeSearchResult('note-d.md', 0.8),
            ]
          : [
              makeSearchResult('note-a.md', 0.5),
              makeSearchResult('note-b.md', 0.4),
              makeSearchResult('note-c.md', 0.3),
            ],
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['a', 'b'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedderFor(
        ['a', 'b'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
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
    const prefixes = ['a', 'b', 'c'];
    const { corpus } = makeCorpus({
      findNeighbors: vi
        .fn<NearestFn>()
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) =>
            makeSearchResult(`${prefixes[0]}-${i}.md`, 0.9 - i * 0.01),
          ),
        )
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) =>
            makeSearchResult(`${prefixes[1]}-${i}.md`, 0.9 - i * 0.01),
          ),
        )
        .mockReturnValueOnce(
          Array.from({ length: 5 }, (_, i) =>
            makeSearchResult(`${prefixes[2]}-${i}.md`, 0.9 - i * 0.01),
          ),
        ),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['a', 'b', 'c'],
      mode: 'quick',
      limit: 5,
      corpus,
      embeddingProvider: makeEmbeddingProvider([1, 0]),
    });

    expect(output.results).toHaveLength(5);
    expect(output.truncated).toBe(true);
  });

  it('reports per-query hits before the cross-query cap', async () => {
    const { corpus } = makeCorpus({
      findNeighbors: vi
        .fn<NearestFn>()
        .mockReturnValueOnce([
          makeSearchResult('note-a.md', 0.9),
          makeSearchResult('note-b.md', 0.7),
        ])
        .mockReturnValueOnce([]) // 'dead' initial threshold
        .mockReturnValueOnce([]), // 'dead' fallback threshold (still no hits)
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['a', 'dead'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedderFor(
        ['a', 'dead'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    });

    expect(output.per_query_hits).toEqual({ a: 2, dead: 0 });
  });

  it('reports pre-cap hit counts for a query whose hits are all dropped by the cross-query cap', async () => {
    // limit=2. Query 'a' contributes 2 high-similarity notes that alone fill
    // the cap. Query 'b' contributes 1 lower-similarity note that survives the
    // merge sort but is sliced off by the Step-3 cap. per_query_hits must still
    // report b's pre-cap count (1), taken from perQueryOutputs, not from the
    // post-cap seeds.
    const { corpus } = makeCorpus({
      findNeighbors: vi
        .fn<NearestFn>()
        .mockReturnValueOnce([
          makeSearchResult('note-a1.md', 0.9),
          makeSearchResult('note-a2.md', 0.85),
        ])
        .mockReturnValueOnce([makeSearchResult('note-b1.md', 0.5)]),
    });

    const output = await executeRetrieval({
      similarity: TEST_SIMILARITY,
      queries: ['a', 'b'],
      mode: 'quick',
      limit: 2,
      corpus,
      embeddingProvider: embedderFor(
        ['a', 'b'],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    });

    expect(output.results.map((r) => r.path)).toEqual(['note-a1.md', 'note-a2.md']);
    expect(output.truncated).toBe(true);
    expect(output.per_query_hits).toEqual({ a: 2, b: 1 });
  });
});

const DISTINCT: SimilarityDefaults = {
  quick: 0.7,
  deep: 0.6,
  fallback: 0.55,
  expansionFloor: 0.9,
  similarNotes: 0.8,
  duplicates: 0.99,
};
const QUERY = [1, 0];
const embedder = { initialize: async () => {}, embedQuery: async () => QUERY };

describe('executeRetrieval — profile similarity defaults', () => {
  it("filters at the profile's quick default, then retries at its fallback", async () => {
    const thresholds: number[] = [];
    const { corpus } = makeCorpus({
      findNeighbors: (_anchor, { threshold }) => (thresholds.push(threshold), []),
    });
    await executeRetrieval({
      queries: ['q'],
      mode: 'quick',
      corpus,
      embeddingProvider: embedder,
      similarity: DISTINCT,
    });
    expect(thresholds).toEqual([0.7, 0.55]);
  });

  it("uses the profile's deep default for seeds and block evidence, and its expansion floor", async () => {
    const calls: Array<[string, number]> = [];
    const { corpus } = makeCorpus({
      findNeighbors: (anchor, { threshold }) => {
        const seed = 'vector' in anchor && anchor.vector === QUERY;
        calls.push([seed ? 'seed' : 'expansion', threshold]);
        return seed ? [{ path: 'a.md', similarity: 0.65 }] : [];
      },
      findBlockNeighbors: (_anchor, { threshold }) => (calls.push(['block', threshold]), []),
    });
    await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      corpus,
      embeddingProvider: embedder,
      similarity: DISTINCT,
    });
    expect(calls).toContainEqual(['seed', 0.6]);
    expect(calls).toContainEqual(['block', 0.6]);
    expect(calls).toContainEqual(['expansion', 0.9]);
  });

  it('an explicit threshold still wins and never falls back', async () => {
    const thresholds: number[] = [];
    const { corpus } = makeCorpus({
      findNeighbors: (_anchor, { threshold }) => (thresholds.push(threshold), []),
    });
    await executeRetrieval({
      queries: ['q'],
      mode: 'quick',
      threshold: 0.95,
      corpus,
      embeddingProvider: embedder,
      similarity: DISTINCT,
    });
    expect(thresholds).toEqual([0.95]);
  });
});
