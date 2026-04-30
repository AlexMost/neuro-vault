import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { runQueryNotes } from '../../../lib/obsidian/query/index.js';
import type { QueryNotesResult, QueryNotesToolInput } from '../types.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';

const queryNotesSortSchema = z.object({
  field: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

const inputSchema = z.object({
  filter: z.record(z.string(), z.unknown()),
  path_prefix: z.string().optional(),
  sort: queryNotesSortSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  include_content: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface QueryNotesDeps {
  reader: VaultReader;
  graph: WikilinkGraphIndex;
}

export function buildQueryNotesTool(deps: QueryNotesDeps): ITool<Input, QueryNotesResult> {
  const { reader, graph } = deps;
  return {
    name: 'query_notes',
    title: 'Query Notes',
    description:
      'Run a structured MongoDB-style query against the vault\'s frontmatter, tags, and wikilink graph. `filter` is a sift/MongoDB filter object evaluated against `NoteRecord` shape `{ path, frontmatter, tags, backlink_count }` — `tags` is an array of strings (no leading `#`) extracted from the `tags:` frontmatter field; `backlink_count` is the number of vault-wide wikilinks (and `![[embeds]]`) that point at the note. Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Supported operators: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`. Optional `path_prefix` restricts the scan to a vault subtree (vault-relative POSIX, no leading slash). Optional `sort` is `{ field, order }` — `field` must be `"path"`, `"backlink_count"`, or start with `"frontmatter."`. Optional `limit` defaults to 100, max 1000. Optional `include_content` (default false) — when true, each result also carries `content` (note body). Returns `{ results, count, truncated }`; each result item carries `backlink_count`. `truncated` is true when more notes matched than `limit` allowed. Reads directly from disk and does not require Obsidian to be running.',
    inputSchema,
    handler: async (input: QueryNotesToolInput) => {
      return runQueryNotes(input, reader, graph);
    },
  };
}
