import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type ISemanticModuleDeps } from './modules/semantic/index.js';
import { createOperationsModule } from './modules/operations/index.js';
import { VaultRegistry, type IVaultEntryDeps, type IVaultRegistry } from './lib/vault-registry.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { FsVaultWriter } from './lib/obsidian/vault-writer.js';
import { WikilinkGraphIndex } from './lib/obsidian/wikilink-graph.js';
import { createListMatchingPaths } from './lib/obsidian/query/index.js';
import { FsVaultProvider } from './modules/operations/fs-vault-provider.js';
import { createSmartConnectionsCorpusIndex } from './lib/obsidian/smart-connections-corpus-index.js';
import { createExistingPathFilter } from './lib/obsidian/existing-paths.js';
import { readVaultConventions } from './lib/obsidian/vault-conventions.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import type { ToolRegistration } from './lib/tool-registration.js';
import type { ResourceRegistration } from './lib/resource-registration.js';
import type { ServerConfig } from './types.js';

const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};

type ToolServer = Pick<McpServer, 'registerTool' | 'registerResource' | 'connect'>;

export interface NeuroVaultStartupDependencies {
  semantic?: ISemanticModuleDeps;
  vaultEntryDeps?: Partial<IVaultEntryDeps>;
  serverFactory?: (instructions: string) => ToolServer;
  transportFactory?: () => StdioServerTransport;
}

/**
 * The server-authored half of the MCP `instructions` string, kept deliberately
 * tiny. Claude Code truncates `instructions` at 2048 characters and gives
 * sub-agents none of it, so this preamble has to leave room for the
 * owner-authored conventions block that `buildServerInstructions` emits ahead
 * of it. Everything a tool can say about itself — parameters, result shape,
 * multi-vault behaviour — belongs in that tool's `description`, which every
 * client receives in full. See docs/architecture/vault-conventions.md.
 */
const STATIC_SERVER_INSTRUCTIONS = `\
## About this vault server

This vault is the user's second brain — planning notes, decisions, reflections — and it usually outlives the project in front of you. Before brainstorming, writing a retrospective, or answering "why did we decide X", look here first; the answer often lives nowhere else.

Exact anchor (path, daily note, tag, frontmatter field) → vault operations. Fuzzy recall or a conceptual question → \`search_notes\`. Each tool's own description carries the rest — parameters, result shape, multi-vault behaviour.

You do not know how the user scopes notes to this project. Find out in this order: \`get_vault_overview\`, then \`search_notes\` on the project name, then ask the user.`;

export async function buildServerInstructions(registry: IVaultRegistry): Promise<string> {
  // Conventions first, deliberately: the client truncates this string and the
  // owner-authored block is the only part no tool description can substitute
  // for. The preamble behind it is sized to fit in what is left.
  const blocks: string[] = [];
  for (const entry of registry.list()) {
    const conventions = await entry.readConventions();
    if (conventions !== null && conventions !== '') {
      const heading = registry.isMulti()
        ? `## Vault-specific conventions — ${entry.name}`
        : '## Vault-specific conventions';
      blocks.push(`${heading}\n\n${conventions}`);
    }
  }
  blocks.push(STATIC_SERVER_INSTRUCTIONS);
  return blocks.join('\n\n');
}

function defaultServerFactory(instructions: string): ToolServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
}

function defaultTransportFactory(): StdioServerTransport {
  return new StdioServerTransport();
}

function buildDefaultVaultEntryDeps(overrides: Partial<IVaultEntryDeps> = {}): IVaultEntryDeps {
  return {
    readerFactory: ({ vaultRoot, scope }) => new FsVaultReader({ vaultRoot, scope }),
    scopeFactory: ({ vaultRoot }) => loadVaultScope(vaultRoot),
    writerFactory: ({ vaultRoot }) => new FsVaultWriter({ vaultRoot }),
    graphFactory: ({ reader }) => new WikilinkGraphIndex({ reader }),
    listMatchingPathsFactory: ({ reader, graph }) => createListMatchingPaths({ reader, graph }),
    providerFactory: ({ vaultRoot, reader }) => new FsVaultProvider({ vaultRoot, reader }),
    corpusFactory: ({ smartEnvPath, modelKey }) =>
      createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey }),
    conventionsReaderFactory:
      ({ vaultRoot }) =>
      () =>
        readVaultConventions(vaultRoot),
    existingPathFilterFactory: ({ vaultRoot }) => createExistingPathFilter({ vaultRoot }),
    ...overrides,
  };
}

export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const registry = await VaultRegistry.create(
    {
      vaults: config.vaults,
      semanticEnabled: config.semantic.enabled,
      modelKey: config.semantic.modelKey,
    },
    buildDefaultVaultEntryDeps(deps.vaultEntryDeps),
  );

  const instructions = await buildServerInstructions(registry);
  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const server = serverFactory(instructions);

  const toolRegistrations: ToolRegistration[] = [];
  const resourceRegistrations: ResourceRegistration[] = [];
  let warmup: () => Promise<void> = async () => {};

  if (config.semantic.enabled) {
    const semantic = createSemanticModule(
      registry,
      { modelKey: config.semantic.modelKey, modelId: config.semantic.modelId },
      deps.semantic,
    );
    toolRegistrations.push(...semantic.tools);
    warmup = semantic.warmup;
  }

  const operations = createOperationsModule(registry);
  toolRegistrations.push(...operations.tools);
  resourceRegistrations.push(...operations.resources);

  for (const tool of toolRegistrations) {
    server.registerTool(tool.name, tool.spec, tool.handler);
  }
  for (const resource of resourceRegistrations) {
    server.registerResource(resource.name, resource.uri, resource.metadata, resource.handler);
  }

  await server.connect(transportFactory());
  void warmup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`semantic warmup failed: ${message}\n`);
  });
}
