import { describe, expect, it } from 'vitest';

import { noteStructure } from '../../src/lib/obsidian/corpus/note-structure.js';
import {
  collapseOutline,
  entriesWithin,
  OUTLINE_ENTRY_CAP,
  preambleWithin,
} from '../../src/modules/operations/outline.js';
import type { OutlineEntry } from '../../src/modules/operations/types.js';

/** A `#` title over `groups` `##` blocks, each holding `perGroup` `###` blocks. */
function titledGroups(groups: number, perGroup: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const size = 1 + perGroup;
  entries.push({ heading: 'Title', level: 1, lines: [1, 1 + groups * size] });
  for (let g = 0; g < groups; g++) {
    const start = 2 + g * size;
    entries.push({ heading: `G${g}`, level: 2, lines: [start, start + perGroup] });
    for (let c = 0; c < perGroup; c++) {
      entries.push({
        heading: `G${g}C${c}`,
        level: 3,
        lines: [start + 1 + c, start + 1 + c],
      });
    }
  }
  return entries;
}

describe('collapseOutline', () => {
  it('collapses the 12 x 10 case to the title and the 12 level-2 entries', () => {
    const entries = titledGroups(12, 10);
    expect(entries).toHaveLength(133);

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(true);
    expect(outline).toHaveLength(13);
    expect(outline[0]).toStrictEqual({ heading: 'Title', level: 1, lines: [1, 133] });
    for (const entry of outline.slice(1)) {
      expect(entry.level).toBe(2);
      expect(entry.hidden).toBe(10);
    }
  });

  it('keeps all 150 top-level headings and reports no collapse', () => {
    const entries: OutlineEntry[] = Array.from({ length: 150 }, (_, i) => ({
      heading: `H${i}`,
      level: 1,
      lines: [i * 2 + 1, i * 2 + 2],
    }));

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(false);
    expect(outline).toStrictEqual(entries);
  });

  it('returns exactly 100 entries unchanged, with no hidden keys', () => {
    const entries = titledGroups(9, 10);
    expect(entries).toHaveLength(OUTLINE_ENTRY_CAP);

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(false);
    expect(outline).toStrictEqual(entries);
    expect(outline.some((e) => 'hidden' in e)).toBe(false);
  });

  it('needs two passes for 60 x (## > ### > ####) and counts both dropped depths', () => {
    const entries: OutlineEntry[] = [];
    for (let g = 0; g < 60; g++) {
      const s = g * 3 + 1;
      entries.push({ heading: `A${g}`, level: 2, lines: [s, s + 2] });
      entries.push({ heading: `B${g}`, level: 3, lines: [s + 1, s + 2] });
      entries.push({ heading: `C${g}`, level: 4, lines: [s + 2, s + 2] });
    }
    expect(entries).toHaveLength(180);

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(true);
    expect(outline).toHaveLength(60);
    expect(outline.every((e) => e.level === 2 && e.hidden === 2)).toBe(true);
  });

  it('never drops the shallowest level, even when it alone exceeds the cap', () => {
    const entries: OutlineEntry[] = [];
    for (let g = 0; g < 120; g++) {
      const s = g * 2 + 1;
      entries.push({ heading: `A${g}`, level: 1, lines: [s, s + 1] });
      entries.push({ heading: `B${g}`, level: 2, lines: [s + 1, s + 1] });
    }

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(true);
    expect(outline).toHaveLength(120);
    expect(outline.every((e) => e.level === 1 && e.hidden === 1)).toBe(true);
  });

  it('measures depth by containment, not by heading level', () => {
    // `# Root` holds 50 x (`### X` > `#### Y`, skipping `##`) and 3 x (`## D` > `### E`), then
    // a childless `## Short`. By containment X and D sit at depth 1, Y and E at depth 2. A depth
    // taken from `level - 1` would put D at 1 but X and E at 2, keeping E and leaving D bare.
    const entries: OutlineEntry[] = [];
    let line = 2;
    for (let i = 0; i < 50; i++, line += 2) {
      entries.push({ heading: `X${i}`, level: 3, lines: [line, line + 1] });
      entries.push({ heading: `Y${i}`, level: 4, lines: [line + 1, line + 1] });
    }
    for (let j = 0; j < 3; j++, line += 2) {
      entries.push({ heading: `D${j}`, level: 2, lines: [line, line + 1] });
      entries.push({ heading: `E${j}`, level: 3, lines: [line + 1, line + 1] });
    }
    entries.push({ heading: 'Short', level: 2, lines: [line, line] });
    entries.unshift({ heading: 'Root', level: 1, lines: [1, line] });
    expect(entries).toHaveLength(108);

    const { outline, collapsed } = collapseOutline(entries);

    expect(collapsed).toBe(true);
    expect(outline.map((e) => e.heading)).toStrictEqual([
      'Root',
      ...Array.from({ length: 50 }, (_, i) => `X${i}`),
      ...Array.from({ length: 3 }, (_, j) => `D${j}`),
      'Short',
    ]);
    expect(outline[0].hidden).toBeUndefined();
    expect(outline.slice(1, 54).every((e) => e.hidden === 1)).toBe(true);
    expect(outline[54].hidden).toBeUndefined();
  });

  it('leaves the input array and its entries untouched', () => {
    const entries = titledGroups(12, 10);
    const snapshot = structuredClone(entries);

    const { outline } = collapseOutline(entries);

    expect(entries).toStrictEqual(snapshot);
    expect(outline[1]).not.toBe(entries[1]);
  });

  it('returns an empty outline for no entries', () => {
    expect(collapseOutline([])).toStrictEqual({ outline: [], collapsed: false });
  });
});

