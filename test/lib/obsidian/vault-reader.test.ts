import { describe, expect, it, vi } from 'vitest';

import { FsVaultReader, ScanPathNotFoundError } from '../../../src/lib/obsidian/vault-reader.js';

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

describe('FsVaultReader.scan', () => {
  function fakeStat(dirs: Set<string>) {
    return vi.fn(async (absPath: string) => {
      if (!dirs.has(absPath)) {
        const err = new Error('ENOENT') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return { isDirectory: () => true };
    });
  }

  it('scans the whole vault when no pathPrefix is given', async () => {
    const glob = vi.fn(async () => ['a.md', 'sub/b.md', 'sub/deep/c.md']);
    const reader = new FsVaultReader({ vaultRoot: '/v', glob });

    const out = await reader.scan();

    expect(out).toEqual(['a.md', 'sub/b.md', 'sub/deep/c.md']);
    expect(glob).toHaveBeenCalledWith('**/*.md', {
      cwd: '/v',
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
  });

  it('treats trailing-slash and no-trailing-slash prefixes the same', async () => {
    const stat = fakeStat(new Set(['/v/Projects']));
    const glob = vi.fn(async () => ['x.md', 'sub/y.md']);
    const reader = new FsVaultReader({ vaultRoot: '/v', stat, glob });

    const a = await reader.scan({ pathPrefix: 'Projects' });
    const b = await reader.scan({ pathPrefix: 'Projects/' });

    expect(a).toEqual(['Projects/sub/y.md', 'Projects/x.md']);
    expect(b).toEqual(a);
  });

  it('throws PATH_NOT_FOUND when prefix directory is missing', async () => {
    const stat = fakeStat(new Set());
    const glob = vi.fn();
    const reader = new FsVaultReader({ vaultRoot: '/v', stat, glob });

    await expect(reader.scan({ pathPrefix: 'Nope' })).rejects.toBeInstanceOf(ScanPathNotFoundError);
    expect(glob).not.toHaveBeenCalled();
  });

  it('returns an empty array when prefix exists but contains no .md', async () => {
    const stat = fakeStat(new Set(['/v/Empty']));
    const glob = vi.fn(async () => []);
    const reader = new FsVaultReader({ vaultRoot: '/v', stat, glob });

    const out = await reader.scan({ pathPrefix: 'Empty' });

    expect(out).toEqual([]);
  });

  it('strips ./ and treats "." as no prefix', async () => {
    const glob = vi.fn(async () => ['x.md']);
    const reader = new FsVaultReader({ vaultRoot: '/v', glob });

    const out = await reader.scan({ pathPrefix: '.' });

    expect(out).toEqual(['x.md']);
    expect(glob).toHaveBeenCalledWith('**/*.md', {
      cwd: '/v',
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
  });

  it('returns POSIX paths even when fast-glob yields backslashes', async () => {
    const stat = fakeStat(new Set(['/v/Projects']));
    const glob = vi.fn(async () => ['sub\\y.md']);
    const reader = new FsVaultReader({ vaultRoot: '/v', stat, glob });

    const out = await reader.scan({ pathPrefix: 'Projects' });

    expect(out).toEqual(['Projects/sub/y.md']);
  });
});
