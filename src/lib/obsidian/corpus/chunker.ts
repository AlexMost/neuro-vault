import type { ChunkedBlock } from './types.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface OpenSection {
  level: number;
  key: string;
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
  let inFence = false;

  const close = (section: OpenSection, endLine: number) => {
    blocks.push({
      key: section.key,
      heading: section.key.split('#').filter(Boolean).slice(-1)[0] ?? '',
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
  const firstHeading = lines.findIndex((l, idx) => idx >= fmEnd && HEADING_RE.test(l));
  const preambleEnd = firstHeading === -1 ? lines.length : firstHeading;
  if (preambleEnd > fmEnd && lines.slice(fmEnd, preambleEnd).join('').trim() !== '') {
    blocks.push({
      key: '#',
      heading: '',
      lines: [fmEnd + 1, preambleEnd],
      text: lines.slice(fmEnd, preambleEnd).join('\n'),
    });
  }

  for (let i = fmEnd; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const level = match[1].length;
    let title = match[2];
    while (open.length > 0 && open[open.length - 1].level >= level) {
      close(open.pop()!, i);
    }
    const parent = open[open.length - 1];
    if (parent && parent.firstChildStart === undefined) {
      parent.firstChildStart = i + 1;
    }
    const scopeKey = `${parent ? parent.key : ''}\u0000${title}`;
    const seen = (headingCounts.get(scopeKey) ?? 0) + 1;
    headingCounts.set(scopeKey, seen);
    if (seen > 1) title = `${title}[${seen}]`;
    const separator = '#'.repeat(parent ? level - parent.level : 1);
    open.push({
      level,
      key: `${parent ? parent.key : ''}${separator}${title}`,
      start: i + 1,
    });
  }
  while (open.length > 0) close(open.pop()!, lines.length);

  return blocks.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
}
