import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ICorpusReader } from '../../src/lib/obsidian/corpus/corpus.js';
import type { CorpusIdentity } from '../../src/lib/obsidian/corpus/identity.js';
import { ShardCorpus } from '../../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import type { CorpusShard, SmartSource } from '../../src/lib/obsidian/corpus/types.js';
import { decodeVector, encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import {
  executeRetrieval,
  type RetrievalOutput,
} from '../../src/modules/semantic/retrieval-policy.js';
import { snapshotReader } from '../../src/modules/semantic/snapshot-reader.js';
import type { QueryEmbedder, SearchMode } from '../../src/modules/semantic/types.js';
import { TEST_IDENTITY, TEST_SIMILARITY } from '../_identity.js';
import { legacyExecuteRetrieval, legacyNarrowSources } from './_legacy-retrieval.js';

// Ranking parity (design D13): the semantic leg composed over `ICorpusReader`
// must return exactly what the in-memory leg it replaced returns. The oracle
// is a frozen copy of that leg; the fixture is written once as shards, so the
// same corpus is read both through the snapshot bridge and a loaded
// `ShardCorpus`.

const DIMS = 8;
const IDENTITY: CorpusIdentity = { ...TEST_IDENTITY, dims: DIMS };

// A deterministic LCG — the fixture must be the same on every run.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
const random = makeRandom(20261017);
const noise = (scale: number): number => (random() * 2 - 1) * scale;

// Three query directions in the first seven dimensions; the eighth is kept
// free for the `dead` query, so only the faint notes reach it at all.
const CENTERS: Record<string, number[]> = {
  alpha: [1, 0.2, 0, 0, 0.1, 0, 0, 0],
  beta: [0, 1, 0.3, 0, 0, 0.2, 0, 0],
  gamma: [0, 0, 0, 1, 0.2, 0, 0.4, 0],
};
const QUERY_VECTORS: Record<string, number[]> = {
  ...CENTERS,
  dead: [0, 0, 0, 0, 0, 0, 0, 1],
  // Two axes the `tied` note sits between, for a backfill tie across queries.
  left: [0, 0, 1, 0, 0, 0, 0, 0],
  right: [0, 0, 0, 0, 0, 0, 1, 0],
};

const near = (center: number[], scale: number): number[] =>
  center.map((v, i) => (i === DIMS - 1 ? 0 : v + noise(scale)));

interface IBlockSpec {
  heading: string;
  vector: number[];
}

function shard(notePath: string, note: number[] | null, blocks: IBlockSpec[]): CorpusShard {
  return {
    path: notePath,
    content_hash: `hash-${notePath}`,
    mtime: 1000,
    size: 100,
    embedding: note === null ? null : encodeVector(note),
    blocks: blocks.map((b, i) => ({
      key: `#${b.heading}`,
      heading: `#${b.heading}`,
      lines: [i * 4 + 1, i * 4 + 3],
      embedding: encodeVector(b.vector),
    })),
  };
}

function randomBlocks(note: number[], count: number): IBlockSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    heading: `Section ${i}`,
    vector: near(note, 0.9),
  }));
}

