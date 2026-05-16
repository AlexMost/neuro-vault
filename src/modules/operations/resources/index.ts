import { registerResource } from '../../../lib/resource-registry.js';
import type { ResourceRegistration } from '../../../lib/resource-registration.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { buildVaultOverviewResource } from './vault-overview.js';

export interface IOperationsResourceDeps {
  registry: IVaultRegistry;
}

export function buildOperationsResources(deps: IOperationsResourceDeps): ResourceRegistration[] {
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
