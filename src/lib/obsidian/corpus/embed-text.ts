import { chunkNote } from './chunker.js';
import { EMBED_CHAR_BUDGET, MIN_CHARS, type ChunkedBlock, type NoteEmbedInputs } from './types.js';

export function pathBreadcrumbs(notePath: string): string {
  return notePath.split('/').join(' > ').replace(/\.md$/, '');
}

function blockBreadcrumbs(notePath: string, blockKey: string): string {
  return `${notePath}${blockKey}`
    .split('/')
    .join(' > ')
    .split('#')
    .slice(0, -1)
    .join(' > ')
    .replace(/\.md/g, '');
}

/**
 * True when `block`'s line span is entirely accounted for by the union of the spans
 * of other kept blocks strictly nested inside it, ignoring blank lines and heading
 * lines (a heading line alone is not content of the parent's own).
 */
function isFullyCovered(block: ChunkedBlock, others: ChunkedBlock[]): boolean {
  const children = others.filter(
    (o) => o !== block && o.lines[0] >= block.lines[0] && o.lines[1] <= block.lines[1],
  );
  if (children.length === 0) return false;
  const covered = new Set<number>();
  for (const child of children) {
    for (let l = child.lines[0]; l <= child.lines[1]; l += 1) covered.add(l);
  }
  for (let l = block.lines[0]; l <= block.lines[1]; l += 1) {
    if (covered.has(l)) continue;
    const line = block.text.split('\n')[l - block.lines[0]] ?? '';
    if (line.trim() !== '' && !/^#{1,6}\s/.test(line)) return false;
  }
  return true;
}

export function buildEmbedInputs(notePath: string, content: string): NoteEmbedInputs {
  const qualifying = chunkNote(content).filter((block) => block.text.length >= MIN_CHARS);
  const kept = qualifying.filter((block) => !isFullyCovered(block, qualifying));
  const blocks = kept.map((block) => ({
    ...block,
    embedText: `${blockBreadcrumbs(notePath, block.key)}\n${block.text}`,
  }));
  const note =
    content.length >= MIN_CHARS
      ? `${pathBreadcrumbs(notePath)}:\n${content}`.slice(0, EMBED_CHAR_BUDGET)
      : null;
  return { path: notePath, note, blocks };
}
