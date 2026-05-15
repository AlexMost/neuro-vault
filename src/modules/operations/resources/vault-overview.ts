import type { IResource } from '../../../lib/resource-registry.js';
import type { VaultEntry } from '../../../lib/vault-registry.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';

export interface VaultOverviewResourceOpts {
  uri: string;
  entry: VaultEntry;
}

export function buildVaultOverviewResource(
  opts: VaultOverviewResourceOpts,
): IResource<VaultOverview> {
  const { uri, entry } = opts;
  if (!entry.provider) {
    throw new Error(
      `buildVaultOverviewResource: vault "${entry.name}" has no provider — operations module must be enabled`,
    );
  }
  return {
    name: uri === 'vault://overview' ? 'vault-overview' : `vault-overview-${entry.name}`,
    uri,
    title: uri === 'vault://overview' ? 'Vault Overview' : `Vault Overview — ${entry.name}`,
    description:
      'Snapshot of vault structure (folders, tags, properties, top-10 notes by backlinks). Same payload as the `get_vault_overview` tool; exposed as a resource so clients that auto-load resources can pull it into context without an explicit tool call.',
    mimeType: 'application/json',
    handler: async () =>
      computeVaultOverview({
        reader: entry.reader,
        provider: entry.provider!,
        graph: entry.graph,
      }),
  };
}
