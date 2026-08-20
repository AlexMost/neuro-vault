import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createExistingPathFilter } from '../../../src/lib/obsidian/existing-paths.js';

async function makeVault(paths: string[]): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'existing-paths-'));
  for (const rel of paths) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '', 'utf8');
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe('createExistingPathFilter', () => {
  it('reports only the paths that exist on disk', async () => {
    const { root, cleanup } = await makeVault(['Folder/a.md', 'Folder/b.md']);
    try {
      const filter = createExistingPathFilter({ vaultRoot: root });
      const survivors = await filter(['Folder/a.md', 'Folder/gone.md', 'Folder/b.md']);
      expect([...survivors].sort()).toEqual(['Folder/a.md', 'Folder/b.md']);
    } finally {
      await cleanup();
    }
  });

  it('checks a repeated path once and reports it once', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/v', access });
    const survivors = await filter(['a.md', 'a.md', 'a.md']);
    expect(access).toHaveBeenCalledTimes(1);
    expect([...survivors]).toEqual(['a.md']);
  });

  it('resolves a missing path as absent instead of raising', async () => {
    const { root, cleanup } = await makeVault(['keep.md']);
    try {
      const filter = createExistingPathFilter({ vaultRoot: root });
      await expect(filter(['keep.md', 'gone.md'])).resolves.toEqual(new Set(['keep.md']));
    } finally {
      await cleanup();
    }
  });

  it('returns an empty set for empty input without touching the filesystem', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/v', access });
    expect(await filter([])).toEqual(new Set());
    expect(access).not.toHaveBeenCalled();
  });

  it('joins each path against its own vault root', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/vaults/alpha', access });
    await filter(['Folder/note.md']);
    expect(access).toHaveBeenCalledWith(path.join('/vaults/alpha', 'Folder/note.md'));
  });
});
