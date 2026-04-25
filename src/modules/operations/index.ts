import { ObsidianCLIProvider, type ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import { createOperationsHandlers } from './tool-handlers.js';
import { buildOperationsTools } from './tools.js';
import type { VaultProvider } from './vault-provider.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';

export interface OperationsModuleConfig {
  binaryPath?: string;
}

export interface OperationsModuleDeps {
  vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider;
}

export interface OperationsModule {
  tools: ToolRegistration[];
}

export function createOperationsModule(
  config: OperationsModuleConfig,
  deps: OperationsModuleDeps = {},
): OperationsModule {
  const factory =
    deps.vaultProviderFactory ??
    ((opts: ObsidianCLIProviderOptions) => new ObsidianCLIProvider(opts));

  const provider = factory({ binaryPath: config.binaryPath });
  const handlers = createOperationsHandlers({ provider });

  return { tools: buildOperationsTools(handlers) };
}
