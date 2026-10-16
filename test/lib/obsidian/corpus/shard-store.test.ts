import { mkdtemp, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  ShardStore,
  ensureCorpusGitignored,
  isManifestCompatible,
} from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { TEST_DIMS, TEST_IDENTITY } from '../../../_identity.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';

/** A dims-sized placeholder vector: TEST_DIMS float32 values, all zero. */
const placeholderVector = Buffer.alloc(TEST_DIMS * 4).toString('base64');

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

const expected = TEST_IDENTITY;
const stored = { ...expected, created: '2026-08-24T00:00:00.000Z' };

describe('ShardStore', () => {
  it('round-trips a shard', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.writeShard(shard('Folder/Note.md'));
    expect(await store.readShard('Folder/Note.md')).toEqual(shard('Folder/Note.md'));
  });

  it('gives colliding-slug paths distinct files', () => {
    expect(ShardStore.shardFileName('A/b.md')).not.toBe(ShardStore.shardFileName('A_b.md'));
  });

  it('keeps each vault corpus under its own root', async () => {
    const first = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    const second = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await first.writeShard(shard('N.md'));
    expect(await second.readShard('N.md')).toBeNull();
    expect(await second.listShards()).toEqual(new Map());
  });

  it('reads a malformed shard as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      warn: (m) => warnings.push(m),
    });
    const file = path.join(
      root,
      '.neuro-vault/corpus/bge-micro-v2/notes',
      ShardStore.shardFileName('N.md'),
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('reads a shard whose path does not match its filename as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      warn: (m) => warnings.push(m),
    });
    const file = path.join(
      root,
      '.neuro-vault/corpus/bge-micro-v2/notes',
      ShardStore.shardFileName('N.md'),
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(shard('Other.md')));
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('reads a shard whose vector has the wrong dimension as absent', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      warn: (m) => warnings.push(m),
    });
    const wrongSize = Buffer.alloc(4 * 8).toString('base64'); // 8 floats, not TEST_DIMS
    // Written past writeShard's own guard, as a corrupted file on disk would be.
    const file = path.join(
      root,
      '.neuro-vault/corpus/bge-micro-v2/notes',
      ShardStore.shardFileName('N.md'),
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...shard('N.md'), embedding: wrongSize }));
    expect(await store.readShard('N.md')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('refuses to write a shard whose note vector has the wrong dimension', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    const wrongSize = Buffer.alloc(4 * 8).toString('base64');
    await expect(store.writeShard({ ...shard('N.md'), embedding: wrongSize })).rejects.toThrow(
      /note vector is 8 dims, expected 384/,
    );
    expect(await store.readShard('N.md')).toBeNull();
  });

  it('refuses to write a shard whose block vector has the wrong dimension', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    const wrongSize = Buffer.alloc(4 * 8).toString('base64');
    const bad = shard('N.md');
    await expect(
      store.writeShard({ ...bad, blocks: [{ ...bad.blocks[0], embedding: wrongSize }] }),
    ).rejects.toThrow(/vector for block "#Top" is 8 dims, expected 384/);
  });

  it('writes a shard with no note vector (a note below the size gate)', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.writeShard({ ...shard('N.md'), embedding: null });
    expect((await store.readShard('N.md'))?.embedding).toBeNull();
  });

  it('skips unreadable shards when listing', async () => {
    const root = await tempVault();
    const warnings: string[] = [];
    const store = new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      warn: (m) => warnings.push(m),
    });
    await store.writeShard(shard('Good.md'));
    const bad = path.join(root, '.neuro-vault/corpus/bge-micro-v2/notes', 'deadbeef.json');
    await writeFile(bad, 'nope');
    const listed = await store.listShards();
    expect([...listed.keys()]).toEqual(['Good.md']);
    expect(warnings).toHaveLength(1);
  });

  it('lists an empty map when the corpus directory does not exist', async () => {
    expect(
      await new ShardStore(await tempVault(), {
        modelKey: TEST_IDENTITY.model_key,
        dims: TEST_DIMS,
      }).listShards(),
    ).toEqual(new Map());
  });

  it('writes through the atomic writer, never a partial file', async () => {
    const calls: string[] = [];
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      writeFile: async (p) => {
        calls.push(p);
      },
      mkdir: async () => {},
    });
    await store.writeShard(shard('N.md'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(ShardStore.shardFileName('N.md'));
  });

  it('deletes a shard and tolerates a missing one', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.writeShard(shard('N.md'));
    await store.deleteShard('N.md');
    expect(await store.readShard('N.md')).toBeNull();
    await expect(store.deleteShard('N.md')).resolves.toBeUndefined();
  });

  it('writes the manifest only when its values change', async () => {
    const writes: string[] = [];
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
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
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    const result = await store.ensureManifest(expected);
    expect(result.rebuilt).toBe(false);
    expect(await store.readManifest()).toMatchObject(expected);
  });

  it('does not discard the first index written after a fresh ensureManifest', async () => {
    const store = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.ensureManifest(expected);
    await store.writeShard(shard('N.md'));
    const second = await store.ensureManifest(expected);
    expect(second.rebuilt).toBe(false);
    expect([...(await store.listShards()).keys()]).toEqual(['N.md']);
  });

  it('reads shards concurrently, in a stable order', async () => {
    const root = await tempVault();
    const store = new ShardStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
    for (const p of ['C.md', 'A.md', 'B.md']) await store.writeShard(shard(p));
    const entries = await readdir(path.join(root, '.neuro-vault/corpus/bge-micro-v2/notes'));
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const traced = new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
      // Reversed, so a stable read order can only come from listShards sorting.
      readdir: async () => [...entries].sort().reverse(),
      readFile: async (p) => {
        started.push(path.basename(p));
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return readFile(p, 'utf8');
      },
    });
    expect(new Set((await traced.listShards()).keys())).toEqual(new Set(['A.md', 'B.md', 'C.md']));
    expect(peak).toBeGreaterThan(1);
    expect(started).toEqual([...entries].sort());
  });

  it('returns the manifest it found: compatible, incompatible with shards, incompatible without', async () => {
    const compatibleRoot = await tempVault();
    const compatible = new ShardStore(compatibleRoot, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await compatible.writeShard(shard('N.md'));
    await compatible.writeManifest(stored);
    expect(await compatible.ensureManifest(expected)).toEqual({
      rebuilt: false,
      previous: stored,
    });

    const withShards = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    const other = { ...stored, model_key: 'other-model' };
    await withShards.writeShard(shard('N.md'));
    await withShards.writeManifest(other);
    expect(await withShards.ensureManifest(expected)).toEqual({ rebuilt: true, previous: other });

    const noShards = new ShardStore(await tempVault(), {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await noShards.writeManifest(other);
    expect(await noShards.ensureManifest(expected)).toEqual({ rebuilt: false, previous: other });
    expect((await noShards.readManifest())?.model_key).toBe('bge-micro-v2');
  });

  it('clears every shard when the manifest is incompatible', async () => {
    const root = await tempVault();
    const store = new ShardStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
    await store.writeShard(shard('N.md'));
    await store.writeManifest({ ...stored, model_key: 'other-model' });
    const result = await store.ensureManifest(expected);
    expect(result.rebuilt).toBe(true);
    expect(await store.listShards()).toEqual(new Map());
    expect((await store.readManifest())?.model_key).toBe('bge-micro-v2');
  });
});

describe('ShardStore dimension guard', () => {
  it('a store built for 640 dims refuses a 384-dim vector', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-store-dims-'));
    const store = new ShardStore(root, { modelKey: TEST_IDENTITY.model_key, dims: 640 });
    await expect(
      store.writeShard({
        path: 'A.md',
        content_hash: 'h',
        mtime: 1,
        size: 1,
        embedding: Buffer.alloc(384 * 4).toString('base64'),
        blocks: [],
      }),
    ).rejects.toThrow(/expected 640 dims/);
  });
});

