import { describe, expect, it } from 'vitest';

import { listProperties, listTags } from '../../../src/lib/obsidian/vault-aggregates.js';
import type { ReadNotesItem, VaultReader } from '../../../src/lib/obsidian/vault-reader.js';

/**
 * A reader over an in-memory note map. Aggregation semantics that do not depend
 * on YAML parsing or disk layout are pinned here; the disk-level cases live in
 * `vault-aggregates-disk.test.ts` against a real `FsVaultReader`.
 */
function readerOver(
  notes: Record<string, { frontmatter?: Record<string, unknown>; content?: string }>,
): VaultReader {
  return {
    scan: async () => Object.keys(notes),
    readNotes: async ({ paths }) =>
      paths.map(
        (p): ReadNotesItem => ({
          path: p,
          frontmatter: notes[p]?.frontmatter ?? {},
          content: notes[p]?.content ?? '',
        }),
      ),
  };
}

/** A reader whose every note comes back as a per-item read error. */
function failingReader(paths: string[]): VaultReader {
  return {
    scan: async () => paths,
    readNotes: async (input) =>
      input.paths.map(
        (p): ReadNotesItem => ({
          path: p,
          error: { code: 'READ_FAILED', message: 'boom' },
        }),
      ),
  };
}

describe('listTags', () => {
  it('counts frontmatter tags across notes', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['alpha'] } },
      'b.md': { frontmatter: { tags: ['alpha'] } },
      'c.md': { frontmatter: { tags: ['alpha'] } },
    });

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 3 }]);
  });

  it('counts inline body tags', async () => {
    const reader = readerOver({ 'a.md': { content: 'text #beta more' } });

    expect(await listTags(reader)).toEqual([{ name: 'beta', count: 1 }]);
  });

  it('counts a tag once per note even when it appears in both places', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['gamma'] }, content: '#gamma and #gamma again' },
    });

    expect(await listTags(reader)).toEqual([{ name: 'gamma', count: 1 }]);
  });

  it('counts duplicated frontmatter entries once', async () => {
    const reader = readerOver({ 'a.md': { frontmatter: { tags: ['alpha', 'alpha'] } } });

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('excludes non-tag # sequences', async () => {
    const reader = readerOver({
      'a.md': {
        content: '#123\n```\n#fenced\n```\n`#inline`\nhttps://e.com/#section\n## Heading\n',
      },
    });

    expect(await listTags(reader)).toEqual([]);
  });

  it('counts nested tags verbatim', async () => {
    const reader = readerOver({ 'a.md': { content: '#project/alpha' } });

    expect(await listTags(reader)).toEqual([{ name: 'project/alpha', count: 1 }]);
  });

  it('sorts by count desc then name asc', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['zeta', 'alpha'] } },
      'b.md': { frontmatter: { tags: ['alpha'] } },
      'c.md': { frontmatter: { tags: ['beta'] } },
    });

    expect(await listTags(reader)).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 1 },
      { name: 'zeta', count: 1 },
    ]);
  });

  it('counts nothing for a vault the reader scans as empty', async () => {
    expect(await listTags(readerOver({}))).toEqual([]);
  });

  it('skips notes the reader returns as read errors', async () => {
    expect(await listTags(failingReader(['a.md', 'b.md']))).toEqual([]);
  });

  it('requests both frontmatter and content from the reader', async () => {
    const seen: string[][] = [];
    const reader: VaultReader = {
      scan: async () => ['a.md'],
      readNotes: async (input) => {
        seen.push([...input.fields]);
        return [{ path: 'a.md', frontmatter: {}, content: '' }];
      },
    };

    await listTags(reader);

    expect(seen).toEqual([['frontmatter', 'content']]);
  });
});

describe('listProperties', () => {
  it('counts frontmatter keys across notes', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { status: 'open', due: '2026-01-01' } },
      'b.md': { frontmatter: { status: 'done' } },
    });

    expect(await listProperties(reader)).toEqual([
      { name: 'status', count: 2 },
      { name: 'due', count: 1 },
    ]);
  });

  it('counts nothing for a vault the reader scans as empty', async () => {
    expect(await listProperties(readerOver({}))).toEqual([]);
  });

  it('skips notes the reader returns as read errors', async () => {
    expect(await listProperties(failingReader(['a.md']))).toEqual([]);
  });

  it('treats a null frontmatter as contributing no keys', async () => {
    const reader: VaultReader = {
      scan: async () => ['a.md'],
      readNotes: async () => [{ path: 'a.md', frontmatter: null, content: '' }],
    };

    expect(await listProperties(reader)).toEqual([]);
  });
});
