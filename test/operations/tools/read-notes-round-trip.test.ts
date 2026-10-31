import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { chunkNote } from '../../../src/lib/obsidian/corpus/chunker.js';
import { MIN_CHARS } from '../../../src/lib/obsidian/corpus/types.js';
import { parseNote } from '../../../src/lib/obsidian/lexical/blocks.js';
import { LexicalIndex } from '../../../src/lib/obsidian/lexical/lexical-index.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { buildReadNotesTool } from '../../../src/modules/operations/tools/read-notes.js';
import type {
  ReadNotesResult,
  ReadNotesResultItemSuccess,
} from '../../../src/modules/operations/types.js';
import { callTool } from '../../_gate.js';
import { readerOverFiles } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

type ReadNotesOut = { vault: string } & ReadNotesResult;

/**
 * A note with long frontmatter (so the chunker's `---frontmatter---` block is embedded),
 * a non-blank preamble, a `## Decisions` block, a heading directly owning two paragraphs
 * (so `#{n}` sub-blocks exist), and a repeated sibling heading.
 */
const NOTE = [
  '---',
  'title: Round trip fixture',
  'status: active',
  'summary: >-',
  '  A fixture note whose frontmatter is long enough for the chunker to embed it as its own',
  '  block, so a search can return the frontmatter block as evidence for this note.',
  'tags: [fixture, round-trip]',
  '---',
  'Preamble paragraph before any heading.',
  '',
  '# Project log',
  'Intro under the title.',
  '',
  '## Decisions',
  'Keep the reader verbatim.',
  '- first item',
  '- second item',
  '',
  '## **Open** work',
  'First own paragraph.',
  '',
  'Second own paragraph,',
  'on two lines.',
  '',
  '### Next steps',
  'A nested paragraph.',
  '',
  '## Notes',
  'one',
  '## Notes',
  'two',
].join('\n');
const FILE = NOTE + '\n';
const CRLF_FILE = NOTE.replace(/\n/g, '\r\n') + '\r\n';
const FRONTMATTER_HEADING = '---frontmatter---';
/** The fixture's frontmatter as the reader parses it. */
const FRONTMATTER = {
  title: 'Round trip fixture',
  status: 'active',
  summary:
    'A fixture note whose frontmatter is long enough for the chunker to embed it as its own block, so a search can return the frontmatter block as evidence for this note.',
  tags: ['fixture', 'round-trip'],
};

function read(files: Record<string, string>, args: Record<string, unknown>) {
  const reader = readerOverFiles(files);
  const reg = registerTool(
    buildReadNotesTool({ registry: makeTestRegistry([{ name: 'v', reader }]) }),
  );
  return callTool<ReadNotesOut>(reg, args);
}

const blocks = chunkNote(FILE);
const bodyBlocks = blocks.filter((b) => b.heading !== FRONTMATTER_HEADING);
const namedBlocks = bodyBlocks.filter((b) => b.heading !== '');

describe('the round-trip fixture', () => {
  it('chunks into a frontmatter block, a preamble, heading blocks and #{n} sub-blocks', () => {
    expect(blocks.map((b) => [b.key, b.lines])).toStrictEqual([
      ['#---frontmatter---', [1, 8]],
      ['#', [9, 10]],
      ['#Project log', [11, 31]],
      ['#Project log#Decisions', [14, 18]],
      ['#Project log#**Open** work', [19, 27]],
      ['#Project log#**Open** work#{1}', [20, 20]],
      ['#Project log#**Open** work#{2}', [22, 23]],
      ['#Project log#**Open** work#Next steps', [25, 27]],
      ['#Project log#Notes', [28, 29]],
      ['#Project log#Notes[2]', [30, 31]],
    ]);
    expect(blocks[0].text.length).toBeGreaterThanOrEqual(MIN_CHARS);
  });
});

