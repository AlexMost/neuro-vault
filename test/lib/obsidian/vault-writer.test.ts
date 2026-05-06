import { describe, expect, it, vi } from 'vitest';

import { FsVaultWriter } from '../../../src/lib/obsidian/vault-writer.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';

function fakeFs(initial: Record<string, string>) {
  const files = { ...initial };
  const readFile = vi.fn(async (absPath: string, encoding: 'utf8') => {
    expect(encoding).toBe('utf8');
    if (!(absPath in files)) {
      const err = new Error('ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    }
    return files[absPath]!;
  });
  const writeFile = vi.fn(async (absPath: string, data: string, encoding: 'utf8') => {
    expect(encoding).toBe('utf8');
    files[absPath] = data;
  });
  return { files, readFile, writeFile };
}

describe('FsVaultWriter.replaceInNote', () => {
  it('replaces a single occurrence and writes back', async () => {
    const fs = fakeFs({
      '/vault/n.md': '---\ntype: note\n---\nfind me here\nrest\n',
    });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceInNote({
      path: 'n.md',
      find: 'find me',
      content: 'changed',
    });

    expect(fs.files['/vault/n.md']).toBe('---\ntype: note\n---\nchanged here\nrest\n');
  });

  it('preserves frontmatter byte-for-byte even if find matches inside it', async () => {
    const fs = fakeFs({
      '/vault/n.md': '---\n# inline comment\ntype: note   \nbody\n---\nbody body body\n',
    });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceInNote({
      path: 'n.md',
      find: 'body body body',
      content: 'B',
    });

    expect(fs.files['/vault/n.md']).toBe('---\n# inline comment\ntype: note   \nbody\n---\nB\n');
  });

  it('throws NOT_FOUND when the note file is missing', async () => {
    const fs = fakeFs({});
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await expect(
      writer.replaceInNote({ path: 'gone.md', find: 'x', content: 'y' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('gone.md'),
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when find text is absent in the body', async () => {
    const fs = fakeFs({ '/vault/n.md': '---\ntype: note\n---\nhello\n' });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await expect(
      writer.replaceInNote({ path: 'n.md', find: 'xxx', content: 'y' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('throws AMBIGUOUS_MATCH with line numbers when multiple matches', async () => {
    const fs = fakeFs({
      '/vault/n.md': '---\ntype: note\n---\nfoo\nbar foo\nfoo end\n',
    });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await expect(
      writer.replaceInNote({ path: 'n.md', find: 'foo', content: 'X' }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_MATCH',
      details: { matches: [1, 2, 3] },
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('FsVaultWriter.replaceFullBody', () => {
  it('replaces the body but preserves frontmatter byte-for-byte', async () => {
    const fs = fakeFs({
      '/vault/n.md': '---\ntype: note\nstatus: active\n---\nold body\n',
    });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceFullBody({ path: 'n.md', content: 'brand new body\n' });

    expect(fs.files['/vault/n.md']).toBe('---\ntype: note\nstatus: active\n---\nbrand new body\n');
  });

  it('replaces the entire file when there is no frontmatter', async () => {
    const fs = fakeFs({ '/vault/n.md': 'no frontmatter here\n' });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceFullBody({ path: 'n.md', content: 'new\n' });

    expect(fs.files['/vault/n.md']).toBe('new\n');
  });

  it('writes content verbatim with no added or stripped newlines', async () => {
    const fs = fakeFs({ '/vault/n.md': '---\nx: y\n---\nbody\n' });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceFullBody({ path: 'n.md', content: 'no trailing newline' });

    expect(fs.files['/vault/n.md']).toBe('---\nx: y\n---\nno trailing newline');
  });

  it('allows empty content (truncates body, keeps frontmatter)', async () => {
    const fs = fakeFs({ '/vault/n.md': '---\nx: y\n---\nbody\n' });
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await writer.replaceFullBody({ path: 'n.md', content: '' });

    expect(fs.files['/vault/n.md']).toBe('---\nx: y\n---\n');
  });

  it('throws NOT_FOUND when the note file is missing', async () => {
    const fs = fakeFs({});
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: fs.readFile,
      writeFile: fs.writeFile,
    });

    await expect(writer.replaceFullBody({ path: 'gone.md', content: 'x' })).rejects.toBeInstanceOf(
      ToolHandlerError,
    );
    await expect(writer.replaceFullBody({ path: 'gone.md', content: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