describe('isManifestCompatible', () => {
  it('accepts an identical manifest', () => {
    expect(isManifestCompatible(stored, expected, true)).toBe(true);
  });

  it('rejects a missing manifest when shards exist', () => {
    expect(isManifestCompatible(null, expected, true)).toBe(false);
  });

  it('accepts a missing manifest on an empty corpus', () => {
    expect(isManifestCompatible(null, expected, false)).toBe(true);
  });
});

describe('manifest identity v2', () => {
  it.each([
    'embed_version',
    'provider',
    'model_key',
    'model_id',
    'revision',
    'dtype',
    'dims',
    'pooling',
    'max_tokens',
    'strategy',
  ] as const)('a stored %s that differs is incompatible', (field) => {
    const changed = {
      ...TEST_IDENTITY,
      created: 'x',
      [field]: typeof TEST_IDENTITY[field] === 'number' ? 1234 : 'different',
    };
    expect(isManifestCompatible(changed, TEST_IDENTITY, true)).toBe(false);
  });

  it('a matching manifest is compatible regardless of created', () => {
    expect(isManifestCompatible({ ...TEST_IDENTITY, created: 'any' }, TEST_IDENTITY, true)).toBe(
      true,
    );
  });

  it('reads a legacy embed_version 1 manifest instead of rejecting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-legacy-'));
    await mkdir(path.join(root, '.neuro-vault/corpus/bge-micro-v2'), { recursive: true });
    await writeFile(
      path.join(root, '.neuro-vault/corpus/bge-micro-v2/manifest.json'),
      JSON.stringify({
        embed_version: 1,
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        dims: 384,
        strategy: 'sc-parity-v1',
        created: '2026-08-25T00:00:00.000Z',
      }),
    );
    const manifest = await new ShardStore(root, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    }).readManifest();
    expect(manifest).toMatchObject({ model_key: 'bge-micro-v2', embed_version: 1 });
    expect(isManifestCompatible(manifest, TEST_IDENTITY, true)).toBe(false);
  });
});

