// PROTOTYPE — throwaway, never merged. Answers "what does a structured read_notes preview look
// like, what bounds it, and does it replace today's preview?" (issue 247). Pure functions.

import { previewBody } from './preview-body.js';
import {
  structureOf,
  flatCapped,
  type HeadingEntry,
  type NoteStructure,
} from './outline.PROTOTYPE.js';

const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));

interface Ctx {
  raw: string[];
  s: NoteStructure;
}

function ctx(content: string): Ctx {
  return { raw: content.split('\n'), s: structureOf(content) };
}

/** Own text of an entry: heading line + 1 up to the first sub-heading − 1. */
function ownSpan(c: Ctx, i: number): [number, number] {
  const e = c.s.entries[i];
  const next = c.s.entries[i + 1];
  const end = next && next.lines[0] <= e.lines[1] ? next.lines[0] - 1 : e.lines[1];
  return [e.lines[0] + 1, end];
}

/**
 * First `cap` characters of a span, blank lines dropped, cut on whitespace, `…` when cut.
 * Returns the text plus the span it actually covers (first and last line it touches).
 */
function excerptOf(c: Ctx, span: [number, number], cap: number) {
  let out = '';
  let first = 0;
  let last = 0;
  let cut = false;
  for (let n = span[0]; n <= span[1]; n++) {
    const line = c.raw[n - 1] ?? '';
    if (line.trim() === '') continue;
    const piece = (out ? '\n' : '') + line;
    if (out.length + piece.length > cap) {
      const room = cap - out.length;
      const seg = piece.slice(0, room + 1);
      const ws = Math.max(seg.lastIndexOf(' '), seg.lastIndexOf('\n'));
      const part = piece.slice(0, ws > 0 ? ws : room).trimEnd();
      if (part.trim()) {
        out += part;
        first ||= n;
        last = n;
      }
      cut = true;
      break;
    }
    out += piece;
    first ||= n;
    last = n;
  }
  if (!cut) {
    // Text left after the excerpt (blank lines only do not count) is also a cut.
    for (let n = last + 1; n <= span[1]; n++) if ((c.raw[n - 1] ?? '').trim()) cut = true;
  }
  return { text: out + (cut && out ? '…' : ''), lines: [first, last] as [number, number], cut };
}

// ---- Candidate A: today's preview, plus the span echo 242/246 asked for ----------------------

/** A. 500-char prefix of the body. `lines` = first..last line the prefix touches. */
export function prefixPreview(content: string) {
  const c = ctx(content);
  const body = c.raw.slice(c.s.body[0] - 1).join('\n');
  const { content: text, truncated } = previewBody(body);
  const kept = text.replace(/…$/, '');
  const lastLine = c.s.body[0] + kept.split('\n').length - 1;
  return { lines: [c.s.body[0], truncated ? lastLine : c.s.body[1]], content: text, truncated };
}

// ---- Candidate B: outline + prefix (additive: today's item gains the outline) ---------------

/** B. Today's prefix, plus the 246 outline. No per-heading text. */
export function outlinePlusPrefix(content: string) {
  const c = ctx(content);
  const o = flatCapped(c.s, 100);
  const a = prefixPreview(content);
  return {
    ...a,
    ...(o.preamble ? { preamble: o.preamble } : {}),
    outline: o.outline,
    ...(o.collapsed ? { collapsed: true } : {}),
  };
}

// ---- Candidate C: structured array — outline entries + an excerpt each ----------------------

export interface StructuredOpts {
  /** Per-heading excerpt cap (chars). */
  perHeading: number;
  /** Per-note total budget (bytes of the serialized item). */
  total: number;
  /** Who loses their excerpt first when the total is hit. */
  degrade: 'deepest-first' | 'last-first';
  /** Entry cap before any excerpt is placed (the outline's depth collapse). */
  entryCap: number;
}

export const DEFAULT_C: StructuredOpts = {
  perHeading: 160,
  total: 1200,
  degrade: 'deepest-first',
  entryCap: 100,
};

