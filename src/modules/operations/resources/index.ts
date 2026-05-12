import { registerResource } from '../../../lib/resource-registry.js';
import type { ResourceRegistration } from '../../../lib/resource-registration.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import { buildVaultOverviewResource } from './vault-overview.js';

export interface OperationsResourceDeps {
  reader: VaultReader;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
}

export function buildOperationsResources(deps: OperationsResourceDeps): ResourceRegistration[] {
  return [registerResource(buildVaultOverviewResource(deps))];
}
