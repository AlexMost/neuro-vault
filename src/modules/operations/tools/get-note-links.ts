import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { NoteLinks, WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import { normalizePath } from '../tool-helpers.js';

const inputSchema = z.object({
  path: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

const DESCRIPTION = [
  'Return the wikilink adjacency for a single note: full incoming and outgoing edge lists derived from the vault-wide wikilink graph.',
  '',
  '`incoming` is the resolved list of source notes whose body or frontmatter wikilinks (or `![[embeds]]`) point at the requested path. `outgoing` lists the wikilink targets in the requested note; each carries `resolved: bool`. Resolved entries also carry the resolved vault path; unresolved entries (concepts the user has anchored but not yet written) are kept verbatim and surfaced for traversal use cases.',
  '',
  'Backed by an in-memory index that rebuilds lazily on query when older than 3 minutes — no background timers, no watchers. The first call after a stale window pays the rebuild cost.',
  '',
  'Use `search_notes` / `query_notes` to find a starting note, then call `get_note_links` to traverse the graph around it.',
].join('\n');

export interface GetNoteLinksDeps {
  graph: WikilinkGraphIndex;
}

export function buildGetNoteLinksTool(deps: GetNoteLinksDeps): ITool<Input, NoteLinks> {
  const { graph } = deps;
  return {
    name: 'get_note_links',
    title: 'Get Note Links',
    description: DESCRIPTION,
    inputSchema,
    handler: async (input) => {
      const path = normalizePath(input.path);
      await graph.ensureFresh();
      return graph.getNoteLinks(path);
    },
  };
}
