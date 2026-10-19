import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { CorpusIdentity } from '../../../../src/lib/obsidian/corpus/identity.js';
import { modelCorpusDir } from '../../../../src/lib/obsidian/corpus/layout.js';
import {
  createShardCorpus,
  ShardCorpus,
} from '../../../../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import type { CorpusShard, SmartSource } from '../../../../src/lib/obsidian/corpus/types.js';
import { decodeVector, encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';
import { TEST_IDENTITY } from '../../../_identity.js';
import {
  legacyFindBlockNeighbors as findBlockNeighbors,
  legacyFindNeighbors as findNeighbors,
} from '../../../semantic/_legacy-retrieval.js';

const DIMS = 4;
const MODEL_KEY = TEST_IDENTITY.model_key;
const IDENTITY: CorpusIdentity = { ...TEST_IDENTITY, dims: DIMS };

const shard = (
  p: string,
  note: number[] | null,
  blocks: Array<{ key: string; vector: number[] }> = [],
): CorpusShard => ({
  path: p,
  content_hash: `hash-${p}`,
  mtime: 1000,
  size: 42,
  embedding: note === null ? null : encodeVector(note),
  blocks: blocks.map((b, i) => ({
    key: b.key,
    heading: b.key.replace('#', ''),
    lines: [i * 3 + 1, i * 3 + 3],
    embedding: encodeVector(b.vector),
  })),
});

const FIXTURE: CorpusShard[] = [
  shard(
    'a.md',
    [1, 0, 0, 0],
    [
      { key: '#One', vector: [1, 0, 0, 0] },
      { key: '#Two', vector: [0.9, 0.3, 0, 0] },
    ],
  ),
  shard('b.md', [0.9, 0.4, 0, 0], [{ key: '#One', vector: [0.8, 0.5, 0, 0] }]),
  shard('c.md', [0.5, 0.8, 0.2, 0], [{ key: '#One', vector: [0.4, 0.9, 0.1, 0] }]),
  shard('d.md', [0, 1, 0, 0], [{ key: '#One', vector: [0.1, 0.9, 0.3, 0] }]),
  shard('e.md', [0, 0, 1, 0], [{ key: '#One', vector: [0, 0.2, 1, 0] }]),
  // Below MIN_CHARS: no note vector, but it still has a record.
  shard('short.md', null, [{ key: '#Only', vector: [1, 0, 0, 0] }]),
];

const QUERY = [0.9, 0.3, 0.1, 0];

/** The fixture decoded as the in-memory scan read it: notes with a vector only. */
function sourcesOf(shards: CorpusShard[]): Map<string, SmartSource> {
  const sources = new Map<string, SmartSource>();
  for (const s of shards) {
    if (s.embedding === null) continue;
    sources.set(s.path, {
      path: s.path,
      embedding: decodeVector(s.embedding),
      blocks: s.blocks.map((b) => ({ ...b, embedding: decodeVector(b.embedding) })),
    });
  }
  return sources;
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nv-shard-corpus-'));
}

const makeStore = (root: string) => new ShardStore(root, { modelKey: MODEL_KEY, dims: DIMS });

async function setup(shards: CorpusShard[] = FIXTURE) {
  const root = await makeRoot();
  const store = makeStore(root);
  await store.ensureManifest(IDENTITY);
  for (const s of shards) await store.writeShard(s);
  const corpus = new ShardCorpus(store, { yieldEvery: () => Promise.resolve() });
  await corpus.load();
  return { root, store, corpus };
}

describe('ShardCorpus', () => {
  it('nearest matches findNeighbors for a query vector', async () => {
    const { corpus } = await setup();
    const sources = sourcesOf(FIXTURE);

    for (const threshold of [0, 0.3, 0.8]) {
      for (const limit of [undefined, 2]) {
        const [hits] = await corpus.nearest([{ vector: QUERY }], { threshold, limit });
        expect(hits).toEqual(
          findNeighbors({ queryVector: QUERY, sources: sources.values(), threshold, limit }),
        );
      }
    }
  });

  it('nearestBlocks matches findBlockNeighbors within paths', async () => {
    const { corpus } = await setup();
    const sources = sourcesOf(FIXTURE);
    const paths = ['a.md', 'c.md'];
    const subset = [...sources.values()].filter((s) => paths.includes(s.path));

    for (const threshold of [0, 0.3, 0.8]) {
      for (const limit of [undefined, 2]) {
        const [hits] = await corpus.nearestBlocks([{ vector: QUERY }], {
          paths,
          threshold,
          limit,
        });
        expect(hits).toEqual(
          findBlockNeighbors({ queryVector: QUERY, sources: subset, threshold, limit }),
        );
      }
    }
  });

  it('nearestBlocks ignores the blocks of a note with no note vector', async () => {
    const { corpus } = await setup();

    const [hits] = await corpus.nearestBlocks([{ vector: [1, 0, 0, 0] }], {
      paths: ['short.md', 'a.md'],
      threshold: 0,
    });

    expect(hits?.map((h) => h.path)).not.toContain('short.md');
    expect(hits?.length).toBe(2);
  });

  it('answers one list per anchor, in order', async () => {
    const { corpus } = await setup();

    const result = await corpus.nearest([{ vector: [1, 0, 0, 0] }, { vector: [0, 0, 1, 0] }], {
      threshold: 0.95,
    });

    expect(result.map((hits) => hits?.map((h) => h.path))).toEqual([['a.md'], ['e.md']]);
  });

  it('a path anchor uses the note own vector; a note without one is null', async () => {
    const { corpus } = await setup();

    const [byPath, short, missing] = await corpus.nearest(
      [{ path: 'a.md' }, { path: 'short.md' }, { path: 'nope.md' }],
      { threshold: 0.9, exclude: ['a.md'] },
    );
    const [byVector] = await corpus.nearest([{ vector: [1, 0, 0, 0] }], {
      threshold: 0.9,
      exclude: ['a.md'],
    });

    expect(byPath).toEqual(byVector);
    expect(short).toBeNull();
    expect(missing).toBeNull();
  });

  it('a path anchor does not exclude itself', async () => {
    const { corpus } = await setup();

    const [hits] = await corpus.nearest([{ path: 'a.md' }], { threshold: 0.99 });

    expect(hits?.map((h) => h.path)).toEqual(['a.md']);
  });

  it('allowed and exclude apply before limit', async () => {
    const { corpus } = await setup();

    const [allowed] = await corpus.nearest([{ vector: [1, 0, 0, 0] }], {
      threshold: 0,
      limit: 1,
      allowed: ['b.md', 'c.md'],
    });
    const [excluded] = await corpus.nearest([{ vector: [1, 0, 0, 0] }], {
      threshold: 0,
      limit: 1,
      exclude: ['a.md'],
    });

    expect(allowed?.map((h) => h.path)).toEqual(['b.md']);
    expect(excluded?.map((h) => h.path)).toEqual(['b.md']);
  });

  it('a dimension mismatch throws, as findNeighbors does', async () => {
    const { corpus } = await setup();

    await expect(corpus.nearest([{ vector: [1, 0] }], { threshold: 0 })).rejects.toThrow(
      /dimension mismatch/,
    );
  });

  it('yields between anchors', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    await store.writeShard(FIXTURE[0]);
    const yieldEvery = vi.fn(() => Promise.resolve());
    const corpus = new ShardCorpus(store, { yieldEvery });
    await corpus.load();
    yieldEvery.mockClear();

    await corpus.nearest([{ vector: QUERY }, { vector: QUERY }, { vector: QUERY }], {
      threshold: 0,
    });

    expect(yieldEvery).toHaveBeenCalledTimes(2);
  });

  it('every anchor of one read resolves against the corpus the read began on', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    await store.ensureManifest(IDENTITY);
    for (const s of FIXTURE) await store.writeShard(s);
    let between: () => Promise<void> = () => Promise.resolve();
    const corpus = new ShardCorpus(store, { yieldEvery: () => between() });
    await corpus.load();
    const anchors = [{ path: 'a.md' }, { path: 'a.md' }];
    const blockOpts = { paths: ['a.md', 'b.md'], threshold: 0 };

    const nearest = await corpus.nearest(anchors, { threshold: 0 });
    const blocks = await corpus.nearestBlocks(anchors, blockOpts);
    expect(nearest[0]).not.toBeNull();
    expect(nearest[1]).toEqual(nearest[0]);
    expect(blocks[1]).toEqual(blocks[0]);

    // Another holder removed the anchor note, and a refresh landed between two anchors.
    await makeStore(root).deleteShard('a.md');
    between = () => {
      between = () => Promise.resolve();
      return corpus.refresh();
    };
    expect(await corpus.nearest(anchors, { threshold: 0 })).toEqual(nearest);
    await store.writeShard(FIXTURE[0]);
    await corpus.load();
    await makeStore(root).deleteShard('a.md');
    between = () => {
      between = () => Promise.resolve();
      return corpus.refresh();
    };
    expect(await corpus.nearestBlocks(anchors, blockOpts)).toEqual(blocks);

    // A dispose between two anchors does not fail the read that already began.
    await corpus.load();
    const now = await corpus.nearest([{ path: 'b.md' }], { threshold: 0 });
    between = () => {
      corpus.dispose();
      return Promise.resolve();
    };
    expect(await corpus.nearest([{ path: 'b.md' }, { path: 'b.md' }], { threshold: 0 })).toEqual([
      now[0],
      now[0],
    ]);
  });

  it('reads before load throw', async () => {
    const root = await makeRoot();
    const corpus = new ShardCorpus(makeStore(root));

    expect(corpus.loaded).toBe(false);
    await expect(corpus.nearest([{ vector: QUERY }], { threshold: 0 })).rejects.toThrow(
      'corpus not loaded',
    );
    await expect(corpus.entries()).rejects.toThrow('corpus not loaded');
    expect(() => corpus.vectorOf('a.md')).toThrow('corpus not loaded');
  });

  it('upsert is visible to the next read and replaces the old vectors', async () => {
    const { store, corpus } = await setup();

    await corpus.upsert(shard('a.md', [0, 0, 0, 1], [{ key: '#New', vector: [0, 0, 0, 1] }]));

    const [hits] = await corpus.nearest([{ vector: [0, 0, 0, 1] }], { threshold: 0.9 });
    expect(hits?.map((h) => h.path)).toEqual(['a.md']);
    const [old] = await corpus.nearest([{ vector: [1, 0, 0, 0] }], {
      threshold: 0.9,
      allowed: ['a.md'],
    });
    expect(old).toEqual([]);
    const [blocks] = await corpus.nearestBlocks([{ vector: [1, 0, 0, 0] }], {
      paths: ['a.md'],
      threshold: 0.9,
    });
    expect(blocks).toEqual([]);
    expect(Array.from(corpus.vectorOf('a.md') ?? [])).toEqual([0, 0, 0, 1]);
    expect((await store.readShard('a.md'))?.blocks[0].key).toBe('#New');
  });

  it('upsert of a note below the size gate drops its vector', async () => {
    const { corpus } = await setup();

    await corpus.upsert(shard('a.md', null));

    expect(corpus.vectorOf('a.md')).toBeNull();
    expect(corpus.size()).toBe(4);
    expect((await corpus.entries()).has('a.md')).toBe(true);
  });

  it('a failed store write leaves memory unchanged', async () => {
    const { store, corpus } = await setup();
    vi.spyOn(store, 'writeShard').mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(store, 'deleteShard').mockRejectedValueOnce(new Error('disk full'));

    await expect(corpus.upsert(shard('a.md', [0, 0, 0, 1]))).rejects.toThrow('disk full');
    await expect(corpus.delete('b.md')).rejects.toThrow('disk full');

    expect(Array.from(corpus.vectorOf('a.md') ?? [])).toEqual([1, 0, 0, 0]);
    expect(corpus.vectorOf('b.md')).not.toBeNull();
  });

  it('delete removes the note from reads and entries', async () => {
    const { store, corpus } = await setup();

    await corpus.delete('a.md');

    const [hits] = await corpus.nearest([{ vector: [1, 0, 0, 0] }], { threshold: 0 });
    expect(hits?.map((h) => h.path)).not.toContain('a.md');
    expect((await corpus.entries()).has('a.md')).toBe(false);
    expect(corpus.vectorOf('a.md')).toBeNull();
    expect(await store.readShard('a.md')).toBeNull();
  });

  it('touch rewrites mtime and size in the store and in entries, keeping vectors', async () => {
    const { store, corpus } = await setup();

    expect(await corpus.touch('a.md', { mtime: 5, size: 9 })).toBe(true);
    expect(await corpus.touch('nope.md', { mtime: 5, size: 9 })).toBe(false);

    expect((await corpus.entries()).get('a.md')).toEqual({
      content_hash: 'hash-a.md',
      mtime: 5,
      size: 9,
    });
    expect(await store.readShard('a.md')).toEqual({ ...FIXTURE[0], mtime: 5, size: 9 });
    expect(Array.from(corpus.vectorOf('a.md') ?? [])).toEqual([1, 0, 0, 0]);
  });

  it('entries includes notes without a vector', async () => {
    const { corpus } = await setup();

    const entries = await corpus.entries();

    expect([...entries.keys()].sort()).toEqual(FIXTURE.map((s) => s.path).sort());
    expect(entries.get('short.md')).toEqual({
      content_hash: 'hash-short.md',
      mtime: 1000,
      size: 42,
    });
    expect(corpus.vectorOf('short.md')).toBeNull();
    expect(corpus.size()).toBe(5);
  });

  it('identity reads the stored manifest', async () => {
    const { corpus } = await setup();

    expect((await corpus.identity())?.model_id).toBe(IDENTITY.model_id);
  });

  it('ensureIdentity with another identity empties memory', async () => {
    const { store, corpus } = await setup();

    const result = await corpus.ensureIdentity({ ...IDENTITY, model_id: 'another/model' });

    expect(result.rebuilt).toBe(true);
    expect(corpus.loaded).toBe(true);
    expect(corpus.size()).toBe(0);
    expect(await corpus.entries()).toEqual(new Map());
    expect(await store.listShards()).toEqual(new Map());
  });

  it('ensureIdentity with the same identity keeps memory', async () => {
    const { corpus } = await setup();

    const result = await corpus.ensureIdentity(IDENTITY);

    expect(result.rebuilt).toBe(false);
    expect(corpus.size()).toBe(5);
  });

  it('refresh re-reads shards written by another ShardStore', async () => {
    const { root, corpus } = await setup();
    const other = makeStore(root);
    await other.writeShard(shard('f.md', [0, 0, 0, 1]));
    await other.deleteShard('a.md');

    await corpus.refresh();

    expect(Array.from(corpus.vectorOf('f.md') ?? [])).toEqual([0, 0, 0, 1]);
    expect(corpus.vectorOf('a.md')).toBeNull();
    expect((await corpus.entries()).has('a.md')).toBe(false);
  });

  it('ensureIdentity over a pruned model directory writes memory back, re-embedding nothing', async () => {
    const { root, store, corpus } = await setup();
    const before = await store.listShards();
    await rm(modelCorpusDir(root, MODEL_KEY), { recursive: true, force: true });

    const result = await corpus.ensureIdentity(IDENTITY);

    expect(result).toEqual({ rebuilt: false, previous: null });
    expect((await store.readManifest())?.model_id).toBe(IDENTITY.model_id);
    // The encoded strings compare equal, so every vector decodes to the same floats.
    expect(await store.listShards()).toEqual(before);
    expect(corpus.size()).toBe(5);
  });

  it('refresh over a pruned model directory keeps serving from memory', async () => {
    const { root, corpus } = await setup();
    const [before] = await corpus.nearest([{ vector: QUERY }], { threshold: 0 });
    await rm(modelCorpusDir(root, MODEL_KEY), { recursive: true, force: true });

    await corpus.refresh();

    expect(corpus.size()).toBe(5);
    expect((await corpus.entries()).size).toBe(FIXTURE.length);
    expect(await corpus.nearest([{ vector: QUERY }], { threshold: 0 })).toEqual([before]);
  });

  it('an unparsable manifest over shards still rebuilds', async () => {
    const { root, store, corpus } = await setup();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(path.join(modelCorpusDir(root, MODEL_KEY), 'manifest.json'), '{not json');

    await corpus.refresh();
    const result = await corpus.ensureIdentity(IDENTITY);

    expect(result).toEqual({ rebuilt: true, previous: null });
    expect(corpus.size()).toBe(0);
    expect(await store.listShards()).toEqual(new Map());
    warn.mockRestore();
  });

  it('dispose drops memory', async () => {
    const { corpus } = await setup();

    corpus.dispose();

    expect(corpus.loaded).toBe(false);
    await expect(corpus.entries()).rejects.toThrow('corpus not loaded');
  });

  it('ensureIdentity adds the corpus directory to the vault gitignore once', async () => {
    const { root, corpus } = await setup();
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');

    await corpus.ensureIdentity(IDENTITY);
    await corpus.ensureIdentity(IDENTITY);

    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.neuro-vault/corpus/\n',
    );
  });

  it('ensureIdentity creates no gitignore the vault does not have', async () => {
    const { root, corpus } = await setup();

    await corpus.ensureIdentity(IDENTITY);

    await expect(access(path.join(root, '.gitignore'))).rejects.toThrow();
  });
});

describe('createShardCorpus', () => {
  it("keeps the profile's records in its own model directory", async () => {
    const root = await makeRoot();
    const corpus = createShardCorpus(root, { key: MODEL_KEY, identity: IDENTITY });

    await corpus.ensureIdentity(IDENTITY);
    await corpus.load();
    await corpus.upsert(FIXTURE[0]);

    const store = makeStore(root);
    expect((await store.readManifest())?.model_key).toBe(MODEL_KEY);
    expect(await store.readShard('a.md')).toEqual(FIXTURE[0]);
    expect(corpus.size()).toBe(1);
    await rm(root, { recursive: true, force: true });
  });
});
