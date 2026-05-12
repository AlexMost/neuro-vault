import type { IResource } from '../../../lib/resource-registry.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';

export interface VaultOverviewResourceDeps {
  reader: VaultReader;
  graph: WikilinkGraphIndex;
}

export function buildVaultOverviewResource(
  deps: VaultOverviewResourceDeps,
): IResource<VaultOverview> {
  return {
    name: 'vault-overview',
    uri: 'vault://overview',
    title: 'Vault Overview',
    description:
      'Snapshot of vault structure (folders, tags, properties, top-10 notes by backlinks). Same payload as the `get_vault_overview` tool; exposed as a resource so clients that auto-load resources can pull it into context without an explicit tool call.',
    mimeType: 'application/json',
    handler: async () => computeVaultOverview(deps),
  };
}
