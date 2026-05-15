import { registerResource } from '../../../lib/resource-registry.js';
import type { ResourceRegistration } from '../../../lib/resource-registration.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { buildVaultOverviewResource } from './vault-overview.js';

export interface OperationsResourceDeps {
  registry: VaultRegistry;
}

export function buildOperationsResources(deps: OperationsResourceDeps): ResourceRegistration[] {
  const { registry } = deps;
  if (!registry.isMulti()) {
    const entry = registry.list()[0];
    return [registerResource(buildVaultOverviewResource({ uri: 'vault://overview', entry }))];
  }
  return registry
    .list()
    .map((entry) =>
      registerResource(
        buildVaultOverviewResource({ uri: `vault://${entry.name}/overview`, entry }),
      ),
    );
}
