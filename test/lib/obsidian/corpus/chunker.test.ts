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

// Block detection comes from the CommonMark AST, not line regexes. These are the cases a
// line scanner gets wrong: every one of them silently loses content (lines land in no
// block, so they are never embedded and nothing reports it).
describe('chunkNote block detection (CommonMark)', () => {
  it('reads a ``` line inside a ~~~ fence as fence content', () => {
    const content = ['# A', '~~~', '```', '# fake', '~~~', '# B', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A', '#B']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 5]);
    expect(byKey(content, '#B')?.lines).toEqual([6, 7]);
  });

  it('closes a four-backtick fence only on four backticks', () => {
    const content = ['# A', '````', '```', '# fake', '````', '# B', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A', '#B']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 5]);
    expect(byKey(content, '#B')?.lines).toEqual([6, 7]);
  });

  it('reads four-space-indented code as content, fence-looking lines included', () => {
    const content = ['# A', '    ```', '    # not a heading', 'tail', '# B', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A', '#B']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 4]);
    expect(byKey(content, '#B')?.lines).toEqual([5, 6]);
  });

  // Setext headings were considered and deliberately rejected: extraction splits at ATX
  // headings of levels 1-6, and the AST is used to locate those, not to widen what counts
  // as a heading. These two tests pin that decision.
  it('does not open a block on a setext heading', () => {
    const content = ['Title', '=====', 'body', '# Real', 'x'].join('\n');
    expect(keys(content)).toEqual(['#', '#Real']);
    expect(byKey(content, '#')?.lines).toEqual([1, 3]);
    expect(byKey(content, '#Real')?.lines).toEqual([4, 5]);
  });

  it('does not let a paragraph above a "---" separator open a block', () => {
    // A paragraph directly above `---` is a setext H2 to CommonMark, and writing a
    // separator with no blank line above it is common; the section must stay unbroken.
    const content = ['# Top', 'Sub', '---', 'body'].join('\n');
    expect(keys(content)).toEqual(['#Top']);
    expect(byKey(content, '#Top')?.lines).toEqual([1, 4]);
  });

  it('opens a block on an ATX heading indented up to three spaces', () => {
    const content = ['# A', '   # Three spaces', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A', '#Three spaces']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 1]);
    expect(byKey(content, '#Three spaces')?.lines).toEqual([2, 3]);
    expect(byKey(content, '#Three spaces')?.heading).toBe('Three spaces');
  });

  it('does not open a block for a "#" comment inside frontmatter', () => {
    // Frontmatter is stripped before parsing; parsed as Markdown, its YAML comment
    // would be a heading.
    const content = ['---', '# yaml comment', 'type: note', '---', 'intro', '# Real', 'x'].join(
      '\n',
    );
    expect(keys(content)).toEqual(['#---frontmatter---', '#', '#Real']);
    expect(byKey(content, '#---frontmatter---')?.lines).toEqual([1, 4]);
    expect(byKey(content, '#Real')?.lines).toEqual([6, 7]);
  });

  it('does not open a block for a "#" line inside an HTML block', () => {
    const content = ['# A', '<div>', '# X', '</div>', 'tail'].join('\n');
    expect(keys(content)).toEqual(['#A']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 5]);
  });

  it('folds a section into the block above when an HTML block runs on to it', () => {
    // The likeliest real-vault surprise of the AST swap: an HTML block ends at a blank
    // line, not at its closing tag, so a `## Section` with no blank line above it is
    // HTML content and opens no block. Content is not lost - the enclosing section's
    // span still covers it - but the block count drops.
    const content = ['# Top', '<table>', '<tr><td>x</td></tr>', '</table>', '## Section', 'body'];
    expect(keys(content.join('\n'))).toEqual(['#Top']);
    expect(byKey(content.join('\n'), '#Top')?.lines).toEqual([1, 6]);

    // One blank line before the heading ends the HTML block and restores the boundary.
    const spaced = ['# Top', '<div>', '<p>x</p>', '', '## Section', 'body'].join('\n');
    expect(keys(spaced)).toEqual(['#Top', '#Top#Section']);
    expect(byKey(spaced, '#Top')?.lines).toEqual([1, 6]);
    expect(byKey(spaced, '#Top#Section')?.lines).toEqual([5, 6]);
  });

  it('does not open a block for a heading inside a blockquote or a list item', () => {
    const content = ['# A', '> # Quoted', '- item', '  # In list', 'tail'].join('\n');
    expect(keys(content)).toEqual(['#A']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 5]);
  });

  it('does not open a block for a "#tag" at line start', () => {
    const content = ['# A', '#tag not a heading', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 3]);
  });

  it('does not open a block for an empty ATX heading', () => {
    // "#" alone is a heading to CommonMark; letting it through would mint the key "#",
    // which is the preamble block's key.
    const content = ['# A', '#', 'body'].join('\n');
    expect(keys(content)).toEqual(['#A']);
    expect(byKey(content, '#A')?.lines).toEqual([1, 3]);
  });

  it('keys a heading by its raw source line, not its rendered inline text', () => {
    // nodeText() would render "#Bold title" and eat the closing hash run of "# Title ###";
    // both would change the key of a note the line scanner already handled correctly.
    expect(keys(['# **Bold** title', 'body'].join('\n'))).toEqual(['#**Bold** title']);
    expect(byKey(['# **Bold** title', 'body'].join('\n'), '#**Bold** title')?.heading).toBe(
      '**Bold** title',
    );
    expect(keys(['# Title ###', 'body'].join('\n'))).toEqual(['#Title ###']);
    expect(byKey(['# Title ###', 'body'].join('\n'), '#Title ###')?.heading).toBe('Title ###');
  });
});
