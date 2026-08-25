import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type ISemanticModuleDeps } from './modules/semantic/index.js';
import { createOperationsModule } from './modules/operations/index.js';
import { VaultRegistry, type IVaultEntryDeps } from './lib/vault-registry.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { FsVaultWriter } from './lib/obsidian/vault-writer.js';
import { WikilinkGraphIndex } from './lib/obsidian/wikilink-graph.js';
import { createListMatchingPaths } from './lib/obsidian/query/index.js';
import { FsVaultProvider } from './modules/operations/fs-vault-provider.js';
import { createSmartConnectionsCorpusIndex } from './lib/obsidian/smart-connections-corpus-index.js';
import { buildBasenameIndex } from './lib/obsidian/link-resolver.js';
import type { BackendStatus, SemanticBackend } from './lib/obsidian/semantic-backend.js';
import { createExistingPathFilter } from './lib/obsidian/existing-paths.js';
import { readVaultConventions } from './lib/obsidian/vault-conventions.js';
import { loadVaultConfig } from './lib/obsidian/vault-config.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import type { ToolRegistration } from './lib/tool-registration.js';
import type { ResourceRegistration } from './lib/resource-registration.js';
import type { ServerConfig } from './types.js';
import { packageMeta } from './package-meta.js';

const { name: SERVER_NAME, version: SERVER_VERSION } = packageMeta;

type ToolServer = Pick<McpServer, 'registerTool' | 'registerResource' | 'connect'>;

export interface NeuroVaultStartupDependencies {
  semantic?: ISemanticModuleDeps;
  vaultEntryDeps?: Partial<IVaultEntryDeps>;
  serverFactory?: (instructions: string) => ToolServer;
  transportFactory?: () => StdioServerTransport;
}

/**
 * The MCP `instructions` string. A constant: identical for every registry,
 * independent of how many vaults are configured, what they are named, and
 * whether any of them has a conventions file.
 *
 * It carries no vault content by design. Claude Code truncates `instructions`
 * at 2048 characters *per server, not per vault*, and gives sub-agents none of
 * it — so an owner's `for-external-agents.md` composed in here reached the
 * first vault only, and above ~1,316 characters deleted this preamble instead.
 * Conventions travel on the `get_vault_overview` response, which is uncapped,
 * read fresh per call, and reaches sub-agents; all this string carries is the
 * pointer to it. See ADR-0012 and docs/architecture/vault-conventions.md.
 *
 * The freed budget is headroom, not an allowance: anything a tool can say
 * about itself belongs in that tool's `description` (ADR-0010), so do not grow
 * this to fill 2048.
 */
export const SERVER_INSTRUCTIONS = `\
## About this vault server

This vault is the user's second brain — planning notes, decisions, reflections — and it usually outlives the project in front of you. Before brainstorming, writing a retrospective, or answering "why did we decide X", look here first; the answer often lives nowhere else.

Exact anchor (path, daily note, tag, frontmatter field) → vault operations. Fuzzy recall or a conceptual question → \`search_notes\`. Each tool's own description carries the rest — parameters, result shape, multi-vault behaviour.

You do not know how the user scopes notes to this project. Find out in this order: \`get_vault_overview\`, then \`search_notes\` on the project name, then ask the user.

This server's vaults may carry owner-authored conventions — how notes are organised, which folders are off-limits, what \`type\` values exist. They arrive on the \`get_vault_overview\` response, not here; call it before reading or writing notes.`;

function defaultServerFactory(instructions: string): ToolServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
}

function defaultTransportFactory(): StdioServerTransport {
  return new StdioServerTransport();
}

/**
 * Interim adapter, Task 7 → Task 8 handoff. The vault registry (design D9)
 * now takes its semantic backend from a synchronous per-vault factory rather
 * than an awaited startup probe; this wraps today's read-only Smart
 * Connections plugin corpus behind that seam so the server keeps serving
 * exactly what it served before this branch, without redesigning what it
 * serves. Task 8 replaces this wholesale with `createOwnCorpusBackendFactory`
 * (the vault's own corpus, watched for live updates) — this function and its
 * `createSmartConnectionsCorpusIndex` import go with it.
 */
function createSmartConnectionsBackend(opts: {
  smartEnvPath: string;
  modelKey: string;
  enabled: boolean;
}): SemanticBackend {
  if (!opts.enabled) {
    return {
      snapshot: () =>
        Promise.resolve({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
      status: () => ({ state: 'disabled' }),
      dispose: async () => {},
    };
  }

  let status: BackendStatus = { state: 'indexing', indexed: 0, total: 0 };
  const loaded = createSmartConnectionsCorpusIndex({
    smartEnvPath: opts.smartEnvPath,
    modelKey: opts.modelKey,
  })
    .then(async (corpus) => {
      const snap = await corpus.snapshot();
      if (snap.sources.size === 0) {
        status = { state: 'unavailable', reason: 'Smart Connections corpus is empty' };
        return undefined;
      }
      status = { state: 'ready' };
      return corpus;
    })
    .catch((err: unknown) => {
      status = { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
      return undefined;
    });

  return {
    snapshot: async () => {
      const corpus = await loaded;
      if (!corpus) {
        throw new Error(
          status.state === 'unavailable' ? status.reason : 'semantic corpus unavailable',
        );
      }
      return corpus.snapshot();
    },
    status: () => status,
    dispose: async () => {},
  };
}

function buildDefaultVaultEntryDeps(
  modelKey: string,
  overrides: Partial<IVaultEntryDeps> = {},
): IVaultEntryDeps {
  return {
    readerFactory: ({ vaultRoot, scope }) => new FsVaultReader({ vaultRoot, scope }),
    vaultConfigFactory: ({ vaultRoot }) => loadVaultConfig(vaultRoot),
    scopeFactory: ({ vaultRoot, config }) => loadVaultScope(vaultRoot, { config }),
    writerFactory: ({ vaultRoot }) => new FsVaultWriter({ vaultRoot }),
    graphFactory: ({ reader }) => new WikilinkGraphIndex({ reader }),
    listMatchingPathsFactory: ({ reader, graph }) => createListMatchingPaths({ reader, graph }),
    providerFactory: ({ vaultRoot, reader }) => new FsVaultProvider({ vaultRoot, reader }),
    semanticBackendFactory: ({ vaultRoot, enabled }) =>
      createSmartConnectionsBackend({
        smartEnvPath: path.join(vaultRoot, '.smart-env', 'multi'),
        modelKey,
        enabled,
      }),
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
    buildDefaultVaultEntryDeps(config.semantic.modelKey, deps.vaultEntryDeps),
  );

  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const server = serverFactory(SERVER_INSTRUCTIONS);

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
