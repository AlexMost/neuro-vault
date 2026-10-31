import { fromMarkdown } from 'mdast-util-from-markdown';

import { splitRawFrontmatter } from '../in-place-edit.js';

import type { ChunkedBlock } from './types.js';

export const FRONTMATTER_KEY = '#---frontmatter---';

/** The leading `#` run of an ATX heading plus the one whitespace that closes it. */
const ATX_PREFIX_RE = /^ {0,3}#{1,6}(?:\s|$)/;

/** A heading the AST recognised as a block boundary. */
interface HeadingHit {
  /** 1-based line of the heading's first source line. */
  line: number;
  /** 1..6, from `heading.depth`. */
  level: number;
  /** The heading's text as the source writes it. */
  title: string;
}

interface OpenSection {
  level: number;
  key: string;
  /** The heading's own text, disambiguated the same way the key's last segment is. */
  title: string;
  start: number;
  /** 1-based line of this section's first child heading, if any. */
  firstChildStart?: number;
}

interface ContentSpan {
  start: number;
  end: number;
  text: string;
}

/** Splits `lines[start..end]` (1-based inclusive) into blank-line-separated, non-blank spans. */
function splitContentChunks(lines: string[], start: number, end: number): ContentSpan[] {
  const chunks: ContentSpan[] = [];
  let i = start;
  while (i <= end) {
    while (i <= end && (lines[i - 1] ?? '').trim() === '') i += 1;
    if (i > end) break;
    const chunkStart = i;
    while (i <= end && (lines[i - 1] ?? '').trim() !== '') i += 1;
    const chunkEnd = i - 1;
    chunks.push({
      start: chunkStart,
      end: chunkEnd,
      text: lines.slice(chunkStart - 1, chunkEnd).join('\n'),
    });
  }
  return chunks;
}

/**
 * The ATX heading's title as the *source* writes it, never as CommonMark renders it:
 * `# **Bold** title` renders "Bold title" and `# Title ###` renders "Title" (the
 * closing hash run is eaten), either of which would move the block key of a note
 * whose key is already correct.
 *
 * Returns null when the line is not an ATX heading, which is how a setext heading is
 * rejected: the spec splits notes "at ATX headings of levels 1-6", and a paragraph
 * sitting directly above a `---` separator is a setext H2 to CommonMark, so honouring
 * setext would mint a block whose title is a whole sentence.
 */
function atxTitleFromRawLine(raw: string): string | null {
  const prefix = ATX_PREFIX_RE.exec(raw);
  if (!prefix) return null;
  return raw.slice(prefix[0].length).trim();
}

/**
 * Every heading that opens a block, in source order. The AST decides where a heading
 * is and what level it is; a line scanner cannot, because fence nesting, fences of
 * four or more backticks, indented code and HTML blocks are all beyond a regex — and
 * each one it gets wrong loses content silently, into no block at all.
 *
 * Only root-level headings count. A heading inside a blockquote or a list item is a
 * `heading` node to CommonMark, but a `> # quoted` line opening a corpus block would
 * be surprising, so containers are not recursed into.
 */
function scanHeadings(lines: string[], fmEnd: number): HeadingHit[] {
  // Parse the body only: there is no frontmatter extension here, so unstripped
  // frontmatter would be parsed as Markdown, and a `# comment` line in the YAML
  // would open a block. Line numbers are restored with the `fmEnd` offset.
  const root = fromMarkdown(lines.slice(fmEnd).join('\n'));
  const hits: HeadingHit[] = [];
  for (const node of root.children) {
    if (node.type !== 'heading') continue;
    // `fromMarkdown` always populates `position`; skipping rather than defaulting keeps
    // a hypothetical gap from aiming the title read at an unrelated real line, which
    // would mint a heading block in the wrong place.
    if (!node.position) continue;
    const line = node.position.start.line + fmEnd;
    const title = atxTitleFromRawLine(lines[line - 1] ?? '');
    // Not an ATX heading, i.e. a setext one: the spec splits at ATX headings only.
    if (title === null) continue;
    // `#` alone is an ATX heading with empty text. Its key would be "#", which is the
    // preamble block's key, and block keys are required to be unique within a note.
    if (title === '') continue;
    hits.push({ line, level: node.depth, title });
  }
  return hits;
}

/**
 * 1-based inclusive line of the closing frontmatter fence, or 0 when the note has
 * none. Delegates to the canonical grammar in in-place-edit.ts so the corpus never
 * disagrees with `set_property`/`edit_note`/the lexical index about where
 * frontmatter ends — to them an indented `---` is body, so it must be body here too.
 */
