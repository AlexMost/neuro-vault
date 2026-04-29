import { describe, expect, it, vi } from 'vitest';

import { buildBasenameIndex } from '../../../src/lib/obsidian/link-resolver.js';
import { getNoteLinks } from '../../../src/lib/obsidian/note-links.js';

const VAULT_PATHS = ['Folder/A.md', 'Folder/B.md', 'Folder/C.md', 'Folder/D.md', 'Folder/Sub/E.md'];

function makeIndex() {
  return buildBasenameIndex(VAULT_PATHS);
}

describe('getNoteLinks', () => {
  it('extracts forward links from the body', async () => {
    const readNoteContent = vi.fn(async () => '# A\n\nSee [[B]] and [[C]].\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links].sort()).toEqual(['Folder/B.md', 'Folder/C.md']);
    expect(readNoteContent).toHaveBeenCalledWith('Folder/A.md');
  });

  it('extracts forward links from frontmatter values', async () => {
    const readNoteContent = vi.fn(async () => '---\nrelated: "[[D]]"\n---\nNo body links.\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/D.md']);
  });

  it('combines body and frontmatter links, deduplicated', async () => {
    const readNoteContent = vi.fn(
      async () => '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\nAlso see [[B]] inline.\n',
    );
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links].sort()).toEqual(['Folder/B.md', 'Folder/C.md']);
  });

  it('drops self-references', async () => {
    const readNoteContent = vi.fn(async () => '# A\n\n[[A]] [[B]]\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/B.md']);
  });

  it('drops unresolved targets silently', async () => {
    const readNoteContent = vi.fn(async () => '# A\n\n[[Nonexistent]] but [[B]] is here\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/B.md']);
  });

  it('returns an empty set when the note has no links', async () => {
    const readNoteContent = vi.fn(async () => '# A\n\nplain text\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect(links.size).toBe(0);
  });

  it('returns an empty set when the note is empty', async () => {
    const readNoteContent = vi.fn(async () => '');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect(links.size).toBe(0);
  });

  it('strips heading and alias suffixes from wikilink targets', async () => {
    const readNoteContent = vi.fn(async () => '[[B#Section]] [[C|alias]]\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links].sort()).toEqual(['Folder/B.md', 'Folder/C.md']);
  });

  it('resolves path-form targets exactly', async () => {
    const readNoteContent = vi.fn(async () => '[[Folder/Sub/E]]\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/Sub/E.md']);
  });

  it('treats embeds ![[X]] as forward links', async () => {
    const readNoteContent = vi.fn(async () => '![[B]]\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/B.md']);
  });

  it('propagates read errors to the caller', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const readNoteContent = vi.fn(async () => {
      throw enoent;
    });
    await expect(
      getNoteLinks({
        notePath: 'Folder/A.md',
        readNoteContent,
        basenameIndex: makeIndex(),
      }),
    ).rejects.toBe(enoent);
  });

  it('continues with body when frontmatter parsing fails', async () => {
    // splitFrontmatter returns frontmatter: null on parse failure and the raw
    // input as content — verify body links still resolve.
    const readNoteContent = vi.fn(async () => '---\n: invalid yaml :\n---\n[[B]]\n');
    const links = await getNoteLinks({
      notePath: 'Folder/A.md',
      readNoteContent,
      basenameIndex: makeIndex(),
    });
    expect([...links]).toEqual(['Folder/B.md']);
  });
});
