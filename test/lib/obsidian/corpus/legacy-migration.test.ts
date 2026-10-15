import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { migrateLegacyCorpus } from '../../../../src/lib/obsidian/corpus/legacy-migration.js';
import { TEST_IDENTITY } from '../../../_identity.js';

const manifestFor = (modelKey: string) =>
  JSON.stringify({ ...TEST_IDENTITY, model_key: modelKey, created: '2026-10-01T00:00:00.000Z' });

/** A vault whose corpus is in the single-corpus layout: root manifest + notes/. */
async function legacyVault(
  manifest: string | null,
  shards: string[] = ['a.json', 'b.json'],
): Promise<{ root: string; corpus: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-migrate-'));
  const corpus = path.join(root, '.neuro-vault/corpus');
  await mkdir(path.join(corpus, 'notes'), { recursive: true });
  if (manifest !== null) await writeFile(path.join(corpus, 'manifest.json'), manifest);
  for (const shard of shards)
    await writeFile(path.join(corpus, 'notes', shard), `{"s":"${shard}"}`);
  return { root, corpus };
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('migrateLegacyCorpus', () => {
  it('moves the manifest and every shard into the model directory, warning once', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    const warn = vi.fn();

    expect(await migrateLegacyCorpus(root, { warn })).toEqual({
      kind: 'migrated',
      modelKey: 'harrier-270m',
    });

    expect((await readdir(corpus)).sort()).toEqual(['harrier-270m']);
    expect(await readFile(path.join(corpus, 'harrier-270m/manifest.json'), 'utf8')).toBe(
      manifestFor('harrier-270m'),
    );
    expect((await readdir(path.join(corpus, 'harrier-270m/notes'))).sort()).toEqual([
      'a.json',
      'b.json',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('harrier-270m');
  });

  it('moves a legacy corpus of another model into that model’s directory', async () => {
    const { root, corpus } = await legacyVault(manifestFor('bge-micro-v2'));
    await migrateLegacyCorpus(root, { warn: vi.fn() });
    expect((await readdir(corpus)).sort()).toEqual(['bge-micro-v2']);
  });

  it('moves a manifest-only legacy corpus', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    await rm(path.join(corpus, 'notes'), { recursive: true });
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
      kind: 'migrated',
      modelKey: 'harrier-270m',
    });
    expect(await readdir(corpus)).toEqual(['harrier-270m']);
    expect(await readdir(path.join(corpus, 'harrier-270m'))).toEqual(['manifest.json']);
  });

  it.each(['reconcile.lock', 'manifest.json', 'Notes'])(
    'leaves a manifest naming the reserved entry %s alone, pass after pass',
    async (key) => {
      const { root, corpus } = await legacyVault(manifestFor(key));
      for (let pass = 0; pass < 2; pass += 1) {
        expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
          kind: 'skipped',
          reason: 'unreadable',
        });
      }
      expect((await readdir(corpus)).sort()).toEqual(['manifest.json', 'notes']);
    },
  );

  it('reports none when there is no root manifest', async () => {
    const { root, corpus } = await legacyVault(null);
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({ kind: 'none' });
    expect(await exists(path.join(corpus, 'notes'))).toBe(true);
  });

  it('reports none for a vault with no corpus at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-migrate-'));
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({ kind: 'none' });
  });

  it('completes an interrupted migration: shards already moved, manifest not', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    await mkdir(path.join(corpus, 'harrier-270m'));
    await rename(path.join(corpus, 'notes'), path.join(corpus, 'harrier-270m/notes'));

    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toMatchObject({ kind: 'migrated' });
    expect((await readdir(corpus)).sort()).toEqual(['harrier-270m']);
    expect((await readdir(path.join(corpus, 'harrier-270m'))).sort()).toEqual([
      'manifest.json',
      'notes',
    ]);
  });

  it('leaves everything in place when the model directory already has a manifest', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    await mkdir(path.join(corpus, 'harrier-270m'));
    await writeFile(path.join(corpus, 'harrier-270m/manifest.json'), 'newer');

    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
      kind: 'skipped',
      reason: 'target-exists',
    });
    expect(await readFile(path.join(corpus, 'harrier-270m/manifest.json'), 'utf8')).toBe('newer');
    expect(await exists(path.join(corpus, 'manifest.json'))).toBe(true);
    expect(await exists(path.join(corpus, 'notes/a.json'))).toBe(true);
  });

  it('leaves a manifest that is not valid JSON alone, without warning', async () => {
    const { root, corpus } = await legacyVault('{ not json');
    const warn = vi.fn();
    expect(await migrateLegacyCorpus(root, { warn })).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect((await readdir(corpus)).sort()).toEqual(['manifest.json', 'notes']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a model key that is a path, creating nothing outside the corpus', async () => {
    const { root, corpus } = await legacyVault(manifestFor('../../outside'));
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect((await readdir(corpus)).sort()).toEqual(['manifest.json', 'notes']);
    expect(await exists(path.join(root, 'outside'))).toBe(false);
    expect(await exists(path.join(root, '..', 'outside'))).toBe(false);
  });

  it('treats a source that vanished mid-migration as already moved', async () => {
    const { root } = await legacyVault(manifestFor('harrier-270m'));
    const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const renameGone = vi.fn(async () => {
      throw gone;
    });
    await expect(migrateLegacyCorpus(root, { rename: renameGone, warn: vi.fn() })).resolves.toEqual(
      { kind: 'migrated', modelKey: 'harrier-270m' },
    );
    expect(renameGone).toHaveBeenCalledTimes(2); // notes/, then manifest.json
  });

  it('propagates any other rename failure', async () => {
    const { root } = await legacyVault(manifestFor('harrier-270m'));
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(
      migrateLegacyCorpus(root, {
        rename: async () => {
          throw denied;
        },
        warn: vi.fn(),
      }),
    ).rejects.toBe(denied);
  });
});
