import { ObsidianCLIProvider, type ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import { createOperationsHandlers } from './tool-handlers.js';
import { buildOperationsTools } from './tools.js';
import type { VaultProvider } from './vault-provider.js';
import { FsVaultReader, type VaultReader } from './vault-reader.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';

export interface OperationsModuleConfig {
  vaultPath: string;
  binaryPath?: string;
}

export interface OperationsModuleDeps {
  vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider;
  vaultReaderFactory?: (opts: { vaultRoot: string }) => VaultReader;
}

export interface OperationsModule {
  tools: ToolRegistration[];
}

export function createOperationsModule(
  config: OperationsModuleConfig,
  deps: OperationsModuleDeps = {},
): OperationsModule {
  const providerFactory =
    deps.vaultProviderFactory ??
    ((opts: ObsidianCLIProviderOptions) => new ObsidianCLIProvider(opts));
  const readerFactory =
    deps.vaultReaderFactory ?? ((opts) => new FsVaultReader({ vaultRoot: opts.vaultRoot }));

  const provider = providerFactory({ binaryPath: config.binaryPath });
  const reader = readerFactory({ vaultRoot: config.vaultPath });
  const handlers = createOperationsHandlers({ provider, reader });

  return { tools: buildOperationsTools(handlers, { provider, reader }) };
}
