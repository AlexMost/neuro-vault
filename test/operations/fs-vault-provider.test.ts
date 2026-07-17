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

describe('FsVaultProvider delegation', () => {
  it('delegates setProperty, removeProperty', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const provider = new FsVaultProvider({ vaultName: 'V', exec });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
      value: 'done',
    });
    await provider.removeProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
    });

    expect(exec).toHaveBeenNthCalledWith(
      1,
      'obsidian',
      ['vault=V', 'property:set', 'name=status', 'value=done', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'obsidian',
      ['vault=V', 'property:remove', 'name=status', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
  });

  it('propagates CLI errors unchanged', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ENOENT' }));
    const provider = new FsVaultProvider({ exec });

    await expect(
      provider.setProperty({
        identifier: { kind: 'path', value: 'Inbox/x.md' },
        name: 'status',
        value: 'done',
      }),
    ).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });
});

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
