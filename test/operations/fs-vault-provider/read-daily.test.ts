import { describe, expect, it } from 'vitest';

import { makeProvider, makeVault, todayBasename } from './_helpers.js';

// FsVaultProvider.readDaily resolves Obsidian's Daily Notes config
// (.obsidian/daily-notes.json) straight from disk and reads today's note —
// no Obsidian CLI involved. These tests prove that resolution + read path
// end to end, disk-direct.
describe('FsVaultProvider.readDaily (disk)', () => {
  it("reads today's note per daily-notes.json", async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
      [`Daily/${todayBasename()}.md`]: '---\nmood: ok\n---\n# Today\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: `Daily/${todayBasename()}.md`,
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
  });

  it('fails DAILY_NOTES_NOT_CONFIGURED when config is absent', async () => {
    const root = await makeVault({ 'a.md': 'x' });
    const provider = makeProvider(root);

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
    });
  });

  it("fails NOT_FOUND with the resolved path when today's note is missing", async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
    });
    const provider = makeProvider(root);

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { path: `Daily/${todayBasename()}.md` },
    });
  });

  it('returns frontmatter: null for a daily note with no frontmatter block', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
      [`Daily/${todayBasename()}.md`]: '# Just a body\n\nNo frontmatter here.\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe('# Just a body\n\nNo frontmatter here.\n');
  });

  it('returns frontmatter: {} for an empty frontmatter block', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
      [`Daily/${todayBasename()}.md`]: '---\n---\n# hi\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe('# hi\n');
  });

  it('resolves a custom folder from config', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Journal","format":"YYYY-MM-DD"}',
      [`Journal/${todayBasename()}.md`]: '# Journal entry\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result.path).toBe(`Journal/${todayBasename()}.md`);
    expect(result.content).toBe('# Journal entry\n');
  });

  it('defaults to YYYY-MM-DD format when format is absent from config', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily"}',
      [`Daily/${todayBasename()}.md`]: '# No format specified\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result.path).toBe(`Daily/${todayBasename()}.md`);
    expect(result.content).toBe('# No format specified\n');
  });

  it('fails DAILY_NOTES_NOT_CONFIGURED when folder is empty/blank', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"   "}',
    });
    const provider = makeProvider(root);

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
    });
  });

  it('rejects a folder that escapes the vault instead of reading outside it', async () => {
    // Repro from review: a traversal `folder` must not resolve to a file
    // outside the vault root. Plant the target so a successful read would be
    // a real escape, then assert it is refused as a config error.
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"../outside","format":"[secret]"}',
    });
    const provider = makeProvider(root);

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
      details: { folder: '../outside' },
    });
  });

  it('fails DAILY_NOTES_NOT_CONFIGURED when config is malformed JSON', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{oops',
    });
    const provider = makeProvider(root);

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
    });
  });

  it('resolves a folder-splitting format (YYYY/MM) via local date parts', async () => {
    const now = new Date();
    const yyyy = String(now.getFullYear()).padStart(4, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const expectedPath = `Daily/${yyyy}/${mm}/${yyyy}-${mm}-${dd}.md`;

    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY/MM/YYYY-MM-DD"}',
      [expectedPath]: '# split folder note\n',
    });
    const provider = makeProvider(root);

    const result = await provider.readDaily();

    expect(result.path).toBe(expectedPath);
    expect(result.content).toBe('# split folder note\n');
  });
});