function buildFixture(): CorpusShard[] {
  const shards: CorpusShard[] = [];
  const clusters = Object.keys(CENTERS);
  // 24 clustered notes: 8 per direction, with 0..3 blocks each.
  for (let i = 0; i < 24; i++) {
    const center = CENTERS[clusters[i % clusters.length]];
    const note = near(center, 0.55);
    const folder = i % 4 === 0 ? 'Folder' : 'Notes';
    shards.push(
      shard(`${folder}/n${String(i).padStart(2, '0')}.md`, note, randomBlocks(note, i % 4)),
    );
  }
  // Two notes on the same vector: a similarity tie the path order must break.
  const twin = near(CENTERS.alpha, 0.1);
  shards.push(shard('Notes/twin-a.md', twin, randomBlocks(twin, 1)));
  shards.push(shard('Notes/twin-b.md', twin, randomBlocks(twin, 2)));
  // Two blocks on one vector inside one note: a tie within a note.
  const echo = near(CENTERS.beta, 0.2);
  const echoBlock = near(echo, 0.3);
  shards.push(
    shard('Notes/echo.md', echo, [
      { heading: 'First', vector: echoBlock },
      { heading: 'Second', vector: echoBlock },
    ]),
  );
  // Only these reach `dead`, between 0.31 and 0.33: under every default
  // threshold, over the fallback one, and more than the quick pool holds.
  // faint-a and faint-d tie.
  shards.push(shard('Notes/faint-a.md', [0.95, 0, 0, 0, 0, 0, 0, 0.32], []));
  shards.push(
    shard(
      'Notes/faint-b.md',
      [0, 0.96, 0, 0, 0, 0, 0, 0.31],
      [{ heading: 'Only', vector: [0, 0.5, 0, 0, 0, 0, 0, 0.9] }],
    ),
  );
  shards.push(shard('Notes/faint-c.md', [0, 0, 0, 0.94, 0, 0, 0, 0.33], []));
  shards.push(shard('Notes/faint-d.md', [0, 0, 0, 0, 0, 0.95, 0, 0.32], []));
  shards.push(shard('Notes/faint-e.md', [0, 0, 0, 0, 0, 0, 0.95, 0.315], []));
  // A seed whose only block points away from every live query: the shared
  // block pass and the backfill (threshold 0) both leave it without blocks.
  const contrary = near(CENTERS.alpha, 0.05);
  shards.push(
    shard('Notes/contrary.md', contrary, [
      { heading: 'Away', vector: [-1, -1.2, -0.3, -1, -0.3, -0.2, -0.4, 0] },
    ]),
  );
  // Seeded by `left` and `right` alike; each finds a different block of it at
  // exactly the same similarity, under the deep block threshold — the
  // backfill's tie across queries.
  shards.push(
    shard(
      'Notes/tied.md',
      [0, 0, 1, 0, 0, 0, 1, 0],
      [
        { heading: 'Left', vector: [0, 0, 0.3, 0, 0, 0, 0.1, 1] },
        { heading: 'Right', vector: [0, 0, 0.1, 0, 0, 0, 0.3, 1] },
      ],
    ),
  );
  // Below the size gate: a record, blocks, but no note vector.
  shards.push(shard('Notes/short.md', null, randomBlocks(CENTERS.alpha, 2)));
  return shards;
}

const FIXTURE = buildFixture();

function sourcesOf(shards: CorpusShard[]): Map<string, SmartSource> {
  const sources = new Map<string, SmartSource>();
  for (const s of shards) {
    if (s.embedding === null) continue;
    sources.set(s.path, {
      path: s.path,
      embedding: decodeVector(s.embedding),
      blocks: s.blocks.map((b) => ({
        key: b.key,
        heading: b.heading,
        lines: b.lines,
        embedding: decodeVector(b.embedding),
      })),
    });
  }
  return sources;
}

const SOURCES = sourcesOf(FIXTURE);

// Ten paths: every third note, one twin, a faint note, the short note, and a
// path the corpus has never seen.
const ALLOWED: string[] = [
  ...FIXTURE.filter((_, i) => i % 3 === 0 && i < 24)
    .slice(0, 6)
    .map((s) => s.path),
  'Notes/twin-b.md',
  'Notes/faint-a.md',
  'Notes/short.md',
  'Notes/missing.md',
];

const embeddingProvider: QueryEmbedder = {
  initialize: () => Promise.resolve(),
  embedQuery: (query) => Promise.resolve([...QUERY_VECTORS[query]]),
};

let root: string;
let shardCorpus: ShardCorpus;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nv-retrieval-parity-'));
  const store = new ShardStore(root, { modelKey: IDENTITY.model_key, dims: DIMS });
  await store.ensureManifest(IDENTITY);
  for (const s of FIXTURE) await store.writeShard(s);
  shardCorpus = new ShardCorpus(store, { yieldEvery: () => Promise.resolve() });
  await shardCorpus.load();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// The reader under test. Swapping the corpus implementation is one row here.
const READERS: Array<[label: string, make: () => ICorpusReader]> = [
  ['snapshotReader', () => snapshotReader(SOURCES)],
  ['ShardCorpus', () => shardCorpus],
];

const MODES: SearchMode[] = ['quick', 'deep'];
const ALLOWED_CASES: Array<[label: string, allowed: string[] | undefined]> = [
  ['no filter', undefined],
  ['10 allowed paths', ALLOWED],
];
const THRESHOLDS: Array<[label: string, threshold: number | undefined]> = [
  ['default threshold', undefined],
  ['explicit 0.9', 0.9],
];
const QUERY_SETS: Array<[label: string, queries: string[]]> = [
  ['1 query', ['alpha']],
  ['3 queries', ['alpha', 'beta', 'gamma']],
  ['a query with no hit above the default', ['dead']],
  ['a dead query among live ones', ['alpha', 'dead', 'beta']],
  ['2 queries tied on one seed', ['left', 'right']],
];

