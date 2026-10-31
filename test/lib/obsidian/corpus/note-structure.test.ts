import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { chunkNote } from '../../../../src/lib/obsidian/corpus/chunker.js';
import { noteStructure } from '../../../../src/lib/obsidian/corpus/note-structure.js';

const names = (raw: string) => noteStructure(raw).headings.map((h) => h.heading);

describe('noteStructure', () => {
  const FIXTURE = '---\na: 1\n---\n\nintro\n# Top\n## Inner\nx\n';

  it('projects frontmatter, body, preamble and heading blocks', () => {
    const s = noteStructure(FIXTURE);
    expect(s.lines).toEqual(['---', 'a: 1', '---', '', 'intro', '# Top', '## Inner', 'x']);
    expect(s.frontmatterEnd).toBe(3);
    expect(s.body).toEqual([4, 8]);
    expect(s.preamble).toEqual([4, 5]);
    expect(s.headings).toEqual([
      { heading: 'Top', level: 1, lines: [6, 8] },
      { heading: 'Inner', level: 2, lines: [7, 8] },
    ]);
  });

  it('disambiguates repeated sibling headings the way the chunker does', () => {
    expect(names('# P\n## Notes\na\n## Notes\nb\n')).toEqual(['P', 'Notes', 'Notes[2]']);
  });

  it('keeps a disambiguated name clear of a heading literally titled with the suffix', () => {
    expect(names('# A\n# A[2]\n# A\n')).toEqual(['A', 'A[2]', 'A[3]']);
  });

  it.each([
    ['a list item', '- # in a list\n'],
    ['a blockquote', '> # quoted\n'],
    ['a code fence', '```\n# fenced\n```\n'],
    ['a setext heading', 'Title\n=====\n\nSub\n---\n'],
  ])('produces no entry for a heading inside %s', (_label, raw) => {
    expect(noteStructure(raw).headings).toEqual([]);
  });

  it('reports a headless note as preamble only', () => {
    const s = noteStructure('just text\nmore\n');
    expect(s.headings).toEqual([]);
    expect(s.body).toEqual([1, 2]);
    expect(s.preamble).toEqual(s.body);
  });

  it('has no preamble for a headless note whose body is blank', () => {
    const s = noteStructure('\n\n  \n');
    expect(s.body).toEqual([1, 3]);
    expect(s.preamble).toBeNull();
  });

  it('has no preamble when a heading opens the body', () => {
    expect(noteStructure('# A\nx\n').preamble).toBeNull();
  });

  it('has no body for a frontmatter-only note', () => {
    const s = noteStructure('---\na: 1\n---\n');
    expect(s.frontmatterEnd).toBe(3);
    expect(s.body).toBeNull();
    expect(s.preamble).toBeNull();
    expect(s.headings).toEqual([]);
  });

  it('gives an empty note one blank line and no preamble', () => {
    const s = noteStructure('');
    expect(s.lines).toEqual(['']);
    expect(s.body).toEqual([1, 1]);
    expect(s.preamble).toBeNull();
  });

  it('gives CRLF notes the LF spans and heading names, with no carriage return', () => {
    const crlf = noteStructure(FIXTURE.replaceAll('\n', '\r\n'));
    const lf = noteStructure(FIXTURE);
    expect(crlf.headings).toEqual(lf.headings);
    expect(crlf.frontmatterEnd).toBe(lf.frontmatterEnd);
    expect(crlf.body).toEqual(lf.body);
    expect(crlf.preamble).toEqual(lf.preamble);
    for (const h of crlf.headings) expect(h.heading).not.toContain('\r');
  });

  describe('parity with chunkNote', () => {
    const sample = readFileSync(new URL('./fixtures/sample-note.md', import.meta.url), 'utf8');
    const inputs: Array<[string, string]> = [
      ['the sample fixture', sample],
      ['the projection fixture', FIXTURE],
      ['repeated and nested headings', '# P\n## Notes\na\n\nb\n## Notes\nc\n### Deep\nd\n'],
      ['a note without a trailing newline', '# A\nx\n## B\ny'],
    ];

    it.each(inputs)('matches the heading blocks of %s', (_name, raw) => {
      const blocks = chunkNote(raw).filter(
        (b) => b.heading !== '' && b.heading !== '---frontmatter---',
      );
      const entries = noteStructure(raw).headings;
      expect(entries).toHaveLength(blocks.length);
      expect(entries.map((e) => ({ heading: e.heading, lines: e.lines }))).toEqual(
        blocks.map((b) => ({ heading: b.heading, lines: b.lines })),
      );
    });
  });
});
