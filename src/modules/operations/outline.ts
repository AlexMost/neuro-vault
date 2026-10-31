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