const cases = MODES.flatMap((mode) =>
  ALLOWED_CASES.flatMap(([allowedLabel, allowed]) =>
    THRESHOLDS.flatMap(([thresholdLabel, threshold]) =>
      QUERY_SETS.map(([queriesLabel, queries]) => ({
        name: `${mode}, ${allowedLabel}, ${thresholdLabel}, ${queriesLabel}`,
        mode,
        allowed,
        threshold,
        queries,
      })),
    ),
  ),
);

function legacyRun(c: (typeof cases)[number]): Promise<RetrievalOutput> {
  return legacyExecuteRetrieval({
    queries: c.queries,
    mode: c.mode,
    threshold: c.threshold,
    sources: c.allowed === undefined ? SOURCES : legacyNarrowSources(SOURCES, c.allowed),
    embeddingProvider,
    similarity: TEST_SIMILARITY,
  });
}

describe.each(READERS)('executeRetrieval over %s', (_label, makeReader) => {
  it.each(cases)('ranks as the in-memory leg did: $name', async (c) => {
    const actual = await executeRetrieval({
      queries: c.queries,
      mode: c.mode,
      threshold: c.threshold,
      corpus: makeReader(),
      ...(c.allowed !== undefined ? { allowed: c.allowed } : {}),
      embeddingProvider,
      similarity: TEST_SIMILARITY,
    });
    expect(actual).toEqual(await legacyRun(c));
  });
});

describe('the parity fixture exercises every step', () => {
  // Parity over outputs that never reach a step proves nothing about that
  // step, so pin that the matrix reaches each of them at least once.
  it('reaches fallback, truncation, ties, backfill and expansion', async () => {
    const outputs = await Promise.all(cases.map((c) => legacyRun(c)));
    const all = outputs.flatMap((o) => o.results);
    expect(outputs.some((o) => Object.values(o.per_query_fallback).includes(true))).toBe(true);
    expect(outputs.some((o) => o.truncated)).toBe(true);
    expect(outputs.some((o) => !o.truncated && o.results.length > 0)).toBe(true);
    expect(outputs.some((o) => o.results.length === 0)).toBe(true);
    expect(all.some((r) => r.related.length > 0)).toBe(true);
    expect(all.some((r) => r.blocks.length === 0)).toBe(true);
    expect(all.some((r) => r.path === 'Notes/contrary.md' && r.blocks.length === 0)).toBe(true);
    // The dead query alone overflows the quick pool on its fallback retry.
    expect(
      outputs.some(
        (o, i) => cases[i].queries.join() === 'dead' && cases[i].mode === 'quick' && o.truncated,
      ),
    ).toBe(true);
    expect(all.some((r) => r.matched_queries.length > 1)).toBe(true);
    // Both twins seeded together: the tie is decided by path, not by luck.
    expect(
      outputs.some((o) =>
        ['Notes/twin-a.md', 'Notes/twin-b.md'].every((p) => o.results.some((r) => r.path === p)),
      ),
    ).toBe(true);
    // A starved seed got a backfilled block: exactly one, in deep mode.
    const deepOutputs = outputs.filter((_, i) => cases[i].mode === 'deep');
    expect(deepOutputs.some((o) => o.results.some((r) => r.blocks.length === 1))).toBe(true);
  });
});

describe('one corpus call per step', () => {
  it('one nearest call carries every query vector', async () => {
    const reader = snapshotReader(SOURCES);
    const nearest = vi.spyOn(reader, 'nearest');
    const nearestBlocks = vi.spyOn(reader, 'nearestBlocks');

    await executeRetrieval({
      queries: ['alpha', 'beta', 'gamma'],
      mode: 'deep',
      corpus: reader,
      embeddingProvider,
      similarity: TEST_SIMILARITY,
    });

    const [seedAnchors, seedOpts] = nearest.mock.calls[0];
    expect(seedAnchors).toHaveLength(3);
    expect(seedAnchors.every((a) => 'vector' in a)).toBe(true);
    expect(seedOpts).toMatchObject({ threshold: TEST_SIMILARITY.deep, limit: 9 });
    // Seeds, then expansion: no fallback call, since every query found seeds.
    expect(nearest).toHaveBeenCalledTimes(2);
    expect(nearestBlocks.mock.calls[0][0]).toHaveLength(3);
  });
});
