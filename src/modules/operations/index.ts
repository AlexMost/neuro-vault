import { buildOperationsTools, type IOperationsToolDeps } from './tools/index.js';
import { buildOperationsResources } from './resources/index.js';
import type { ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import type { VaultProvider } from '../../lib/obsidian/vault-provider.js';
import type { IVaultRegistry } from '../../lib/vault-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { ResourceRegistration } from '../../lib/resource-registration.js';

// empty body — reserved for future module-level options
export interface IOperationsModuleConfig {}

export interface IOperationsModuleDeps {
  // Legacy override hook. Reserved for callers that want to inject a custom
  // VaultProvider; today it's unused inside the module (the registry holds
  // the provider). Kept for back-compat with NeuroVaultStartupDependencies.
  vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider;
}

export interface IOperationsModule {
  tools: ToolRegistration[];
  resources: ResourceRegistration[];
}

export function createOperationsModule(
  registry: IVaultRegistry,
  _config: IOperationsModuleConfig = {},
  _deps: IOperationsModuleDeps = {},
): IOperationsModule {
  const toolDeps: IOperationsToolDeps = { registry };
  return {
    tools: buildOperationsTools(toolDeps),
    resources: buildOperationsResources({ registry }),
  };
}
