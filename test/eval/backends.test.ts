import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShardStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { TEST_DIMS, TEST_IDENTITY } from '../_identity.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { BackendError, loadSnapshot } from '../../eval/backends.js';

function unitVec(hot: number): number[] {
  const v = new Array<number>(TEST_DIMS).fill(0);
  v[hot] = 1;
  return v;
}

describe('own backend snapshot', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  it('decodes shards into SmartSource entries and skips vectorless notes', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-'));
    const store = new ShardStore(vaultRoot, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.ensureManifest(TEST_IDENTITY);
    await store.writeShard({
      path: 'Notes/a.md',
      content_hash: 'h1',
      mtime: 1,
      size: 10,
      embedding: encodeVector(unitVec(0)),
      blocks: [{ key: '#H1', heading: 'H1', lines: [1, 4], embedding: encodeVector(unitVec(1)) }],
    });
    await store.writeShard({
      path: 'Notes/short.md', // below MIN_CHARS at index time → null note vector
      content_hash: 'h2',
      mtime: 2,
      size: 5,
      embedding: null,
      blocks: [],
    });

    const sources = await loadSnapshot(vaultRoot, TEST_IDENTITY);
    expect([...sources.keys()]).toEqual(['Notes/a.md']);
    const a = sources.get('Notes/a.md')!;
    expect(a.embedding[0]).toBe(1);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ key: '#H1', heading: 'H1', lines: [1, 4] });
    expect(a.blocks[0].embedding[1]).toBe(1);
  });

  it('fails an empty corpus pointing at the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-empty-'));
    const err = await loadSnapshot(vaultRoot, TEST_IDENTITY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toContain('neuro-vault-mcp index');
    expect((err as Error).message).toContain('--model bge-micro-v2');
  });

  it('refuses a model corpus built with another identity before listing shards, naming the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    // A 640-wide shard under a manifest of another embed_version: the manifest must refuse it.
    const wide = new ShardStore(vaultRoot, { modelKey: 'harrier-270m', dims: 640 });
    await wide.writeManifest({
      ...TEST_IDENTITY,
      model_key: 'harrier-270m',
      dims: 640,
      embed_version: TEST_IDENTITY.embed_version + 1,
      created: 'x',
    });
    await wide.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(new Array<number>(640).fill(0.01)),
      blocks: [],
    });
    await expect(
      loadSnapshot(vaultRoot, { ...TEST_IDENTITY, model_key: 'harrier-270m' }),
    ).rejects.toThrow(
      `was indexed with harrier-270m (embed_version ${TEST_IDENTITY.embed_version + 1}), not harrier-270m (embed_version ${TEST_IDENTITY.embed_version}) — rebuild it for this model with: neuro-vault-mcp index --vault ${vaultRoot} --model harrier-270m`,
    );
  });

  it('quotes a vault path containing spaces or quotes in the suggested index command', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'eval-quote-'));
    vaultRoot = base;
    const spaced = path.join(base, "My Vault's copy");
    await mkdir(spaced);
    const err = await loadSnapshot(spaced, TEST_IDENTITY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    const quoted = `'${spaced.replaceAll("'", `'\\''`)}'`;
    expect((err as Error).message).toContain(`--vault ${quoted} --model bge-micro-v2`);
    expect((err as Error).message).toContain(`--vault '${base}/My Vault'\\''s copy'`);
  });

  it('refuses shards whose manifest is missing', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const store = new ShardStore(vaultRoot, {
      modelKey: TEST_IDENTITY.model_key,
      dims: TEST_DIMS,
    });
    await store.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(unitVec(0)),
      blocks: [],
    });
    await expect(loadSnapshot(vaultRoot, TEST_IDENTITY)).rejects.toThrow(
      `has no readable manifest — rebuild it with: neuro-vault-mcp index --vault ${vaultRoot} --model bge-micro-v2`,
    );
  });

  it('refuses manifest-less shards of another width on the manifest, without decoding them', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const wide = new ShardStore(vaultRoot, { modelKey: TEST_IDENTITY.model_key, dims: 640 });
    await wide.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(new Array<number>(640).fill(0.01)),
      blocks: [],
    });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadSnapshot(vaultRoot, TEST_IDENTITY)).rejects.toThrow(
        'has no readable manifest',
      );
      // Decoding would have warned once per shard and then read as "missing or empty".
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('names the other models present when the selected one has no corpus, and leaves them alone', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const granite = new ShardStore(vaultRoot, { modelKey: 'granite-97m', dims: TEST_DIMS });
    await granite.ensureManifest({ ...TEST_IDENTITY, model_key: 'granite-97m' });
    await granite.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(unitVec(0)),
      blocks: [],
    });
    const manifest = path.join(vaultRoot, '.neuro-vault/corpus/granite-97m/manifest.json');
    const before = await readFile(manifest, 'utf8');

    const err = await loadSnapshot(vaultRoot, {
      ...TEST_IDENTITY,
      model_key: 'harrier-270m',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toContain(
      `${path.join(vaultRoot, '.neuro-vault/corpus/harrier-270m')} is missing or empty (this vault has corpora for: granite-97m)`,
    );
    expect((err as Error).message).toContain('--model harrier-270m');
    expect(await readFile(manifest, 'utf8')).toBe(before);
    expect([...(await granite.listShards()).keys()]).toEqual(['a.md']);
  });

  it('neither migrates nor locks: a legacy root corpus is reported missing and left in place', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const corpus = path.join(vaultRoot, '.neuro-vault/corpus');
    await mkdir(path.join(corpus, 'notes'), { recursive: true });
    await writeFile(
      path.join(corpus, 'manifest.json'),
      JSON.stringify({ ...TEST_IDENTITY, created: 'x' }),
    );

    await expect(loadSnapshot(vaultRoot, TEST_IDENTITY)).rejects.toThrow('is missing or empty');
    expect((await stat(path.join(corpus, 'manifest.json'))).isFile()).toBe(true);
    await expect(stat(path.join(corpus, 'reconcile.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
