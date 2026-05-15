import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { runQueryNotes } from '../../../lib/obsidian/query/index.js';
import type { QueryNotesToolInput } from '../types.js';

const queryNotesSortSchema = z.object({
  field: z.string().min(1),
  order: z.enum(['asc', 'desc']),
});

const inputSchema = z.object({
  vault: z.string().optional(),
  filter: z.record(z.string(), z.unknown()),
  path_prefix: z.string().optional(),
  sort: queryNotesSortSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  include_content: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface QueryNotesDeps {
  registry: VaultRegistry;
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

export function buildQueryNotesTool(deps: QueryNotesDeps): ITool<Input, QueryNotesResultWithVault> {
  const { registry } = deps;
  return {
    name: 'query_notes',
    title: 'Query Notes',
    description:
      'Run a structured MongoDB-style query against the vault\'s frontmatter, tags, and wikilink graph. `filter` is a sift/MongoDB filter object evaluated against `NoteRecord` shape `{ path, frontmatter, tags, backlink_count }` — `tags` is an array of strings (no leading `#`) extracted from the `tags:` frontmatter field; `backlink_count` is the number of vault-wide wikilinks (and `![[embeds]]`) that point at the note. Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Supported operators: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$options`, `$and`, `$or`, `$nor`, `$not`. `$regex` is case-insensitive by default; pass `$options` (e.g. `\'\'` for case-sensitive, `\'m\'` for multiline-only) to override. Optional `path_prefix` restricts the scan to a vault subtree (vault-relative POSIX, no leading slash). Optional `sort` is `{ field, order }` — `field` must be `"path"`, `"backlink_count"`, or start with `"frontmatter."`. Optional `limit` defaults to 100, max 1000. Optional `include_content` (default false) — when true, each result also carries `content` (note body). Returns `{ results, count, truncated }`; each result item carries `vault` and `backlink_count`. `truncated` is true when more notes matched than `limit` allowed. Reads directly from disk and does not require Obsidian to be running. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input: QueryNotesToolInput & { vault?: string }) => {
      const entry = resolveVault(input, registry, { tool: 'query_notes' });
      const raw = await runQueryNotes(input, entry.reader, entry.graph);
      const results: QueryNotesResultItemWithVault[] = raw.results.map((item) => ({
        vault: entry.name,
        ...item,
      }));
      return { results, count: raw.count, truncated: raw.truncated };
    },
  };
}
