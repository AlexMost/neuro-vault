import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorpusStore } from '../../src/lib/obsidian/corpus/shard-store.js';
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
    const store = new CorpusStore(vaultRoot, { dims: TEST_DIMS });
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

  it('refuses a corpus built by another profile before listing shards, naming the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    // A 640-wide shard under a granite manifest: the manifest must be what refuses it.
    const wide = new CorpusStore(vaultRoot, { dims: 640 });
    await wide.writeManifest({
      ...TEST_IDENTITY,
      model_key: 'granite-97m',
      dims: 640,
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
      `was indexed with granite-97m (embed_version 1), not harrier-270m (embed_version 1) — rebuild it for this model with: neuro-vault-mcp index --vault ${vaultRoot} --model harrier-270m`,
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
    const store = new CorpusStore(vaultRoot, { dims: TEST_DIMS });
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
});