describe('ensureCorpusGitignored', () => {
  it('appends one entry, preserving existing lines', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), '.obsidian/\nnode_modules\n');
    await ensureCorpusGitignored(root);
    const after = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(after).toContain('.obsidian/');
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

describe('ShardStore per-model directories', () => {
  const granite = { ...expected, model_key: 'granite-97m' };
  const harrier = { ...expected, model_key: 'harrier-270m' };

  it('writes shards and the manifest under corpus/<modelKey>/', async () => {
    const root = await tempVault();
    const store = new ShardStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    await store.writeShard(shard('N.md'));
    await store.writeManifest({ ...granite, created: 'x' });
    const dir = path.join(root, '.neuro-vault/corpus/granite-97m');
    expect((await readdir(dir)).sort()).toEqual(['manifest.json', 'notes']);
    expect(await readdir(path.join(dir, 'notes'))).toEqual([ShardStore.shardFileName('N.md')]);
    expect((await readdir(path.join(root, '.neuro-vault/corpus'))).sort()).toEqual(['granite-97m']);
  });

  it('keeps two models of one vault apart', async () => {
    const root = await tempVault();
    const a = new ShardStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    const b = new ShardStore(root, { modelKey: 'harrier-270m', dims: TEST_DIMS });
    await a.writeShard(shard('A.md'));
    expect(await b.readShard('A.md')).toBeNull();
    expect(await b.listShards()).toEqual(new Map());
    expect(await b.readManifest()).toBeNull();
  });

  it('rebuilding one model leaves the other model untouched', async () => {
    const root = await tempVault();
    const a = new ShardStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    const b = new ShardStore(root, { modelKey: 'harrier-270m', dims: TEST_DIMS });
    await a.ensureManifest(granite);
    await a.writeShard(shard('A.md'));
    await b.ensureManifest(harrier);
    await b.writeShard(shard('B.md'));
    const graniteManifest = path.join(root, '.neuro-vault/corpus/granite-97m/manifest.json');
    const before = await readFile(graniteManifest, 'utf8');

    const result = await b.ensureManifest({ ...harrier, embed_version: harrier.embed_version + 1 });

    expect(result.rebuilt).toBe(true);
    expect(await b.listShards()).toEqual(new Map());
    expect([...(await a.listShards()).keys()]).toEqual(['A.md']);
    expect(await readFile(graniteManifest, 'utf8')).toBe(before);
  });

  it('refuses an unsafe model key before any I/O', () => {
    const readdirSpy = vi.fn(async () => []);
    expect(
      () => new ShardStore('/v', { modelKey: '../x', dims: TEST_DIMS, readdir: readdirSpy }),
    ).toThrow('"../x" is not a valid model directory name');
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});
