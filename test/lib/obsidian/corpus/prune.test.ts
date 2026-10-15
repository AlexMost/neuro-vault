import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { listModelCorpora, pruneOtherCorpora } from '../../../../src/lib/obsidian/corpus/prune.js';

/** A corpus root holding two models, a leftover legacy corpus, the lock and a stray file. */
async function crowdedVault(): Promise<{ root: string; corpus: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
  const corpus = path.join(root, '.neuro-vault/corpus');
  for (const dir of ['granite-97m/notes', 'harrier-270m/notes', 'notes']) {
    await mkdir(path.join(corpus, dir), { recursive: true });
  }
  await writeFile(path.join(corpus, 'granite-97m/manifest.json'), '{}');
  await writeFile(path.join(corpus, 'harrier-270m/manifest.json'), '{}');
  await writeFile(path.join(corpus, 'manifest.json'), '{}');
  await writeFile(path.join(corpus, 'reconcile.lock'), '{"pid":1}');
  await writeFile(path.join(corpus, '.DS_Store'), '');
  return { root, corpus };
}

describe('pruneOtherCorpora', () => {
  it('removes every other model, the legacy root corpus, and reports them sorted', async () => {
    const { root, corpus } = await crowdedVault();
    expect(await pruneOtherCorpora(root, 'harrier-270m')).toEqual([
      'granite-97m',
      'manifest.json',
      'notes',
    ]);
    expect((await readdir(corpus)).sort()).toEqual(['.DS_Store', 'harrier-270m', 'reconcile.lock']);
    expect((await readdir(path.join(corpus, 'harrier-270m'))).sort()).toEqual([
      'manifest.json',
      'notes',
    ]);
  });

  it('removes nothing when only the kept model is present', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    await mkdir(path.join(root, '.neuro-vault/corpus/harrier-270m'), { recursive: true });
    await writeFile(path.join(root, '.neuro-vault/corpus/harrier-270m/manifest.json'), '{}');
    expect(await pruneOtherCorpora(root, 'harrier-270m')).toEqual([]);
  });

  it('refuses a vault with no corpus: nothing would be left to serve', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    await expect(pruneOtherCorpora(root, 'harrier-270m')).rejects.toThrow(
      `neuro-vault corpus: not pruning ${root}: the harrier-270m corpus has no manifest, ` +
        'so nothing would be left to serve',
    );
  });

  it('refuses, removing nothing, when the kept model’s corpus vanished (a concurrent prune)', async () => {
    const { root, corpus } = await crowdedVault();
    await rm(path.join(corpus, 'harrier-270m'), { recursive: true });
    const remove = vi.fn(async () => {});
    await expect(pruneOtherCorpora(root, 'harrier-270m', { remove })).rejects.toThrow(
      `neuro-vault corpus: not pruning ${root}: the harrier-270m corpus has no manifest, ` +
        'so nothing would be left to serve',
    );
    expect(remove).not.toHaveBeenCalled();
    expect((await readdir(corpus)).sort()).toEqual([
      '.DS_Store',
      'granite-97m',
      'manifest.json',
      'notes',
      'reconcile.lock',
    ]);
  });

  it('refuses, removing nothing, when the kept model’s directory has no manifest', async () => {
    const { root, corpus } = await crowdedVault();
    await rm(path.join(corpus, 'harrier-270m/manifest.json'));
    const remove = vi.fn(async () => {});
    await expect(pruneOtherCorpora(root, 'harrier-270m', { remove })).rejects.toThrow(
      'the harrier-270m corpus has no manifest',
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('asks the injected exists about the kept model’s manifest', async () => {
    const { root, corpus } = await crowdedVault();
    const exists = vi.fn(async () => false);
    const remove = vi.fn(async () => {});
    await expect(pruneOtherCorpora(root, 'harrier-270m', { exists, remove })).rejects.toThrow(
      'has no manifest',
    );
    expect(exists).toHaveBeenCalledWith(path.join(corpus, 'harrier-270m/manifest.json'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses an invalid model key, removing nothing', async () => {
    const { root } = await crowdedVault();
    const remove = vi.fn(async () => {});
    for (const key of ['notes', '../escape', '']) {
      await expect(pruneOtherCorpora(root, key, { remove })).rejects.toThrow(
        `neuro-vault corpus: not pruning ${root}: "${key}" is not a valid model directory name`,
      );
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it('never follows or removes a symlink to a directory elsewhere', async () => {
    const { root, corpus } = await crowdedVault();
    const outside = await mkdtemp(path.join(tmpdir(), 'nv-prune-outside-'));
    await writeFile(path.join(outside, 'precious.md'), 'keep me');
    await symlink(outside, path.join(corpus, 'elsewhere'));

    expect(await pruneOtherCorpora(root, 'harrier-270m')).not.toContain('elsewhere');
    expect(await readdir(outside)).toEqual(['precious.md']);
    expect((await stat(path.join(corpus, 'elsewhere'))).isDirectory()).toBe(true);
  });
});

describe('listModelCorpora', () => {
  it('lists model directories only, sorted, never the legacy notes/', async () => {
    const { root } = await crowdedVault();
    expect(await listModelCorpora(root)).toEqual(['granite-97m', 'harrier-270m']);
  });

  it('returns nothing for a vault with no corpus', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    expect(await listModelCorpora(root)).toEqual([]);
  });
});
