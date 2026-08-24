import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CorpusStore,
  ensureCorpusGitignored,
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
    // Written past writeShard's own guard, as a corrupted file on disk would be.
    const file = path.join(root, '.neuro-vault/corpus/notes', CorpusStore.shardFileName('N.md'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...shard('N.md'), embedding: wrongSize }));
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('refuses to write a shard whose note vector has the wrong dimension', async () => {
    const store = new CorpusStore(await tempVault());
    const wrongSize = Buffer.alloc(4 * 8).toString('base64');
    await expect(store.writeShard({ ...shard('N.md'), embedding: wrongSize })).rejects.toThrow(
      /note vector is 8 dims, expected 384/,
    );
    expect(await store.readShard('N.md')).toBeNull();
  });

  it('refuses to write a shard whose block vector has the wrong dimension', async () => {
    const store = new CorpusStore(await tempVault());
    const wrongSize = Buffer.alloc(4 * 8).toString('base64');
    const bad = shard('N.md');
    await expect(
      store.writeShard({ ...bad, blocks: [{ ...bad.blocks[0], embedding: wrongSize }] }),
    ).rejects.toThrow(/vector for block "#Top" is 8 dims, expected 384/);
  });

  it('writes a shard with no note vector (a note below the size gate)', async () => {
    const store = new CorpusStore(await tempVault());
    await store.writeShard({ ...shard('N.md'), embedding: null });
    expect((await store.readShard('N.md'))?.embedding).toBeNull();
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

  it('writes a manifest on a fresh corpus so the next pass has one to compare', async () => {
    const store = new CorpusStore(await tempVault());
    const result = await store.ensureManifest(expected);
    expect(result.rebuilt).toBe(false);
    expect(await store.readManifest()).toMatchObject(expected);
  });

  it('does not discard the first index written after a fresh ensureManifest', async () => {
    const store = new CorpusStore(await tempVault());
    await store.ensureManifest(expected);
    await store.writeShard(shard('N.md'));
    const second = await store.ensureManifest(expected);
    expect(second.rebuilt).toBe(false);
    expect([...(await store.listShards()).keys()]).toEqual(['N.md']);
  });

  it('lists shards concurrently, in a stable order', async () => {
    const root = await tempVault();
    const store = new CorpusStore(root);
    for (const p of ['C.md', 'A.md', 'B.md']) await store.writeShard(shard(p));
    let inFlight = 0;
    let peak = 0;
    const traced = new CorpusStore(root, {
      readFile: async (p) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return readFile(p, 'utf8');
      },
    });
    expect(new Set((await traced.listShards()).keys())).toEqual(new Set(['A.md', 'B.md', 'C.md']));
    expect(peak).toBeGreaterThan(1);
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

describe('ensureCorpusGitignored', () => {
  it('appends one entry, preserving existing lines', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), '.smart-env/\nnode_modules\n');
    await ensureCorpusGitignored(root);
    const after = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(after).toContain('.smart-env/');
    expect(after).toContain('node_modules');
    expect(after.match(/\.neuro-vault\/corpus\//g)).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), 'x\n');
    await ensureCorpusGitignored(root);
    await ensureCorpusGitignored(root);
    const after = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(after.match(/\.neuro-vault\/corpus\//g)).toHaveLength(1);
  });

  it('does not create a gitignore that does not exist', async () => {
    const root = await tempVault();
    await ensureCorpusGitignored(root);
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('warns on stderr and never throws when the file cannot be written', async () => {
    const warn = vi.fn();
    await expect(
      ensureCorpusGitignored(await tempVault(), {
        readFile: async () => 'x\n',
        writeFile: async () => {
          throw new Error('EACCES');
        },
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a gitignore that already covers the corpus untouched', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), '.neuro-vault/corpus/\n');
    await ensureCorpusGitignored(root);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe('.neuro-vault/corpus/\n');
  });
});
