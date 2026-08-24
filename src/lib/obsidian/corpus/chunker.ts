import { fromMarkdown } from 'mdast-util-from-markdown';

import type { ChunkedBlock } from './types.js';

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
 * The heading's title as the *source* writes it, never as CommonMark renders it:
 * `# **Bold** title` renders "Bold title" and `# Title ###` renders "Title" (the
 * closing hash run is eaten), either of which would move the block key of a note
 * whose key is already correct. A setext heading has no `#` prefix, so its raw line
 * trimmed is the title.
 */
function titleFromRawLine(raw: string): string {
  const prefix = ATX_PREFIX_RE.exec(raw);
  return (prefix ? raw.slice(prefix[0].length) : raw).trim();
}

/**
 * Every heading that opens a block, in source order. The AST decides where a heading
 * is and what level it is; a line scanner cannot, because fence nesting, fences of
 * four or more backticks, indented code and setext headings are all beyond a regex —
 * and each one it gets wrong loses content silently, into no block at all.
 *
 * Only root-level headings count. A heading inside a blockquote or a list item is a
 * `heading` node to CommonMark, but a `> # quoted` line opening a corpus block would
 * be surprising, so containers are not recursed into.
 */
function scanHeadings(lines: string[], fmEnd: number): HeadingHit[] {
  // Parse the body only: there is no frontmatter extension here, so an unstripped
  // `---` would parse as a thematic break — or, after a paragraph, a setext heading.
  const root = fromMarkdown(lines.slice(fmEnd).join('\n'));
  const hits: HeadingHit[] = [];
  for (const node of root.children) {
    if (node.type !== 'heading') continue;
    const line = (node.position?.start.line ?? 1) + fmEnd;
    const title = titleFromRawLine(lines[line - 1] ?? '');
    // `#` alone is a heading with empty text; keyed, it would mint "#", which is
    // the preamble block's key.
    if (title === '') continue;
    hits.push({ line, level: node.depth, title });
  }
  return hits;
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') return i + 1; // 1-based inclusive end
  }
  return 0; // unterminated fence: not frontmatter
}

export function chunkNote(content: string): ChunkedBlock[] {
  const lines = content.split('\n');
  const blocks: ChunkedBlock[] = [];
  const open: OpenSection[] = [];
  /** (parent key + title) -> occurrences, so a repeat is disambiguated at any level. */
  const headingCounts = new Map<string, number>();

  const close = (section: OpenSection, endLine: number) => {
    blocks.push({
      key: section.key,
      heading: section.title,
      lines: [section.start, endLine],
      text: lines.slice(section.start - 1, endLine).join('\n'),
    });

    const ownStart = section.start + 1;
    const ownEnd = section.firstChildStart !== undefined ? section.firstChildStart - 1 : endLine;
    if (ownEnd >= ownStart) {
      const chunks = splitContentChunks(lines, ownStart, ownEnd);
      // A single own-content paragraph is already covered by the heading block above;
      // only disambiguate when a heading directly owns more than one paragraph.
      if (chunks.length > 1) {
        chunks.forEach((chunk, idx) => {
          blocks.push({
            key: `${section.key}#{${idx + 1}}`,
            heading: '',
            lines: [chunk.start, chunk.end],
            text: chunk.text,
          });
        });
      }
    }
  };

  const fmEnd = frontmatterEnd(lines);
  if (fmEnd > 0) {
    blocks.push({
      key: '#---frontmatter---',
      heading: '---frontmatter---',
      lines: [1, fmEnd],
      text: lines.slice(0, fmEnd).join('\n'),
    });
  }
  const headings = scanHeadings(lines, fmEnd);
  const preambleEnd = headings.length === 0 ? lines.length : headings[0].line - 1;
  if (preambleEnd > fmEnd && lines.slice(fmEnd, preambleEnd).join('').trim() !== '') {
    blocks.push({
      key: '#',
      heading: '',
      lines: [fmEnd + 1, preambleEnd],
      text: lines.slice(fmEnd, preambleEnd).join('\n'),
    });
  }

  for (const hit of headings) {
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
    const seen = (headingCounts.get(scopeKey) ?? 0) + 1;
    headingCounts.set(scopeKey, seen);
    if (seen > 1) title = `${title}[${seen}]`;
    const separator = '#'.repeat(parent ? level - parent.level : 1);
    open.push({
      level,
      key: `${parent ? parent.key : ''}${separator}${title}`,
      title,
      start: line,
    });
  }
  while (open.length > 0) close(open.pop()!, lines.length);

  return blocks.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
}
