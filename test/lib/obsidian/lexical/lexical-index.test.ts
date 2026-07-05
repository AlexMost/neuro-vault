import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../../../src/lib/obsidian/vault-reader.js';
import { LexicalIndex } from '../../../../src/lib/obsidian/lexical/lexical-index.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-index-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const full = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

function makeIndex() {
  return new LexicalIndex({ vaultRoot, reader: new FsVaultReader({ vaultRoot }) });
}

const searchOpts = { noteCap: 10, perNoteCap: 3, getBacklinkCount: () => 0 };

describe('LexicalIndex', () => {
  it('finds matches across title, heading, and body', async () => {
    await write('Пошук.md', '');
    await write('other.md', '# пошук\n\nтіло без збігу.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['Пошук.md', 'other.md']);
  });

  it('skips frontmatter (body matching starts after it) but keeps line numbers file-relative', async () => {
    await write('fm.md', '---\ntype: task\n---\n\nтут пошук.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.matches[0]!.lines).toEqual([5, 5]);
  });

  it('does not match frontmatter content', async () => {
    await write('fm-only.md', '---\ntitle: пошук\n---\n\nінший текст.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(0);
  });

  it('sees edits on the next call (mtime cache invalidation)', async () => {
    await write('n.md', 'старий текст.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['гібридний'], ...searchOpts })).notes).toHaveLength(0);
    // ensure a distinct mtime even on coarse filesystems
    await new Promise((r) => globalThis.setTimeout(r, 20));
    await write('n.md', 'тут гібридний тест.\n');
    const { notes } = await idx.search({ queries: ['гібридний'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['n.md']);
  });

  it('drops deleted notes', async () => {
    await write('gone.md', 'пошук тут.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(1);
    await fs.rm(path.join(vaultRoot, 'gone.md'));
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(0);
  });

  it('respects the allowed pre-filter set', async () => {
    await write('Tasks/a.md', 'пошук в tasks.\n');
    await write('Archive/b.md', 'пошук в archive.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({
      queries: ['пошук'],
      allowed: new Set(['Tasks/a.md']),
      ...searchOpts,
    });
    expect(notes.map((n) => n.path)).toEqual(['Tasks/a.md']);
  });
});
