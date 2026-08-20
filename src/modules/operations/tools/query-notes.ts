import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { runQueryNotes } from '../../../lib/obsidian/query/index.js';
import type { IFanOutResult } from '../../../lib/fan-out.js';
import type { QueryNotesToolInput } from '../types.js';
import type { IVaultEntry } from '../../../lib/vault-registry.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';

const queryNotesSortSchema = z.object({
  field: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

interface Input {
  vault?: string;
  filter: Record<string, unknown>;
  path_prefix?: string | string[];
  exclude_path_prefix?: string | string[];
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
  include_content?: boolean;
}

export interface QueryNotesDeps {
  registry: IVaultRegistry;
}

export interface QueryNotesResultItemWithVault {
  vault: string;
  path: string;
  frontmatter: Record<string, unknown>;
  backlink_count: number;
  content?: string;
}

export interface QueryNotesResultWithVault {
  results: QueryNotesResultItemWithVault[];
  count: number;
  truncated: boolean;
}

async function runQueryForEntry(
  entry: IVaultEntry,
  input: QueryNotesToolInput & { vault?: string },
): Promise<QueryNotesResultWithVault> {
  const raw = await runQueryNotes(input, entry.reader, entry.graph);
  const results: QueryNotesResultItemWithVault[] = raw.results.map((item) => ({
    vault: entry.name,
    ...item,
  }));
  return { results, count: raw.count, truncated: raw.truncated };
}

const queryNotesPrefixSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const QUERY_NOTES_DESCRIPTION =
  'Run a structured MongoDB-style query against the vault\'s frontmatter, tags, and wikilink graph. `filter` is a sift/MongoDB filter object evaluated against `NoteRecord` shape `{ path, frontmatter, tags, backlink_count }` — `tags` is an array of strings (no leading `#`) extracted from the `tags:` frontmatter field (inline body `#tags` are NOT included — `list_tags` counts them, this filter cannot match them); `backlink_count` is the number of vault-wide wikilinks (and `![[embeds]]`) that point at the note. Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Supported operators: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$options`, `$and`, `$or`, `$nor`, `$not`. `$regex` is case-insensitive by default; pass `$options` (e.g. `\'\'` for case-sensitive, `\'m\'` for multiline-only) to override. Optional `path_prefix` restricts the scan to a vault subtree (vault-relative POSIX, no leading slash); pass an array for OR-semantics across multiple subtrees (e.g. `["Tasks/", "Reflections/"]`). Optional `exclude_path_prefix` (string or array) drops notes whose path starts with any listed prefix — valid as the sole path filter, e.g. `["Resources/", "Archive/"]` to search the whole vault except those subtrees. Optional `sort` is `{ field, order }` — `field` must be `"path"`, `"backlink_count"`, or start with `"frontmatter."`. Optional `limit` defaults to 100, max 1000. Optional `include_content` (default false) — when true, each result also carries `content` (note body). Returns `{ results, count, truncated }`; each result item carries `vault` and `backlink_count`. `truncated` is true when more notes matched than `limit` allowed. Reads directly from disk and does not require Obsidian to be running. When you are working inside the vault directory itself and therefore have both filesystem access and MCP access to the same notes, reach for this tool (or `search_notes` for semantic recall) instead of grepping or scanning files by hand — it exists so frontmatter, tag, and backlink queries do not require reading every note.';

export function buildQueryNotesTool(
  deps: QueryNotesDeps,
): ITool<Input, QueryNotesResultWithVault | IFanOutResult<QueryNotesResultWithVault>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'query_notes',
    title: 'Query Notes',
    description: QUERY_NOTES_DESCRIPTION,
    inputShape: {
      filter: z.record(z.string(), z.unknown()),
      path_prefix: queryNotesPrefixSchema.optional(),
      exclude_path_prefix: queryNotesPrefixSchema.optional(),
      sort: queryNotesSortSchema.optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      include_content: z.boolean().optional(),
    },
    runForEntry: (entry, input: QueryNotesToolInput & { vault?: string }) =>
      runQueryForEntry(entry, input),
    single: payloadOnly,
  });
}
