import type { NoteStructure } from '../../lib/obsidian/corpus/note-structure.js';
import type { OutlineEntry } from './types.js';

/**
 * The heading blocks whose heading line lies inside `span`, in source order, each with
 * its true span — never clipped to `span`. A note with no body (`null`) has none.
 */
export function entriesWithin(
  structure: NoteStructure,
  span: [number, number] | null,
): OutlineEntry[] {
  if (span === null) return [];
  const [start, end] = span;
  return structure.headings
    .filter((h) => h.lines[0] >= start && h.lines[0] <= end)
    .map((h) => ({ heading: h.heading, level: h.level, lines: [h.lines[0], h.lines[1]] }));
}

/** The most heading blocks an outline lists before it collapses by depth. */
export const OUTLINE_ENTRY_CAP = 100;

const contains = (outer: OutlineEntry, inner: OutlineEntry): boolean =>
  outer.lines[0] < inner.lines[0] && inner.lines[1] <= outer.lines[1];

/**
 * Collapses a large outline by nesting depth. `entries` are in source order. An entry's depth
 * is the number of other entries whose span contains it. While more than
 * {@link OUTLINE_ENTRY_CAP} entries remain and more than one depth is left, every entry at the
 * deepest remaining depth is dropped; the shallowest depth is never dropped. Each dropped entry
 * counts toward `hidden` of its nearest kept ancestor only. Returns new entries; the input is
 * left untouched.
 */
export function collapseOutline(entries: OutlineEntry[]): {
  outline: OutlineEntry[];
  collapsed: boolean;
} {
  const open: OutlineEntry[] = [];
  const depths = entries.map((entry) => {
    while (open.length > 0 && !contains(open[open.length - 1], entry)) open.pop();
    open.push(entry);
    return open.length - 1;
  });

  let maxDepth = depths.reduce((m, d) => Math.max(m, d), -1);
  const minDepth = depths.reduce((m, d) => Math.min(m, d), Infinity);
  let kept = entries.length;
  while (kept > OUTLINE_ENTRY_CAP && maxDepth > minDepth) {
    kept -= depths.filter((d) => d === maxDepth).length;
    maxDepth -= 1;
  }

  const outline: OutlineEntry[] = [];
  const keptOpen: OutlineEntry[] = [];
  entries.forEach((entry, i) => {
    while (keptOpen.length > 0 && !contains(keptOpen[keptOpen.length - 1], entry)) keptOpen.pop();
    if (depths[i] <= maxDepth) {
      const copy: OutlineEntry = { ...entry, lines: [entry.lines[0], entry.lines[1]] };
      outline.push(copy);
      keptOpen.push(copy);
      return;
    }
    // Depth 0 is always kept and nests every deeper entry, so a dropped entry always has an owner.
    const owner = keptOpen[keptOpen.length - 1];
    if (owner === undefined)
      throw new Error('collapseOutline: a dropped entry has no kept ancestor');
    owner.hidden = (owner.hidden ?? 0) + 1;
  });

  return { outline, collapsed: outline.length < entries.length };
}
