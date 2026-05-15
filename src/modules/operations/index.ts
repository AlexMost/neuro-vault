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
  // Transitional shape: tool handlers in Task 7 still close over a single
  // entry's primitives. Pull entry 0 here; Task 7 migrates handlers to
  // resolveVault(input, registry, ...) directly.
  const entry = registry.list()[0];
  if (!entry.provider || !entry.writer) {
    throw new Error('createOperationsModule called without operations enabled');
  }
  const toolDeps: OperationsToolDeps = {
    registry,
    provider: entry.provider,
    reader: entry.reader,
    writer: entry.writer,
    graph: entry.graph,
  };
  return {
    tools: buildOperationsTools(toolDeps),
    resources: buildOperationsResources({
      reader: entry.reader,
      provider: entry.provider,
      graph: entry.graph,
    }),
  };
}
