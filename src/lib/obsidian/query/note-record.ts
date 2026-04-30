import type { ReadNotesItemSuccess } from '../vault-reader.js';
import type { NoteRecord } from './types.js';

export function toNoteRecord(item: ReadNotesItemSuccess, backlinkCount = 0): NoteRecord {
  const frontmatter =
    item.frontmatter && typeof item.frontmatter === 'object' ? item.frontmatter : {};
  return {
    path: item.path,
    frontmatter,
    tags: extractTags(frontmatter),
    backlink_count: backlinkCount,
  };
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter['tags'];
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const entry of list) {
    if (entry === null || entry === undefined) continue;
    const stringified = String(entry).trim().replace(/^#+/, '').trim();
    if (stringified === '') continue;
    out.push(stringified);
  }
  return out;
}
