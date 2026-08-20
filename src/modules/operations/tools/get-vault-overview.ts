import type { IFanOutResult } from '../../../lib/fan-out.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

export interface GetVaultOverviewDeps {
  registry: IVaultRegistry;
}

async function runOverviewForEntry(entry: IVaultEntry): Promise<VaultOverview> {
  return computeVaultOverview({
    reader: entry.reader,
    provider: entry.provider,
    graph: entry.graph,
    readConventions: entry.readConventions,
  });
}

export function buildGetVaultOverviewTool(
  deps: GetVaultOverviewDeps,
): ITool<Input, ({ vault: string } & VaultOverview) | IFanOutResult<VaultOverview>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'get_vault_overview',
    title: 'Get Vault Overview',
    description:
      'Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties (top entries only — use `list_properties` for the full inventory), total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`.' +
      " When the vault owner has written conventions for external agents, the response carries them in `conventions` — the vault owner's rules for how this vault is organised. Follow them when reading, writing, or organising notes here.",
    inputShape: {},
    runForEntry: runOverviewForEntry,
    single: withVaultName,
  });
}
