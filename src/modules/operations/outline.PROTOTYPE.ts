// PROTOTYPE — throwaway, never merged. Answers "what does read_notes content:'outline' return?"
// (issue 246). Pure functions over a note's raw text; no I/O.

import { chunkNote } from '../../lib/obsidian/corpus/chunker.js';

/** One heading block, as the chunker sees it, plus the level the chunker discards today. */
export interface HeadingEntry {
  heading: string;
  level: number;
  /** Subtree span, file-relative, 1-based inclusive. */
  lines: [number, number];
  /** Own text: heading line up to the first sub-heading − 1. */
  own: [number, number];
  /** Depth in the heading tree (0 = no heading parent), not the `#` count. */
  depth: number;
  chars: number;
}

export interface NoteStructure {
  /** Whole body span (frontmatter excluded): the span every body-returning item echoes. */
  body: [number, number];
  frontmatterLines: [number, number] | null;
  preamble: [number, number] | null;
  entries: HeadingEntry[];
}

/** Level of an ATX heading from its source line (the chunker already knows; it just drops it). */
function levelOf(line: string): number {
  return /^ {0,3}(#{1,6})/.exec(line)?.[1].length ?? 0;
}

export function structureOf(content: string): NoteStructure {
  const lines = content.split('\n');
  // Phantom trailing line fix from 242: a final newline terminates, it does not open a line.
  const last = content.endsWith('\n') ? lines.length - 1 : lines.length;
  const blocks = chunkNote(content);
  const fm = blocks.find((b) => b.key === '#---frontmatter---');
  const pre = blocks.find((b) => b.key === '#');
  const heads = blocks.filter((b) => b.heading !== '' && b.key !== '#---frontmatter---');
  const clamp = (n: number) => Math.min(n, last);

  const stack: { end: number }[] = [];
  const entries: HeadingEntry[] = heads.map((b, i) => {
    while (stack.length > 0 && stack[stack.length - 1].end < b.lines[0]) stack.pop();
    const depth = stack.length;
    stack.push({ end: b.lines[1] });
    const next = heads[i + 1];
    const end = clamp(b.lines[1]);
    const ownEnd = next && next.lines[0] <= b.lines[1] ? next.lines[0] - 1 : end;
    return {
      heading: b.heading,
      level: levelOf(lines[b.lines[0] - 1] ?? ''),
      lines: [b.lines[0], end],
      own: [b.lines[0], ownEnd],
      depth,
      chars: lines.slice(b.lines[0] - 1, end).join('\n').length,
    };
  });

  const bodyStart = fm ? fm.lines[1] + 1 : 1;
  return {
    body: [bodyStart, last],
    frontmatterLines: fm ? [fm.lines[0], fm.lines[1]] : null,
    preamble: pre ? [pre.lines[0], clamp(pre.lines[1])] : null,
    entries,
  };
}

// ---- Candidate result shapes -------------------------------------------------------------

/** A: flat list in source order — heading, level, lines. Preamble as an item field. */
export function flat(s: NoteStructure) {
  return {
    lines: s.body,
    ...(s.preamble ? { preamble: s.preamble } : {}),
    outline: s.entries.map((e) => ({ heading: e.heading, level: e.level, lines: e.lines })),
  };
}

/** B: A plus an explicit own-text span per entry (only when it differs from `lines`). */
export function flatOwn(s: NoteStructure) {
  return {
    lines: s.body,
    ...(s.preamble ? { preamble: s.preamble } : {}),
    outline: s.entries.map((e) => ({
      heading: e.heading,
      level: e.level,
      lines: e.lines,
      ...(e.own[1] !== e.lines[1] ? { own: e.own } : {}),
    })),
  };
}

/** C: nested tree. */
export function tree(s: NoteStructure) {
  type Node = { heading: string; level: number; lines: [number, number]; children?: Node[] };
  const root: Node[] = [];
  const stack: { node: Node; end: number }[] = [];
  for (const e of s.entries) {
    while (stack.length > 0 && stack[stack.length - 1].end < e.lines[0]) stack.pop();
    const node: Node = { heading: e.heading, level: e.level, lines: e.lines };
    const parent = stack[stack.length - 1];
    if (parent) (parent.node.children ??= []).push(node);
    else root.push(node);
    stack.push({ node, end: e.lines[1] });
  }
  return { lines: s.body, ...(s.preamble ? { preamble: s.preamble } : {}), outline: root };
}

/** D: one text block, an indented table of contents. */
export function text(s: NoteStructure) {
  const rows = s.entries.map(
    (e) => `${e.lines[0]}-${e.lines[1]} ${'  '.repeat(e.depth)}${'#'.repeat(e.level)} ${e.heading}`,
  );
  if (s.preamble) rows.unshift(`${s.preamble[0]}-${s.preamble[1]} (preamble)`);
  return { lines: s.body, outline: rows.join('\n') };
}

/** E: positional tuples [level, heading, start, end]. */
export function tuples(s: NoteStructure) {
  return {
    lines: s.body,
    ...(s.preamble ? { preamble: s.preamble } : {}),
    outline: s.entries.map((e) => [e.level, e.heading, e.lines[0], e.lines[1]]),
  };
}

// ---- Large-outline policy -----------------------------------------------------------------

/**
 * Collapse by tree depth until the flat outline fits `budget` bytes: entries deeper than the
 * kept depth are dropped and their parent reports how many sub-headings it hides. If even the
 * top level does not fit, keep the first entries that fit and say how many were cut.
 */
export function flatBudgeted(s: NoteStructure, budget: number) {
  const size = (v: unknown) => JSON.stringify(v).length;
  const maxDepth = Math.max(0, ...s.entries.map((e) => e.depth));
  for (let keep = maxDepth; keep >= 0; keep--) {
    const shown = s.entries.filter((e) => e.depth <= keep);
    const outline = shown.map((e) => {
      const hidden = s.entries.filter(
        (c) => c.depth > keep && c.lines[0] > e.lines[0] && c.lines[1] <= e.lines[1],
      ).length;
      return {
        heading: e.heading,
        level: e.level,
        lines: e.lines,
        ...(e.depth === keep && hidden > 0 ? { hidden } : {}),
      };
    });
    const out = {
      lines: s.body,
      ...(s.preamble ? { preamble: s.preamble } : {}),
      outline,
      ...(keep < maxDepth ? { collapsed: true } : {}),
    };
    if (size(out) <= budget) return out;
  }
  const top = s.entries.filter((e) => e.depth === 0);
  const outline: unknown[] = [];
  let base = { lines: s.body, outline, collapsed: true, omitted: 0 };
  for (const e of top) {
    outline.push({ heading: e.heading, level: e.level, lines: e.lines });
    if (size(base) > budget) {
      outline.pop();
      break;
    }
  }
  base = { ...base, omitted: top.length - outline.length };
  return base;
}

/**
 * Chosen policy (246): over `cap` entries, drop the deepest tree level until it fits; an
 * entry whose sub-headings were dropped reports `hidden`. The shallowest level is never cut.
 */
export function flatCapped(s: NoteStructure, cap = 100) {
  const maxDepth = Math.max(0, ...s.entries.map((e) => e.depth));
  let keep = maxDepth;
  while (keep > 0 && s.entries.filter((e) => e.depth <= keep).length > cap) keep--;
  const outline = s.entries
    .filter((e) => e.depth <= keep)
    .map((e) => {
      const hidden = s.entries.filter(
        (c) => c.depth > keep && c.lines[0] > e.lines[0] && c.lines[1] <= e.lines[1],
      ).length;
      return {
        heading: e.heading,
        level: e.level,
        lines: e.lines,
        ...(hidden > 0 && e.depth === keep ? { hidden } : {}),
      };
    });
  return {
    lines: s.body,
    ...(s.preamble ? { preamble: s.preamble } : {}),
    outline,
    ...(keep < maxDepth ? { collapsed: true } : {}),
  };
}
