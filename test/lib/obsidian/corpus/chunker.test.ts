import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { chunkNote } from '../../../../src/lib/obsidian/corpus/chunker.js';

const keys = (content: string) => chunkNote(content).map((b) => b.key);
const byKey = (content: string, key: string) => chunkNote(content).find((b) => b.key === key);

describe('chunkNote', () => {
  it('splits at headings and gives a parent the whole section', () => {
    const content = ['# Top', 'alpha', '## Inner', 'beta'].join('\n');
    expect(keys(content)).toEqual(expect.arrayContaining(['#Top', '#Top#Inner']));
    expect(byKey(content, '#Top')?.lines).toEqual([1, 4]);
    expect(byKey(content, '#Top#Inner')?.lines).toEqual([3, 4]);
    expect(byKey(content, '#Top')?.heading).toBe('Top');
    expect(byKey(content, '#Top')?.text).toBe(content);
    expect(byKey(content, '#Top#Inner')?.heading).toBe('Inner');
    expect(byKey(content, '#Top#Inner')?.text).toBe('## Inner\nbeta');
  });

  it('ignores headings inside code fences', () => {
    const content = ['# Top', '```', '# not a heading', '```', 'tail'].join('\n');
    expect(keys(content)).toEqual(['#Top']);
    expect(byKey(content, '#Top')?.lines).toEqual([1, 5]);
  });

  it('does not let a fenced "#" in the preamble end the preamble early', () => {
    // The preamble scan and the heading loop must agree about fences: if only the
    // loop knows, the lines between the fence and the real heading fall in no block.
    const content = [
      '---',
      'a: 1',
      '---',
      'Intro paragraph',
      '```',
      '# not a heading',
      '```',
      '# Real Heading',
      'body',
    ].join('\n');
    expect(keys(content)).toEqual(['#---frontmatter---', '#', '#Real Heading']);
    expect(byKey(content, '#')?.lines).toEqual([4, 7]);
    expect(byKey(content, '#Real Heading')?.lines).toEqual([8, 9]);
    // Every line 1..9 is covered by some block.
    const covered = new Set<number>();
    for (const b of chunkNote(content)) {
      for (let n = b.lines[0]; n <= b.lines[1]; n += 1) covered.add(n);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps a section unbroken when a fence between two headings contains "#"', () => {
    const content = ['# A', '```', '# fake', '```', '# B', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A', '#B']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 4]);
    expect(byKey(content, '#B')?.lines).toEqual([5, 6]);
  });

  it('takes heading from the heading text, not by splitting the key on "#"', () => {
    const content = ['# C# notes', 'body'].join('\n');
    expect(byKey(content, '#C# notes')?.heading).toBe('C# notes');
  });

  it('encodes a skipped heading level in the separator', () => {
    const content = ['# Top', '### Deep', 'x'].join('\n');
    expect(keys(content)).toContain('#Top##Deep');
  });

  it('suffixes a repeated top-level heading', () => {
    const content = ['# Top', 'a', '# Top', 'b'].join('\n');
    expect(keys(content)).toEqual(['#Top', '#Top[2]']);
  });

  it('disambiguates repeated sibling sub-headings too', () => {
    // Block keys are identity in the corpus; a collision silently drops a block.
    const content = ['# Top', '## A', 'x', '## A', 'y'].join('\n');
    const all = keys(content);
    expect(all).toContain('#Top#A');
    expect(all).toContain('#Top#A[2]');
    expect(new Set(all).size).toBe(all.length);
  });

  it('emits frontmatter and preamble blocks', () => {
    const content = ['---', 'type: note', '---', 'intro text', '# Top', 'body'].join('\n');
    expect(keys(content)).toEqual(['#---frontmatter---', '#', '#Top']);
    expect(byKey(content, '#---frontmatter---')?.lines).toEqual([1, 3]);
    expect(byKey(content, '#')?.lines).toEqual([4, 4]);
    // heading contract (see ChunkedBlock in types.ts): the frontmatter block carries
    // "---frontmatter---"; the preamble block carries "".
    expect(byKey(content, '#---frontmatter---')?.heading).toBe('---frontmatter---');
    expect(byKey(content, '#')?.heading).toBe('');
    expect(byKey(content, '#---frontmatter---')?.text).toBe('---\ntype: note\n---');
  });

  it('emits no preamble block when a heading opens the note', () => {
    expect(keys('# Top\nbody')).toEqual(['#Top']);
  });

  it('numbers content chunks under a heading', () => {
    const content = ['# Top', 'para one', '', 'para two', '## Inner', 'x'].join('\n');
    expect(keys(content)).toEqual(['#Top', '#Top#{1}', '#Top#{2}', '#Top#Inner']);
    expect(byKey(content, '#Top#{1}')?.lines).toEqual([2, 2]);
    expect(byKey(content, '#Top#{2}')?.lines).toEqual([4, 4]);
  });

  it('matches the golden chunking of the sample note', () => {
    const content = readFileSync(new URL('./fixtures/sample-note.md', import.meta.url), 'utf8');
    expect(chunkNote(content).map((b) => ({ key: b.key, heading: b.heading, lines: b.lines })))
      .toMatchInlineSnapshot(`
      [
        {
          "heading": "---frontmatter---",
          "key": "#---frontmatter---",
          "lines": [
            1,
            3,
          ],
        },
        {
          "heading": "",
          "key": "#",
          "lines": [
            4,
            5,
          ],
        },
        {
          "heading": "Top",
          "key": "#Top",
          "lines": [
            6,
            18,
          ],
        },
        {
          "heading": "",
          "key": "#Top#{1}",
          "lines": [
            8,
            8,
          ],
        },
        {
          "heading": "",
          "key": "#Top#{2}",
          "lines": [
            10,
            10,
          ],
        },
        {
          "heading": "Inner",
          "key": "#Top#Inner",
          "lines": [
            12,
            18,
          ],
        },
        {
          "heading": "",
          "key": "#Top#Inner#{1}",
          "lines": [
            14,
            16,
          ],
        },
        {
          "heading": "",
          "key": "#Top#Inner#{2}",
          "lines": [
            18,
            18,
          ],
        },
      ]
    `);
  });
});
