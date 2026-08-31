import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listTags } from '../../../src/lib/obsidian/vault-aggregates.js';
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

describe('listTags over a real FsVaultReader (disk)', () => {
  it('counts frontmatter and inline #tags together', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha, beta]\n---\nbody #inline\n',
      'b.md': '---\ntags: alpha\n---\n',
      'c.md': 'no frontmatter #beta\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 2 },
      { name: 'inline', count: 1 },
    ]);
  });

  it('returns [] for a vault with no frontmatter and no inline tags', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([]);
  });

  it('counts a scalar single tag once', async () => {
    const root = await makeVault({ 'a.md': '---\ntags: solo\n---\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'solo', count: 1 }]);
  });

  it('strips a leading # from a frontmatter tag value', async () => {
    const root = await makeVault({ 'a.md': "---\ntags: ['#alpha']\n---\n" });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('an empty tag list contributes nothing', async () => {
    const root = await makeVault({ 'a.md': '---\ntags: []\n---\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([]);
  });

  it('sort tie-break: equal counts sort by name ascending', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [zebra]\n---\n',
      'b.md': '---\ntags: [zebra]\n---\n',
      'c.md': '---\ntags: [apple]\n---\n',
      'd.md': '---\ntags: [apple]\n---\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([
      { name: 'apple', count: 2 },
      { name: 'zebra', count: 2 },
    ]);
  });

  it('sorts by count descending before falling back to name', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [zebra]\n---\n',
      'b.md': '---\ntags: [apple]\n---\n',
      'c.md': '---\ntags: [apple]\n---\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([
      { name: 'apple', count: 2 },
      { name: 'zebra', count: 1 },
    ]);
  });

  it('a note whose tags key is absent contributes no tags', async () => {
    const root = await makeVault({ 'a.md': '---\nstatus: x\n---\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([]);
  });

  it('returns [] for an empty vault', async () => {
    const root = await makeVault({});
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([]);
  });

  it('aggregates a tag spread across many notes', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha]\n---\n',
      'b.md': '---\ntags: [alpha]\n---\n',
      'c.md': '---\ntags: [alpha, beta]\n---\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([
      { name: 'alpha', count: 3 },
      { name: 'beta', count: 1 },
    ]);
  });

  it('scans nested folders', async () => {
    const root = await makeVault({
      'Deep/Nested/n.md': '---\ntags: [buried]\n---\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'buried', count: 1 }]);
  });

  it('counts a tag once per note when it appears in frontmatter and body', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [gamma]\n---\n#gamma again #gamma\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'gamma', count: 1 }]);
  });

  it('counts duplicated frontmatter entries once per note', async () => {
    const root = await makeVault({ 'a.md': '---\ntags: [alpha, alpha]\n---\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('excludes code, URL fragments, heading markers, and numeric pseudo-tags', async () => {
    const root = await makeVault({
      'a.md':
        '## Heading\n\nsee https://example.com/#section and #123\n\n```\n#fenced\n```\n\n`#inline` but #real\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'real', count: 1 }]);
  });

  it('counts nested inline tags verbatim', async () => {
    const root = await makeVault({ 'a.md': 'work #project/alpha\n' });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'project/alpha', count: 1 }]);
  });

  it('broken frontmatter: body scan sees the raw file (pinned edge, design D5)', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [unclosed\n---\nbody #real\n',
    });
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'real', count: 1 }]);
  });

  it('scans more notes than one read batch', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) files[`n${String(i).padStart(2, '0')}.md`] = 'note #bulk\n';
    const root = await makeVault(files);
    const reader = readerOver(root);

    expect(await listTags(reader)).toEqual([{ name: 'bulk', count: 40 }]);
  });
});
