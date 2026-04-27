import { describe, expect, it, vi } from 'vitest';

import { FsVaultReader } from '../../src/modules/operations/vault-reader.js';

function fakeReadFile(files: Record<string, string | { error: Error & { code?: string } }>) {
  return vi.fn(async (absPath: string, encoding: 'utf8') => {
    expect(encoding).toBe('utf8');
    const entry = files[absPath];
    if (entry === undefined) {
      const err = new Error('ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    }
    if (typeof entry !== 'string') {
      throw entry.error;
    }
    return entry;
  });
}

describe('FsVaultReader', () => {
  it('returns parsed frontmatter and body for a single existing path', async () => {
    const readFile = fakeReadFile({
      '/vault/Projects/x.md': '---\ntype: project\nstatus: active\n---\n\n## Body\nhello\n',
    });
    const reader = new FsVaultReader({ vaultRoot: '/vault', readFile });

    const items = await reader.readNotes({
      paths: ['Projects/x.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(items).toEqual([
      {
        path: 'Projects/x.md',
        frontmatter: { type: 'project', status: 'active' },
        content: '\n## Body\nhello\n',
      },
    ]);
    expect(readFile).toHaveBeenCalledWith('/vault/Projects/x.md', 'utf8');
  });

  it('returns frontmatter null when the note has no frontmatter', async () => {
    const readFile = fakeReadFile({ '/vault/n.md': 'just a body without yaml\n' });
    const reader = new FsVaultReader({ vaultRoot: '/vault', readFile });

    const [item] = await reader.readNotes({
      paths: ['n.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(item).toEqual({
      path: 'n.md',
      frontmatter: null,
      content: 'just a body without yaml\n',
    });
  });

  it('preserves input order even when reads finish out of order', async () => {
    const readFile = vi.fn(async (absPath: string) => {
      const delay = absPath.endsWith('a.md') ? 30 : 1;
      await new Promise((r) => globalThis.setTimeout(r, delay));
      return `# ${absPath}\n`;
    });
    const reader = new FsVaultReader({ vaultRoot: '/vault', readFile });

    const items = await reader.readNotes({
      paths: ['a.md', 'b.md', 'c.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(items.map((i) => ('path' in i ? i.path : null))).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('returns NOT_FOUND for a single missing path while other paths succeed', async () => {
    const readFile = fakeReadFile({ '/vault/a.md': '# a\n' });
    const reader = new FsVaultReader({ vaultRoot: '/vault', readFile });

    const items = await reader.readNotes({
      paths: ['a.md', 'missing.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(items[0]).toEqual({ path: 'a.md', frontmatter: null, content: '# a\n' });
    expect(items[1]).toMatchObject({
      path: 'missing.md',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns READ_FAILED for non-ENOENT fs errors', async () => {
    const eaccess = new Error('EACCES') as Error & { code?: string };
    eaccess.code = 'EACCES';
    const readFile = fakeReadFile({ '/vault/a.md': { error: eaccess } });
    const reader = new FsVaultReader({ vaultRoot: '/vault', readFile });

    const [item] = await reader.readNotes({
      paths: ['a.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(item).toMatchObject({
      path: 'a.md',
      error: { code: 'READ_FAILED' },
    });
  });

  it('joins vaultRoot and path correctly across nested directories', async () => {
    const readFile = fakeReadFile({ '/v/a/b/c.md': '# c\n' });
    const reader = new FsVaultReader({ vaultRoot: '/v', readFile });

    const [item] = await reader.readNotes({
      paths: ['a/b/c.md'],
      fields: ['frontmatter', 'content'],
    });

    expect(item).toEqual({ path: 'a/b/c.md', frontmatter: null, content: '# c\n' });
  });

  it('always returns both frontmatter and content on success regardless of fields', async () => {
    const readFile = fakeReadFile({
      '/v/n.md': '---\nstatus: done\n---\n\nbody\n',
    });
    const reader = new FsVaultReader({ vaultRoot: '/v', readFile });

    const [item] = await reader.readNotes({ paths: ['n.md'], fields: ['frontmatter'] });

    expect(item).toEqual({
      path: 'n.md',
      frontmatter: { status: 'done' },
      content: '\nbody\n',
    });
  });
});
