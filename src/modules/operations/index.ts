import { ObsidianCLIProvider, type ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import { buildOperationsTools, type OperationsToolDeps } from './tools/index.js';
import type { VaultProvider } from '../../lib/obsidian/vault-provider.js';
import { FsVaultReader, type VaultReader } from '../../lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../lib/obsidian/wikilink-graph.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';

export interface OperationsModuleConfig {
  vaultPath: string;
  binaryPath?: string;
}

export interface OperationsModuleDeps {
  vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider;
  vaultReaderFactory?: (opts: { vaultRoot: string }) => VaultReader;
  graph?: WikilinkGraphIndex;
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
  const graph = deps.graph ?? new WikilinkGraphIndex({ reader });

  const toolDeps: OperationsToolDeps = { provider, reader, graph };
  return { tools: buildOperationsTools(toolDeps) };
}
