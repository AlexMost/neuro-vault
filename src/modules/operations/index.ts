import { buildOperationsTools, type OperationsToolDeps } from './tools/index.js';
import { buildOperationsResources } from './resources/index.js';
import type { ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import type { VaultProvider } from '../../lib/obsidian/vault-provider.js';
import type { VaultRegistry } from '../../lib/vault-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { ResourceRegistration } from '../../lib/resource-registration.js';

export interface OperationsModuleConfig {
  binaryPath?: string;
}

export interface OperationsModuleDeps {
  // Legacy override hook. Reserved for callers that want to inject a custom
  // VaultProvider; today it's unused inside the module (the registry holds
  // the provider). Kept for back-compat with NeuroVaultStartupDependencies.
  vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider;
}

export interface OperationsModule {
  tools: ToolRegistration[];
  resources: ResourceRegistration[];
}

export function createOperationsModule(
  registry: VaultRegistry,
  _config: OperationsModuleConfig = {},
  _deps: OperationsModuleDeps = {},
): OperationsModule {
  const entry = registry.list()[0];
  if (!entry.provider || !entry.writer) {
    throw new Error('createOperationsModule called without operations enabled');
  }
  const toolDeps: OperationsToolDeps = { registry };
  return {
    tools: buildOperationsTools(toolDeps),
    resources: buildOperationsResources({
      reader: entry.reader, // resources still single-vault until Task 9
      provider: entry.provider,
      graph: entry.graph,
    }),
  };
}
