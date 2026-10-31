import { frontmatterEnd, headingBlocks, preambleSpan, splitNoteLines } from './chunker.js';

/** One heading block of a note, in the line coordinates search evidence reports. */
export interface HeadingEntry {
  /** The chunker's block heading: the heading text, `[n]` included for a repeat. */
  heading: string;
  /** 1..6. */
  level: number;
  /** 1-based inclusive span of the block. */
  lines: [number, number];
}

export interface NoteStructure {
  /** splitNoteLines(raw) — every line, 1-based index = file line. */
  lines: string[];
  /** Last frontmatter line, 0 when none (the chunker's frontmatterEnd). */
  frontmatterEnd: number;
  /**
   * [frontmatterEnd + 1, lines.length]; null when the note has no line after the
   * frontmatter (an empty note, or frontmatter only). Blank body lines still count.
   */
  body: [number, number] | null;
  /** Text before the first heading, only when non-blank. */
  preamble: [number, number] | null;
  /** Heading blocks in source order: chunker spans and heading names. */
  headings: HeadingEntry[];
}

/**
 * Projects a note's raw text onto the same heading blocks the chunker embeds, without
 * the embedding corpus: the spans and heading names are the ones a search result's
 * evidence cites, because both come from `headingBlocks`.
 */
export function noteStructure(raw: string): NoteStructure {
  const lines = splitNoteLines(raw);
  const fmEnd = frontmatterEnd(raw);
  const blocks = headingBlocks(lines, fmEnd);
  return {
    lines,
    frontmatterEnd: fmEnd,
    // An empty note is `['']` to the line splitter but has no line to read.
    body: raw !== '' && fmEnd < lines.length ? [fmEnd + 1, lines.length] : null,
    preamble: preambleSpan(lines, fmEnd, blocks),
    headings: blocks.map((b) => ({ heading: b.title, level: b.level, lines: [b.start, b.end] })),
  };
}
