import { describe, expect, it } from 'vitest';

import { collapseOutline, OUTLINE_ENTRY_CAP } from '../../src/modules/operations/outline.js';
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
