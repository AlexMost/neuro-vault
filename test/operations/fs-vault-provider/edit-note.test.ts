import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { byName, byPath, makeProvider, makeVault } from './_helpers.js';

const WITH_FM = '---\ntitle: T\n---\nalpha\nbeta\n';

describe('FsVaultProvider.replaceFullBody', () => {
  it('rewrites the body and preserves frontmatter byte-for-byte', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    await makeProvider(root).replaceFullBody({ identifier: byPath('n.md'), content: 'new\n' });

    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('---\ntitle: T\n---\nnew\n');
  });

  it('fails NOT_FOUND when the note does not exist', async () => {
    const root = await makeVault({});

    await expect(
      makeProvider(root).replaceFullBody({ identifier: byPath('missing.md'), content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'missing.md' } });
  });

  it('fails WRITE_FAILED when the write rejects', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    const provider = makeProvider(root, {
      writeFile: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
    });

    await expect(
      provider.replaceFullBody({ identifier: byPath('n.md'), content: 'x' }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });
});

describe('FsVaultProvider.replaceInNote', () => {
  it('swaps the single match and preserves frontmatter', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    await makeProvider(root).replaceInNote({
      identifier: byPath('n.md'),
      find: 'alpha',
      content: 'gamma',
    });

    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe(
      '---\ntitle: T\n---\ngamma\nbeta\n',
    );
  });

  it('fails NOT_FOUND when the find text is absent from the body', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'nope', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'n.md' } });
  });

  it('fails AMBIGUOUS_MATCH with line numbers when the find text repeats', async () => {
    const root = await makeVault({ 'n.md': '---\ntitle: T\n---\ndup\ndup\n' });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'dup', content: 'x' }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_MATCH', details: { matches: [1, 2] } });
  });

  it('does not write when the find text is ambiguous', async () => {
    const root = await makeVault({ 'n.md': '---\ntitle: T\n---\ndup\ndup\n' });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'dup', content: 'x' }),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('---\ntitle: T\n---\ndup\ndup\n');
  });
});

describe('FsVaultProvider: name-addressed edits resolve like every other write', () => {
  it('resolves a unique basename to its path', async () => {
    const root = await makeVault({ 'Folder/Uniq.md': 'body\n' });
    await makeProvider(root).replaceFullBody({ identifier: byName('Uniq'), content: 'new\n' });

    expect(await readFile(path.join(root, 'Folder/Uniq.md'), 'utf8')).toBe('new\n');
  });

  it('fails NOT_FOUND when the name matches zero notes', async () => {
    const root = await makeVault({ 'Other.md': 'body\n' });

    await expect(
      makeProvider(root).replaceFullBody({ identifier: byName('Missing'), content: 'new\n' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { name: 'Missing' } });
  });

  it('fails AMBIGUOUS_MATCH on a shared basename and writes nothing', async () => {
    const root = await makeVault({ 'A/Dup.md': 'a\n', 'B/Dup.md': 'b\n' });

    await expect(
      makeProvider(root).replaceFullBody({ identifier: byName('Dup'), content: 'new\n' }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_MATCH' });
    expect(await readFile(path.join(root, 'A/Dup.md'), 'utf8')).toBe('a\n');
    expect(await readFile(path.join(root, 'B/Dup.md'), 'utf8')).toBe('b\n');
  });
});