describe('entriesWithin', () => {
  // Lines: 1 `# Top`, 2-19 filler, 20 `## B`, 21-24 filler, 25 `### B1`, 26-45 filler,
  // 46 `## C`, 47-50 filler.
  const lines = ['# Top', ...Array.from({ length: 18 }, (_, i) => `t${i + 2}`), '## B'];
  lines.push(...Array.from({ length: 4 }, (_, i) => `b${i + 21}`), '### B1');
  lines.push(...Array.from({ length: 20 }, (_, i) => `b${i + 26}`), '## C');
  lines.push(...Array.from({ length: 4 }, (_, i) => `c${i + 47}`));
  const structure = noteStructure(lines.join('\n') + '\n');

  it('lists the heading blocks whose heading line lies in the span, with their true spans', () => {
    expect(entriesWithin(structure, [12, 30])).toStrictEqual([
      { heading: 'B', level: 2, lines: [20, 45] },
      { heading: 'B1', level: 3, lines: [25, 45] },
    ]);
  });

  it('includes a heading on either edge of the span', () => {
    expect(entriesWithin(structure, [20, 25]).map((e) => e.heading)).toStrictEqual(['B', 'B1']);
  });

  it('lists nothing for a span holding no heading line, or for a note with no body', () => {
    expect(entriesWithin(structure, [26, 45])).toStrictEqual([]);
    expect(entriesWithin(structure, null)).toStrictEqual([]);
  });
});

describe('preambleWithin', () => {
  // Lines: 1-3 frontmatter, 4 `intro one`, 5 `intro two`, 6 blank, 7 `# Top`, 8 `x`.
  const structure = noteStructure('---\na: 1\n---\nintro one\nintro two\n\n# Top\nx\n');

  it('is the whole preamble over the whole body', () => {
    expect(preambleWithin(structure, structure.body)).toStrictEqual([4, 6]);
  });

  it('is the preamble clipped to the span', () => {
    expect(preambleWithin(structure, [5, 8])).toStrictEqual([5, 6]);
    expect(preambleWithin(structure, [4, 4])).toStrictEqual([4, 4]);
  });

  it('is null when the clipped preamble is blank, or the span misses it', () => {
    expect(preambleWithin(structure, [6, 8])).toBeNull();
    expect(preambleWithin(structure, [7, 8])).toBeNull();
    expect(preambleWithin(structure, null)).toBeNull();
  });

  it('is null for a note with no preamble', () => {
    expect(preambleWithin(noteStructure('# Top\nx\n'), [1, 2])).toBeNull();
  });
});
