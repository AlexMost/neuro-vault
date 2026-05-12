import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface GetVaultOverviewDeps {
  reader: VaultReader;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
}

export function buildGetVaultOverviewTool(deps: GetVaultOverviewDeps): ITool<Input, VaultOverview> {
  return {
    name: 'get_vault_overview',
    title: 'Get Vault Overview',
    description:
      'Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties, total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`.',
    inputSchema,
    handler: async (_input) => computeVaultOverview(deps),
  };
}
