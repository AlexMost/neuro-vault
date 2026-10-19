import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ICorpus } from '../../../../src/lib/obsidian/corpus/corpus.js';
import {
  identityMatches,
  type CorpusIdentity,
} from '../../../../src/lib/obsidian/corpus/identity.js';
import { createShardCorpus } from '../../../../src/lib/obsidian/corpus/shard-corpus.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';
import { TEST_IDENTITY } from '../../../_identity.js';
import { MemoryCorpus } from '../../../_memory-corpus.js';

// What the vault entry and the reconcile loop rely on from any ICorpus, held
// against the shard corpus and the in-memory double alike: the double is only
// proof of an honest seam while it behaves as production does.

const IDENTITY: CorpusIdentity = { ...TEST_IDENTITY, dims: 4 };
const OTHER: CorpusIdentity = { ...IDENTITY, model_id: 'another/model' };

const record = (p: string, note: number[] | null, block?: number[]): CorpusShard => ({
  path: p,
  content_hash: `hash-${p}`,
  mtime: 1000,
  size: 42,
  embedding: note === null ? null : encodeVector(note),
  blocks:
    block === undefined
      ? []
      : [{ key: '#One', heading: 'One', lines: [1, 3], embedding: encodeVector(block) }],
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const implementations: Array<[string, () => Promise<ICorpus>]> = [
  [
    'ShardCorpus',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'nv-corpus-contract-'));
      roots.push(root);
      return createShardCorpus(root, { key: IDENTITY.model_key, identity: IDENTITY });
    },
  ],
  ['MemoryCorpus', () => Promise.resolve(new MemoryCorpus())],
];

/** A corpus carrying IDENTITY, loaded, holding `records`. */
async function opened(make: () => Promise<ICorpus>, records: CorpusShard[] = []) {
  const corpus = await make();
  await corpus.ensureIdentity(IDENTITY);
  await corpus.load();
  for (const r of records) await corpus.upsert(r);
  return corpus;
}

describe.each(implementations)('%s as an ICorpus', (_name, make) => {
  it('a fresh corpus records the identity without a rebuild', async () => {
    const corpus = await make();
    expect(await corpus.identity()).toBeNull();
    expect(await corpus.ensureIdentity(IDENTITY)).toEqual({ rebuilt: false, previous: null });
    expect(identityMatches(await corpus.identity(), IDENTITY)).toBe(true);
  });

  it('the same identity keeps the records', async () => {
    const corpus = await opened(make, [record('a.md', [1, 0, 0, 0])]);
    const { rebuilt, previous } = await corpus.ensureIdentity(IDENTITY);
    expect(rebuilt).toBe(false);
    expect(identityMatches(previous, IDENTITY)).toBe(true);
    expect(corpus.size()).toBe(1);
  });

  it('another identity discards the records and names what it replaced', async () => {
    const corpus = await opened(make, [record('a.md', [1, 0, 0, 0])]);
    const { rebuilt, previous } = await corpus.ensureIdentity(OTHER);
    expect(rebuilt).toBe(true);
    expect(previous?.model_id).toBe(IDENTITY.model_id);
    expect(identityMatches(await corpus.identity(), OTHER)).toBe(true);
    expect(await corpus.entries()).toEqual(new Map());
    expect(corpus.size()).toBe(0);
  });

  it('another identity over no records is not a rebuild', async () => {
    const corpus = await opened(make);
    expect((await corpus.ensureIdentity(OTHER)).rebuilt).toBe(false);
  });

  it('upsert, touch and delete show in entries at once', async () => {
    const corpus = await opened(make, [record('a.md', [1, 0, 0, 0]), record('b.md', null)]);
    expect(await corpus.touch('a.md', { mtime: 5, size: 9 })).toBe(true);
    expect(await corpus.touch('missing.md', { mtime: 5, size: 9 })).toBe(false);
    await corpus.delete('b.md');
    expect(await corpus.entries()).toEqual(
      new Map([['a.md', { content_hash: 'hash-a.md', mtime: 5, size: 9 }]]),
    );
    expect(Array.from(corpus.vectorOf('a.md') ?? [])).toEqual([1, 0, 0, 0]);
  });

  it('size counts the notes that carry a vector', async () => {
    const corpus = await opened(make, [record('a.md', [1, 0, 0, 0]), record('short.md', null)]);
    expect(corpus.size()).toBe(1);
    expect((await corpus.entries()).size).toBe(2);
  });

  it('nearest ranks by similarity, applying allowed and exclude before limit', async () => {
    const corpus = await opened(make, [
      record('a.md', [1, 0, 0, 0]),
      record('b.md', [0.9, 0.4, 0, 0]),
      record('c.md', [0, 1, 0, 0]),
      record('short.md', null),
    ]);
    const query = { vector: [1, 0, 0, 0] };
    const paths = async (opts: Parameters<ICorpus['nearest']>[1]) =>
      ((await corpus.nearest([query], opts))[0] ?? []).map((hit) => hit.path);

    expect(await paths({ threshold: -1 })).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await paths({ threshold: 0.5 })).toEqual(['a.md', 'b.md']);
    expect(await paths({ threshold: -1, limit: 1, exclude: ['a.md'] })).toEqual(['b.md']);
    expect(await paths({ threshold: -1, limit: 1, allowed: ['c.md'] })).toEqual(['c.md']);
    const anchored = await corpus.nearest([{ path: 'short.md' }, { path: 'a.md' }], {
      threshold: 0.99,
    });
    expect(anchored[0]).toBeNull();
    expect(anchored[1]?.map((hit) => hit.path)).toEqual(['a.md']);
  });

  it('nearestBlocks reads blocks of the given notes that carry a note vector', async () => {
    const corpus = await opened(make, [
      record('a.md', [1, 0, 0, 0], [1, 0, 0, 0]),
      record('b.md', [0, 1, 0, 0], [0.9, 0.4, 0, 0]),
      record('short.md', null, [1, 0, 0, 0]),
    ]);
    const [hits] = await corpus.nearestBlocks([{ vector: [1, 0, 0, 0] }], {
      paths: ['a.md', 'b.md', 'short.md'],
      threshold: -1,
    });
    expect(hits?.map((hit) => [hit.path, hit.heading, hit.lines])).toEqual([
      ['a.md', 'One', [1, 3]],
      ['b.md', 'One', [1, 3]],
    ]);
  });

  it('dispose unloads; the records stay for the next load', async () => {
    const corpus = await opened(make, [record('a.md', [1, 0, 0, 0])]);
    corpus.dispose();
    expect(corpus.loaded).toBe(false);
    await corpus.load();
    expect(corpus.size()).toBe(1);
  });
});
