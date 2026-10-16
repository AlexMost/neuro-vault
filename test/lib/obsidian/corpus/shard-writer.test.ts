import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ShardStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { shardWriter } from '../../../../src/lib/obsidian/corpus/shard-writer.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';
import { TEST_DIMS, TEST_IDENTITY } from '../../../_identity.js';

/** A dims-sized placeholder vector: TEST_DIMS float32 values, all zero. */
const placeholderVector = Buffer.alloc(TEST_DIMS * 4).toString('base64');

const shard = (p: string, content_hash = 'abc123'): CorpusShard => ({
  path: p,
  content_hash,
  mtime: 1000,
  size: 42,
  embedding: placeholderVector,
  blocks: [{ key: '#Top', heading: 'Top', lines: [1, 2], embedding: placeholderVector }],
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-shard-writer-'));
  const store = new ShardStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
  return { store, writer: shardWriter(store) };
}

describe('shardWriter', () => {
  it('entries returns metadata of every shard and no vectors', async () => {
    const { store, writer } = await setup();
    await store.writeShard(shard('A.md', 'hash-a'));
    await store.writeShard(shard('B.md', 'hash-b'));

    const entries = await writer.entries();

    expect(entries).toEqual(
      new Map([
        ['A.md', { content_hash: 'hash-a', mtime: 1000, size: 42 }],
        ['B.md', { content_hash: 'hash-b', mtime: 1000, size: 42 }],
      ]),
    );
    for (const entry of entries.values()) {
      expect(Object.keys(entry).sort()).toEqual(['content_hash', 'mtime', 'size']);
    }
  });

  it('touch rewrites mtime and size and keeps the vectors', async () => {
    const { store, writer } = await setup();
    await store.writeShard(shard('A.md'));

    expect(await writer.touch('A.md', { mtime: 5, size: 9 })).toBe(true);

    expect(await store.readShard('A.md')).toEqual({ ...shard('A.md'), mtime: 5, size: 9 });
  });

  it('touch on a missing record returns false and writes nothing', async () => {
    const { store, writer } = await setup();
    const write = vi.spyOn(store, 'writeShard');

    expect(await writer.touch('Missing.md', { mtime: 5, size: 9 })).toBe(false);

    expect(write).not.toHaveBeenCalled();
    expect(await store.listShards()).toEqual(new Map());
  });

  it('upsert and delete write through to the store', async () => {
    const { store, writer } = await setup();
    await writer.upsert(shard('A.md'));
    expect(await store.readShard('A.md')).toEqual(shard('A.md'));

    await writer.delete('A.md');
    expect(await store.readShard('A.md')).toBeNull();
  });

  it('ensureIdentity discards shards of another identity', async () => {
    const { store, writer } = await setup();
    await store.writeManifest({
      ...TEST_IDENTITY,
      model_id: 'another/model',
      created: '2026-08-24T00:00:00.000Z',
    });
    await store.writeShard(shard('A.md'));

    const result = await writer.ensureIdentity(TEST_IDENTITY);

    expect(result.rebuilt).toBe(true);
    expect(result.previous?.model_id).toBe('another/model');
    expect(await writer.entries()).toEqual(new Map());
    expect((await writer.identity())?.model_id).toBe(TEST_IDENTITY.model_id);
  });

  it('refresh is a no-op', async () => {
    const { store, writer } = await setup();
    await store.writeShard(shard('A.md'));

    await expect(writer.refresh()).resolves.toBeUndefined();

    expect((await store.listShards()).size).toBe(1);
  });
});
