import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { computeVaultOverview } from '../../src/lib/obsidian/vault-overview.js';
import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import { FsVaultProvider } from '../../src/modules/operations/fs-vault-provider.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fs-provider-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}

function makeMockGraph(): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
  } as unknown as WikilinkGraphIndex;
}

describe('FsVaultProvider.createNote (disk)', () => {
  it('writes content verbatim and creates parent folders', async () => {
    const root = await makeVault({});
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    const result = await provider.createNote({
      path: 'Deep/Nested/x.md',
      content: '---\na: 1\n---\nbody\n',
    });

    expect(result).toEqual({ path: 'Deep/Nested/x.md' });
    expect(await readFile(path.join(root, 'Deep/Nested/x.md'), 'utf8')).toBe(
      '---\na: 1\n---\nbody\n',
    );
  });

  it('fails NOTE_EXISTS without overwrite, succeeds with it', async () => {
    const root = await makeVault({ 'x.md': 'old' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(provider.createNote({ path: 'x.md', content: 'new' })).rejects.toMatchObject({
      code: 'NOTE_EXISTS',
    });
    await provider.createNote({ path: 'x.md', content: 'new', overwrite: true });
    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('new');
  });

  it('resolves name via app.json newFileFolderPath', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}',
    });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    const result = await provider.createNote({ name: 'Idea 42' });

    expect(result).toEqual({ path: 'Inbox/Idea 42.md' });
  });

  it('resolves name to vault root without app.json', async () => {
    const root = await makeVault({});
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });
});

function todayBasename(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${day}`;
}

describe('FsVaultProvider.readDaily (disk)', () => {
  it("reads today's note per daily-notes.json without the CLI", async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
      [`Daily/${todayBasename()}.md`]: '---\nmood: ok\n---\n# Today\n',
    });
    const exec = vi.fn();
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec,
    });

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: `Daily/${todayBasename()}.md`,
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails DAILY_NOTES_NOT_CONFIGURED when config is absent', async () => {
    const root = await makeVault({ 'a.md': 'x' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
    });
  });

  it("fails NOT_FOUND with the resolved path when today's note is missing", async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
    });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { path: `Daily/${todayBasename()}.md` },
    });
  });
});

describe('FsVaultProvider.listTags / listProperties (disk)', () => {
  it('counts frontmatter tags only, ignoring inline #tags', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha, beta]\n---\nbody #inline\n',
      'b.md': '---\ntags: alpha\n---\n',
      'c.md': 'no frontmatter #beta\n',
    });
    const exec = vi.fn(); // must never be called
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec,
    });

    const tags = await provider.listTags();

    expect(tags).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 1 },
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('counts each frontmatter key once per note', async () => {
    const root = await makeVault({
      'a.md': '---\nstatus: todo\npriority: 2\n---\n',
      'b.md': '---\nstatus: done\n---\n',
    });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    const props = await provider.listProperties();

    expect(props).toEqual([
      { name: 'status', count: 2 },
      { name: 'priority', count: 1 },
    ]);
  });

  it('returns [] for a vault with no frontmatter', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    expect(await provider.listTags()).toEqual([]);
    expect(await provider.listProperties()).toEqual([]);
  });

  it('get_vault_overview core is fully populated with a dead CLI', async () => {
    const root = await makeVault({ 'Tasks/a.md': '---\ntags: [alpha]\nstatus: todo\n---\n' });
    const reader = new FsVaultReader({ vaultRoot: root });
    const exec = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('spawn obsidian ENOENT'), { code: 'ENOENT' }));
    const provider = new FsVaultProvider({ vaultRoot: root, reader, exec });
    const graph = makeMockGraph();

    const overview = await computeVaultOverview({ reader, provider, graph });

    expect(overview.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
    expect(overview.properties).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
    ]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('FsVaultProvider.setProperty / removeProperty (disk)', () => {
  const byPath = (p: string) => ({ kind: 'path' as const, value: p });

  it('sets a property preserving body bytes and neighbor formatting', async () => {
    const src = '---\n# keep me\nstatus: todo\n---\nbody stays\r\nexactly\n';
    const root = await makeVault({ 'x.md': src });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'priority', value: 2 });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toContain('# keep me');
    expect(out).toContain('priority: 2');
    expect(out.endsWith('body stays\r\nexactly\n')).toBe(true);
  });

  it('creates a frontmatter block when the note has none', async () => {
    const root = await makeVault({ 'x.md': 'just body\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'status', value: 'todo' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(
      '---\nstatus: todo\n---\njust body\n',
    );
  });

  it('writes real YAML lists for array values', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.setProperty({
      identifier: byPath('x.md'),
      name: 'tags',
      value: ['alpha', 'beta'],
      type: 'list',
    });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toMatch(/tags:\n\s+- alpha\n\s+- beta/);
  });

  it('removeProperty is idempotent on absent keys (no rewrite)', async () => {
    const src = '---\nstatus:   todo   # odd spacing preserved\n---\n';
    const root = await makeVault({ 'x.md': src });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'missing' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(src);
  });

  it('removes a property; removing the last key strips the block', async () => {
    const root = await makeVault({ 'x.md': '---\nstatus: todo\n---\nbody\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'status' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('body\n');
  });

  it('resolves kind:name via the basename index', async () => {
    const root = await makeVault({ 'Deep/Idea 42.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.setProperty({
      identifier: { kind: 'name', value: 'Idea 42' },
      name: 'a',
      value: 2,
    });

    expect(await readFile(path.join(root, 'Deep/Idea 42.md'), 'utf8')).toContain('a: 2');
  });

  it('fails NOT_FOUND when kind:name is unresolvable', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(
      provider.setProperty({ identifier: { kind: 'name', value: 'Nope' }, name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails READ_FAILED on unparsable existing frontmatter YAML', async () => {
    const root = await makeVault({ 'x.md': '---\na: [1, 2\n---\nbody\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(
      provider.setProperty({ identifier: byPath('x.md'), name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'READ_FAILED' });
  });

  it('fails NOT_FOUND when the note does not exist on disk', async () => {
    const root = await makeVault({});
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await expect(
      provider.setProperty({ identifier: byPath('missing.md'), name: 'a', value: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('never touches .obsidian/types.json', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({
      vaultRoot: root,
      reader: new FsVaultReader({ vaultRoot: root }),
      exec: vi.fn(),
    });

    await provider.setProperty({
      identifier: byPath('x.md'),
      name: 'due',
      value: '2026-08-01',
      type: 'date',
    });

    await expect(readFile(path.join(root, '.obsidian/types.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
