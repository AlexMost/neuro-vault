import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProperties } from '../../../src/lib/obsidian/vault-aggregates.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';

/** Create a temp vault seeded with the given `{ vault-relative-path: contents }` map. */
async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aggregates-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}

const readerOver = (root: string) => new FsVaultReader({ vaultRoot: root });

describe('listProperties over a real FsVaultReader (disk)', () => {
  it('counts each frontmatter key once per note', async () => {
    const root = await makeVault({
      'a.md': '---\nstatus: todo\npriority: 2\n---\n',
      'b.md': '---\nstatus: done\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([
      { name: 'status', count: 2 },
      { name: 'priority', count: 1 },
    ]);
  });

  it('returns [] for a vault with no frontmatter', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([]);
  });

  it('counts tags as a property alongside others, sorted name-asc at equal count', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [a]\nstatus: x\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
    ]);
  });

  it('counts a nested-object value once, by its top-level key', async () => {
    const root = await makeVault({
      'a.md': '---\nmeta:\n  a: 1\n  b: 2\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([{ name: 'meta', count: 1 }]);
  });

  it('counts an array-valued property once', async () => {
    const root = await makeVault({
      'a.md': '---\naliases:\n  - x\n  - y\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([{ name: 'aliases', count: 1 }]);
  });

  it('sorts by count descending, then name ascending', async () => {
    const root = await makeVault({
      'a.md': '---\npopular: 1\nzeta: 1\nalpha: 1\n---\n',
      'b.md': '---\npopular: 2\n---\n',
      'c.md': '---\npopular: 3\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([
      { name: 'popular', count: 3 },
      { name: 'alpha', count: 1 },
      { name: 'zeta', count: 1 },
    ]);
  });

  it('aggregates a key across notes, present in only some of them', async () => {
    const root = await makeVault({
      'a.md': '---\nshared: 1\n---\n',
      'b.md': '---\nshared: 1\n---\n',
      'c.md': '---\nshared: 1\n---\n',
      'd.md': '---\nother: 1\n---\n',
    });
    const reader = readerOver(root);

    const result = await listProperties(reader);
    expect(result).toContainEqual({ name: 'shared', count: 3 });
    expect(result).toContainEqual({ name: 'other', count: 1 });
  });

  it('returns [] for an empty vault', async () => {
    const root = await makeVault({});
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([]);
  });

  it('contributes no keys for an empty frontmatter block', async () => {
    const root = await makeVault({ 'a.md': '---\n---\nbody\n' });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([]);
  });

  it('scans nested folders', async () => {
    const root = await makeVault({
      'Deep/n.md': '---\nnested: true\n---\n',
    });
    const reader = readerOver(root);

    expect(await listProperties(reader)).toEqual([{ name: 'nested', count: 1 }]);
  });
});
