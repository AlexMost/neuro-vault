import { describe, expect, it } from 'vitest';

import { makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider.listProperties (disk)', () => {
  it('counts each frontmatter key once per note', async () => {
    const root = await makeVault({
      'a.md': '---\nstatus: todo\npriority: 2\n---\n',
      'b.md': '---\nstatus: done\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([
      { name: 'status', count: 2 },
      { name: 'priority', count: 1 },
    ]);
  });

  it('returns [] for a vault with no frontmatter', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([]);
  });

  it('counts tags as a property alongside others, sorted name-asc at equal count', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [a]\nstatus: x\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
    ]);
  });

  it('counts a nested-object value once, by its top-level key', async () => {
    const root = await makeVault({
      'a.md': '---\nmeta:\n  a: 1\n  b: 2\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([{ name: 'meta', count: 1 }]);
  });

  it('counts an array-valued property once', async () => {
    const root = await makeVault({
      'a.md': '---\naliases:\n  - x\n  - y\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([{ name: 'aliases', count: 1 }]);
  });

  it('sorts by count descending, then name ascending', async () => {
    const root = await makeVault({
      'a.md': '---\npopular: 1\nzeta: 1\nalpha: 1\n---\n',
      'b.md': '---\npopular: 2\n---\n',
      'c.md': '---\npopular: 3\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([
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
    const provider = makeProvider(root);

    const result = await provider.listProperties();
    expect(result).toContainEqual({ name: 'shared', count: 3 });
    expect(result).toContainEqual({ name: 'other', count: 1 });
  });

  it('returns [] for an empty vault', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([]);
  });

  it('contributes no keys for an empty frontmatter block', async () => {
    const root = await makeVault({ 'a.md': '---\n---\nbody\n' });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([]);
  });

  it('scans nested folders', async () => {
    const root = await makeVault({
      'Deep/n.md': '---\nnested: true\n---\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listProperties()).toEqual([{ name: 'nested', count: 1 }]);
  });
});
