import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CorpusStore,
  isManifestCompatible,
} from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_DIMS } from '../../../../src/lib/obsidian/corpus/types.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';

/** A dims-sized placeholder vector: MODEL_DIMS float32 values, all zero. */
const placeholderVector = Buffer.alloc(MODEL_DIMS * 4).toString('base64');

const shard = (p: string): CorpusShard => ({
  path: p,
  content_hash: 'abc123',
  mtime: 1000,
  size: 42,
  embedding: placeholderVector,
  blocks: [{ key: '#Top', heading: 'Top', lines: [1, 2], embedding: placeholderVector }],
});

async function tempVault() {
  return mkdtemp(path.join(tmpdir(), 'nv-corpus-'));
}

const expected = {
  embed_version: 1,
  model_key: 'bge-micro-v2',
  dims: 384,
  strategy: 'sc-parity-v1',
};
const stored = { ...expected, created: '2026-08-24T00:00:00.000Z' };

describe('CorpusStore', () => {
  it('round-trips a shard', async () => {
    const store = new CorpusStore(await tempVault());
    await store.writeShard(shard('Folder/Note.md'));
    expect(await store.readShard('Folder/Note.md')).toEqual(shard('Folder/Note.md'));
  });

  it('gives colliding-slug paths distinct files', () => {
    expect(CorpusStore.shardFileName('A/b.md')).not.toBe(CorpusStore.shardFileName('A_b.md'));
  });

  it('keeps each vault corpus under its own root', async () => {
    const first = new CorpusStore(await tempVault());
    const second = new CorpusStore(await tempVault());
    await first.writeShard(shard('N.md'));
    expect(await second.readShard('N.md')).toBeNull();
    expect(await second.listShards()).toEqual(new Map());
  });

  it('reads a malformed shard as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new CorpusStore(root, { warn: (m) => warnings.push(m) });
    const file = path.join(root, '.neuro-vault/corpus/notes', CorpusStore.shardFileName('N.md'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('reads a shard whose path does not match its filename as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new CorpusStore(root, { warn: (m) => warnings.push(m) });
    const file = path.join(root, '.neuro-vault/corpus/notes', CorpusStore.shardFileName('N.md'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(shard('Other.md')));
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('reads a shard whose vector has the wrong dimension as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new CorpusStore(root, { warn: (m) => warnings.push(m) });
    const wrongSize = Buffer.alloc(4 * 8).toString('base64'); // 8 floats, not MODEL_DIMS
    await store.writeShard({ ...shard('N.md'), embedding: wrongSize });
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('skips unreadable shards when listing', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new CorpusStore(root, { warn: (m) => warnings.push(m) });
    await store.writeShard(shard('Good.md'));
    const bad = path.join(root, '.neuro-vault/corpus/notes', 'deadbeef.json');
    await writeFile(bad, 'nope');
    const listed = await store.listShards();
    expect([...listed.keys()]).toEqual(['Good.md']);
    expect(warnings).toHaveLength(1);
  });

  it('lists an empty map when the corpus directory does not exist', async () => {
    expect(await new CorpusStore(await tempVault()).listShards()).toEqual(new Map());
  });

  it('writes through the atomic writer, never a partial file', async () => {
    const calls: string[] = [];
    const store = new CorpusStore(await tempVault(), {
      writeFile: async (p) => {
        calls.push(p);
      },
      mkdir: async () => {},
    });
    await store.writeShard(shard('N.md'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(CorpusStore.shardFileName('N.md'));
  });

  it('deletes a shard and tolerates a missing one', async () => {
    const store = new CorpusStore(await tempVault());
    await store.writeShard(shard('N.md'));
    await store.deleteShard('N.md');
    expect(await store.readShard('N.md')).toBeNull();
    await expect(store.deleteShard('N.md')).resolves.toBeUndefined();
  });

  it('writes the manifest only when its values change', async () => {
    const writes: string[] = [];
    const store = new CorpusStore(await tempVault(), {
      writeFile: async (p) => {
        writes.push(p);
      },
      mkdir: async () => {},
      readFile: async () => JSON.stringify(stored),
    });
    await store.ensureManifest(expected);
    expect(writes).toHaveLength(0);
  });

  it('clears every shard when the manifest is incompatible', async () => {
    const root = await tempVault();
    const store = new CorpusStore(root);
    await store.writeShard(shard('N.md'));
    await store.writeManifest({ ...stored, model_key: 'other-model' });
    const result = await store.ensureManifest(expected);
    expect(result.rebuilt).toBe(true);
    expect(await store.listShards()).toEqual(new Map());
    expect((await store.readManifest())?.model_key).toBe('bge-micro-v2');
  });
});

describe('isManifestCompatible', () => {
  it('accepts an identical manifest', () => {
    expect(isManifestCompatible(stored, expected, true)).toBe(true);
  });

  it.each(['embed_version', 'model_key', 'dims', 'strategy'] as const)(
    'rejects a manifest differing in %s',
    (field) => {
      const changed = {
        ...stored,
        [field]: field === 'dims' || field === 'embed_version' ? 999 : 'other',
      };
      expect(isManifestCompatible(changed, expected, true)).toBe(false);
    },
  );

  it('rejects a missing manifest when shards exist', () => {
    expect(isManifestCompatible(null, expected, true)).toBe(false);
  });

  it('accepts a missing manifest on an empty corpus', () => {
    expect(isManifestCompatible(null, expected, false)).toBe(true);
  });
});
