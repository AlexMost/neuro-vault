import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { VaultRegistry, VaultEntry } from '../../../lib/vault-registry.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';
import { runFanOut, type FanOutResult } from '../../../lib/fan-out.js';

const inputSchema = z.object({
  vault: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface GetVaultOverviewDeps {
  registry: VaultRegistry;
}

// VaultOverview & Record<string, unknown> satisfies the FanOut constraint
type VaultOverviewRecord = VaultOverview & Record<string, unknown>;

async function runOverviewForEntry(entry: VaultEntry): Promise<VaultOverviewRecord> {
  const overview = await computeVaultOverview({
    reader: entry.reader,
    provider: entry.provider!,
    graph: entry.graph,
  });
  return overview as VaultOverviewRecord;
}

export function buildGetVaultOverviewTool(
  deps: GetVaultOverviewDeps,
): ITool<Input, ({ vault: string } & VaultOverview) | FanOutResult<VaultOverviewRecord>> {
  const { registry } = deps;
  return {
    name: 'get_vault_overview',
    title: 'Get Vault Overview',
    description:
      'Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties, total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`. In multi-vault mode, omit `vault:` to fan out across all registered vaults — the response shape switches to `results_by_vault: [...]` with `skipped_vaults: [...]`. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      if (input.vault === undefined && registry.isMulti()) {
        return await runFanOut(registry, (entry) => runOverviewForEntry(entry));
      }
      const entry = resolveVault(input, registry, { tool: 'get_vault_overview' });
      const overview = await runOverviewForEntry(entry);
      return { vault: entry.name, ...overview };
    },
  };
}