export function frontmatterEnd(content: string): number {
  const { prefix } = splitRawFrontmatter(content);
  if (prefix === '') return 0;
  const newlines = prefix.split('\n').length - 1;
  return prefix.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Splits a note into its real lines: `content.split('\n')` minus the empty element a
 * trailing newline leaves behind, so a note ending in `\n` has no phantom last line.
 * The one line splitter shared by the chunker and the read-time note structure; `''`
 * stays `['']`.
 */
export function splitNoteLines(content: string): string[] {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** A numbered paragraph chunk a heading directly owns, keyed `<heading key>#{n}`. */
export interface ContentChunk extends ContentSpan {
  key: string;
}

/**
 * One heading block: from the heading's line to the line before the next heading of its
 * level or higher.
 */
export interface HeadingBlock {
  /** The heading's own text, disambiguated the same way the key's last segment is. */
  title: string;
  level: number;
  /** 1-based inclusive span of the block. */
  start: number;
  end: number;
  key: string;
  /** The heading's own paragraphs, numbered; empty unless it directly owns more than one. */
  chunks: ContentChunk[];
}

/**
 * The single source of heading blocks: `chunkNote` and the read-time note structure both
 * take their heading spans, titles and keys from here, so they cannot drift. Returns the
 * blocks in source order.
 *
 * Numbered content-chunk keys are reserved here as each heading block closes, because a later
 * heading's key is disambiguated against them: the projection must name headings the way
 * the chunker does even though it embeds nothing.
 */
export function headingBlocks(lines: string[], fmEnd: number): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  const open: OpenSection[] = [];
  /** (parent key + title) -> occurrences, so a repeat is disambiguated at any level. */
  const headingCounts = new Map<string, number>();
  /** Every key minted so far: uniqueness is required across all block kinds. */
  const usedKeys = new Set<string>();
  if (fmEnd > 0) usedKeys.add(FRONTMATTER_KEY);

  const close = (section: OpenSection, endLine: number) => {
    const chunks: ContentChunk[] = [];
    const ownStart = section.start + 1;
    const ownEnd = section.firstChildStart !== undefined ? section.firstChildStart - 1 : endLine;
    if (ownEnd >= ownStart) {
      const spans = splitContentChunks(lines, ownStart, ownEnd);
      // A single own-content paragraph is already covered by the heading block above;
      // only disambiguate when a heading directly owns more than one paragraph.
      if (spans.length > 1) {
        // A child heading literally titled "{n}" may already own `#{n}` under this
        // key; numbering skips past any taken key so no two blocks ever share one.
        let n = 0;
        for (const span of spans) {
          let key: string;
          do {
            n += 1;
            key = `${section.key}#{${n}}`;
          } while (usedKeys.has(key));
          usedKeys.add(key);
          chunks.push({ ...span, key });
        }
      }
    }
    blocks.push({
      title: section.title,
      level: section.level,
      start: section.start,
      end: endLine,
      key: section.key,
      chunks,
    });
  };

  for (const hit of scanHeadings(lines, fmEnd)) {
    const { level, line } = hit;
    let title = hit.title;
    while (open.length > 0 && open[open.length - 1].level >= level) {
      close(open.pop()!, line - 1);
    }
    const parent = open[open.length - 1];
    if (parent && parent.firstChildStart === undefined) {
      parent.firstChildStart = line;
    }
    const scopeKey = `${parent ? parent.key : ''}\u0000${title}`;
    // At root the document is the parent at level 0, so the separator still
    // encodes the heading's real level: a preamble-only H3 keys as "###Deep".
    const separator = '#'.repeat(parent ? level - parent.level : level);
    let seen = (headingCounts.get(scopeKey) ?? 0) + 1;
    if (seen > 1) title = `${title}[${seen}]`;
    let key = `${parent ? parent.key : ''}${separator}${title}`;
    // A sibling literally titled with the suffix ("A[2]") may already own the
    // suffixed key; keep counting until the key is free.
    while (usedKeys.has(key)) {
      seen += 1;
      title = `${hit.title}[${seen}]`;
      key = `${parent ? parent.key : ''}${separator}${title}`;
    }
    headingCounts.set(scopeKey, seen);
    usedKeys.add(key);
    open.push({
      level,
      key,
      title,
      start: line,
    });
  }
  while (open.length > 0) close(open.pop()!, lines.length);

  return blocks.sort((a, b) => a.start - b.start);
}

/**
 * The text between the frontmatter and the first heading block (or the end of the note
 * when there is none) as a 1-based inclusive span, or null when it holds only blanks.
 */
export function preambleSpan(
  lines: string[],
  fmEnd: number,
  blocks: readonly HeadingBlock[],
): [number, number] | null {
  const end = blocks.length === 0 ? lines.length : blocks[0].start - 1;
  if (end <= fmEnd || lines.slice(fmEnd, end).join('').trim() === '') return null;
  return [fmEnd + 1, end];
}

export function chunkNote(content: string): ChunkedBlock[] {
  const lines = splitNoteLines(content);
  const blocks: ChunkedBlock[] = [];

  const fmEnd = frontmatterEnd(content);
  if (fmEnd > 0) {
    blocks.push({
      key: FRONTMATTER_KEY,
      heading: '---frontmatter---',
      lines: [1, fmEnd],
      text: lines.slice(0, fmEnd).join('\n'),
    });
  }

  const headings = headingBlocks(lines, fmEnd);
  for (const headingBlock of headings) {
    blocks.push({
      key: headingBlock.key,
      heading: headingBlock.title,
      lines: [headingBlock.start, headingBlock.end],
      text: lines.slice(headingBlock.start - 1, headingBlock.end).join('\n'),
    });
    for (const chunk of headingBlock.chunks) {
      blocks.push({
        key: chunk.key,
        heading: '',
        lines: [chunk.start, chunk.end],
        text: chunk.text,
      });
    }
  }

  const preamble = preambleSpan(lines, fmEnd, headings);
  if (preamble) {
    blocks.push({
      key: '#',
      heading: '',
      lines: preamble,
      text: lines.slice(preamble[0] - 1, preamble[1]).join('\n'),
    });
  }

  return blocks.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
}