/**
 * C. `preview: [{ heading, level, lines, excerpt? }]` — the 246 outline entry plus the start of
 * the heading's own text. `lines` stays the subtree span (same as outline / heading reads), so
 * every entry is still addressable as-is. The preamble gets an excerpt too.
 *
 * Budget: 1) the outline's depth collapse to `entryCap`; 2) each excerpt ≤ `perHeading`;
 * 3) if the item is over `total`, drop excerpts (deepest-first or last-first) until it fits —
 * structure is never dropped below the outline. `excerpts: "partial"` says some were dropped.
 */
export function structured(content: string, opts: StructuredOpts = DEFAULT_C) {
  const c = ctx(content);
  const o = flatCapped(c.s, opts.entryCap);
  const shownIdx = o.outline.map((oe) =>
    c.s.entries.findIndex((e) => e.lines[0] === oe.lines[0] && e.heading === oe.heading),
  );
  type Entry = {
    heading: string;
    level: number;
    lines: [number, number];
    hidden?: number;
    excerpt?: string;
  };
  const entries: Entry[] = o.outline.map((oe, k) => {
    const ex = excerptOf(c, ownSpan(c, shownIdx[k]), opts.perHeading);
    return { ...oe, ...(ex.text ? { excerpt: ex.text } : {}) } as Entry;
  });
  const pre = c.s.preamble ? excerptOf(c, c.s.preamble, opts.perHeading) : null;
  const build = () => ({
    lines: c.s.body,
    ...(c.s.preamble
      ? { preamble: { lines: c.s.preamble, ...(pre?.text ? { excerpt: pre.text } : {}) } }
      : {}),
    preview: entries,
    ...(o.collapsed ? { collapsed: true } : {}),
    ...(dropped ? { excerpts: 'partial' as const } : {}),
  });
  let dropped = 0;
  const depthOf = (k: number) => c.s.entries[shownIdx[k]].depth;
  const order = entries
    .map((_, k) => k)
    .filter((k) => entries[k].excerpt)
    .sort((x, y) => (opts.degrade === 'deepest-first' ? depthOf(y) - depthOf(x) || y - x : y - x));
  for (const k of order) {
    if (bytes(build()) <= opts.total) break;
    delete entries[k].excerpt;
    dropped++;
  }
  return build();
}

/** Heading-less note under C: the whole thing is preamble; fall back to a prefix-sized excerpt. */
export function structuredHeadingless(content: string) {
  const c = ctx(content);
  if (c.s.entries.length) return structured(content);
  const ex = excerptOf(c, c.s.body, 500);
  return { lines: c.s.body, preamble: { lines: c.s.body, excerpt: ex.text }, preview: [] };
}

// ---- Candidate D: markdown string — heading lines kept, excerpt under each -----------------

/**
 * D. One markdown string in `content`: every shown heading line verbatim, its excerpt under
 * it, the span inlined as an HTML comment so pasted text stays parseable markdown. Fences cut
 * mid-way are closed so the string stays balanced.
 */
export function markdownSkim(content: string, opts: StructuredOpts = DEFAULT_C) {
  const s = structured(content, opts);
  const c = ctx(content);
  const close = (t: string) => ((t.match(/^(```|~~~)/gm) ?? []).length % 2 ? t + '\n```' : t);
  const parts: string[] = [];
  if ('preamble' in s && s.preamble) {
    parts.push(`<!-- ${s.preamble.lines[0]}-${s.preamble.lines[1]} -->`);
    if (s.preamble.excerpt) parts.push(close(s.preamble.excerpt));
  }
  for (const e of s.preview) {
    const head = c.raw[e.lines[0] - 1];
    parts.push(
      `${head} <!-- ${e.lines[0]}-${e.lines[1]}${e.hidden ? `, +${e.hidden} hidden` : ''} -->`,
    );
    if (e.excerpt) parts.push(close(e.excerpt));
  }
  return { lines: s.lines, content: parts.join('\n'), truncated: true };
}

export function sizeOf(v: unknown) {
  return bytes(v);
}

export type { HeadingEntry };
