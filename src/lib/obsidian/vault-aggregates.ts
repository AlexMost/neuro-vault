import { extractInlineTags } from './inline-tags.js';
import { extractTags } from './query/note-record.js';
import type { ReadNotesItemSuccess, VaultReader } from './vault-reader.js';

export interface AggregateEntry {
  name: string;
  count: number;
}

/** Same batching pattern as query-notes.ts — bound memory, never hold every body at once. */
const READ_BATCH_SIZE = 32;

function sortCounts(counts: Map<string, number>): AggregateEntry[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Tag counts over the reader's scoped scan: the per-note union of frontmatter
 * `tags:` values and inline body `#tags`, each distinct tag counted at most
 * once per note. A note the vault's scope excludes never reaches `scan()`, so
 * it contributes nothing.
 */
export async function listTags(reader: VaultReader): Promise<AggregateEntry[]> {
  const counts = new Map<string, number>();
  const paths = await reader.scan();
  for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
    const slice = paths.slice(i, i + READ_BATCH_SIZE);
    const items = await reader.readNotes({ paths: slice, fields: ['frontmatter', 'content'] });
    for (const item of items) {
      if ('error' in item) continue;
      const noteTags = new Set([
        ...extractTags(item.frontmatter ?? {}),
        ...extractInlineTags(item.content),
      ]);
      for (const tag of noteTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return sortCounts(counts);
}

/** Frontmatter-key counts over the reader's scoped scan. */
export async function listProperties(reader: VaultReader): Promise<AggregateEntry[]> {
  const counts = new Map<string, number>();
  const paths = await reader.scan();
  const items = await reader.readNotes({ paths, fields: ['frontmatter'] });
  const frontmatters = items
    .filter((i): i is ReadNotesItemSuccess => !('error' in i))
    .map((i) => i.frontmatter ?? {});
  for (const fm of frontmatters) {
    for (const key of Object.keys(fm)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return sortCounts(counts);
}
