import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';

const inputSchema = z.object({
  vault: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface GetVaultOverviewDeps {
  registry: VaultRegistry;
}

export function buildGetVaultOverviewTool(
  deps: GetVaultOverviewDeps,
): ITool<Input, { vault: string } & VaultOverview> {
  const { registry } = deps;
  return {
    name: 'get_vault_overview',
    title: 'Get Vault Overview',
    description:
      'Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties, total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'get_vault_overview' });
      const overview = await computeVaultOverview({
        reader: entry.reader,
        provider: entry.provider!,
        graph: entry.graph,
      });
      return { vault: entry.name, ...overview };
    },
  };
}