describe('a search hit reads back through its lines', () => {
  it.each(bodyBlocks.map((b) => [b.key, b] as const))(
    'semantic block %s read as { path, lines } returns exactly its text',
    async (_key, block) => {
      const result = await read(
        { 'n.md': FILE },
        { paths: [{ path: 'n.md', lines: block.lines }] },
      );

      const item = result.results[0] as ReadNotesResultItemSuccess;
      expect(item.content).toBe(block.text);
      expect(item.lines).toStrictEqual(block.lines);
    },
  );

  it.each(
    chunkNote(CRLF_FILE)
      .filter((b) => b.heading !== FRONTMATTER_HEADING)
      .map((b) => [b.key, b] as const),
  )('CRLF block %s returns its text without the trailing \\r', async (_key, block) => {
    const result = await read(
      { 'n.md': CRLF_FILE },
      { paths: [{ path: 'n.md', lines: block.lines }] },
    );

    const item = result.results[0] as ReadNotesResultItemSuccess;
    expect(item.content).toBe(block.text.replace(/\r$/, ''));
    expect(item.lines).toStrictEqual(block.lines);
  });

  it.each(namedBlocks.map((b) => [b.heading, b] as const))(
    'heading block %j reads the same by name as by its lines',
    async (_heading, block) => {
      const result = await read(
        { 'n.md': FILE },
        { paths: [{ path: 'n.md', heading: block.heading }] },
      );

      expect(result.results[0]).toMatchObject({
        content: block.text,
        lines: block.lines,
        heading: block.heading,
      });
    },
  );

  describe('the frontmatter block', () => {
    const fm = blocks[0];

    it('read as { path, lines } is a LINES_OUT_OF_RANGE miss pointing at a frontmatter read', async () => {
      const result = await read({ 'n.md': FILE }, { paths: [{ path: 'n.md', lines: fm.lines }] });

      expect(fm.heading).toBe(FRONTMATTER_HEADING);
      expect(result.results).toStrictEqual([
        {
          path: 'n.md',
          error: {
            code: 'LINES_OUT_OF_RANGE',
            message:
              "lines 1–8 of n.md lie in the frontmatter (body: lines 9–31); read the frontmatter with content: 'frontmatter', or a range inside the body",
          },
          lines: [9, 31],
        },
      ]);
    });

    it("hands off as content: 'frontmatter' on the bare path", async () => {
      const result = await read({ 'n.md': FILE }, { paths: 'n.md', content: 'frontmatter' });

      expect(result.results).toStrictEqual([
        {
          path: 'n.md',
          frontmatter: FRONTMATTER,
        },
      ]);
    });
  });

  it('an unclosed fence: the lexical unit ends one past the last line, and the read clips it', async () => {
    const raw = '# A\n```\ncode\n';
    const unit = parseNote({ path: 'f.md', body: raw, lineOffset: 0 }).units.find(
      (u) => u.kind === 'body',
    );
    expect(unit?.lines).toStrictEqual([2, 4]);
    if (unit === undefined) return;

    const result = await read({ 'f.md': raw }, { paths: [{ path: 'f.md', lines: unit.lines }] });

    expect(result.results).toStrictEqual([
      { path: 'f.md', frontmatter: null, content: '```\ncode', lines: [2, 3] },
    ]);
    expect((result.results[0] as ReadNotesResultItemSuccess).content).toContain(unit.raw);
  });

  it("a lexical body match's lines, past the frontmatter, read back its matched text", async () => {
    const files = { 'n.md': FILE };
    const byAbs = new Map(Object.entries(files).map(([p, t]) => [path.join('/vault', p), t]));
    const index = new LexicalIndex({
      vaultRoot: '/vault',
      reader: readerOverFiles(files),
      stat: () => Promise.resolve({ mtimeMs: 1 }),
      readFile: (abs) => Promise.resolve(byAbs.get(abs) ?? ''),
    });
    // The query, the match's lines, and the text the read returns for them. The matched unit
    // is the whole text, except a list item's, which the source writes after its marker.
    const cases: [string, [number, number], string][] = [
      ['Preamble', [9, 9], 'Preamble paragraph before any heading.'],
      ['verbatim', [15, 15], 'Keep the reader verbatim.'],
      ['second item', [17, 17], '- second item'],
      ['on two lines', [22, 23], 'Second own paragraph,\non two lines.'],
      ['nested paragraph', [26, 26], 'A nested paragraph.'],
    ];

    for (const [query, lines, text] of cases) {
      const { notes } = await index.search({
        queries: [query],
        noteCap: 10,
        perNoteCap: 10,
        getBacklinkCount: () => 0,
      });
      const [match] = notes[0].matches;
      expect(match).toMatchObject({ matched_in: 'body', lines });

      const result = await read(files, { paths: [{ path: 'n.md', lines: match.lines }] });

      expect(result.results).toStrictEqual([
        { path: 'n.md', frontmatter: FRONTMATTER, content: text, lines },
      ]);
      // A unit shorter than the snippet window comes back whole, so the read contains it.
      expect(match.snippet).not.toContain('…');
      expect(text).toContain(match.snippet);
    }
  });
});
