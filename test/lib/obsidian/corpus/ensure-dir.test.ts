import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureCorpusDir } from '../../../../src/lib/obsidian/corpus/ensure-dir.js';

const vault = () => mkdtemp(path.join(tmpdir(), 'nv-ensure-dir-'));
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe('ensureCorpusDir', () => {
  it('creates the meta directory and everything below it under an existing vault', async () => {
    const root = await vault();
    const meta = path.join(root, '.neuro-vault');
    await ensureCorpusDir(meta, path.join(meta, 'corpus', 'm', 'notes'));
    expect(await exists(path.join(meta, 'corpus', 'm', 'notes'))).toBe(true);
  });

  it('accepts a meta directory that already exists', async () => {
    const root = await vault();
    const meta = path.join(root, '.neuro-vault');
    await mkdir(meta);
    await ensureCorpusDir(meta, path.join(meta, 'corpus'));
    await ensureCorpusDir(meta, path.join(meta, 'corpus'));
    expect(await exists(path.join(meta, 'corpus'))).toBe(true);
  });

  it('rejects with ENOENT and creates nothing when the vault root is gone', async () => {
    const root = await vault();
    await rm(root, { recursive: true, force: true });
    const meta = path.join(root, '.neuro-vault');
    await expect(ensureCorpusDir(meta, path.join(meta, 'corpus'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await exists(root)).toBe(false);
  });

  it('only the part below the meta directory is made recursively', async () => {
    const mkdirFn = vi.fn(async () => undefined);
    await ensureCorpusDir('/v/.neuro-vault', '/v/.neuro-vault/corpus/m', mkdirFn);
    expect(mkdirFn.mock.calls).toEqual([
      ['/v/.neuro-vault', { recursive: false }],
      ['/v/.neuro-vault/corpus/m', { recursive: true }],
    ]);
  });

  it('rethrows any other error from the meta directory', async () => {
    const mkdirFn = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    await expect(
      ensureCorpusDir('/v/.neuro-vault', '/v/.neuro-vault/corpus', mkdirFn),
    ).rejects.toThrow('denied');
  });
});
