import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type ISemanticModuleDeps } from './modules/semantic/index.js';
import { createQueuedEmbedder, type QueuedEmbedder } from './modules/semantic/embed-queue.js';
import { EmbeddingService } from './modules/semantic/embedding-service.js';
import { createOwnCorpusBackendFactory } from './modules/semantic/backend/index.js';
import { createOperationsModule } from './modules/operations/index.js';
import { VaultRegistry, type IVaultEntryDeps } from './lib/vault-registry.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { FsVaultWriter } from './lib/obsidian/vault-writer.js';
import { WikilinkGraphIndex } from './lib/obsidian/wikilink-graph.js';
import { createListMatchingPaths } from './lib/obsidian/query/index.js';
import { FsVaultProvider } from './modules/operations/fs-vault-provider.js';
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

function buildDefaultVaultEntryDeps(
  embedder: QueuedEmbedder,
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
    semanticBackendFactory: createOwnCorpusBackendFactory({ embedder }),
    conventionsReaderFactory:
      ({ vaultRoot }) =>
      () =>
        readVaultConventions(vaultRoot),
    existingPathFilterFactory: ({ vaultRoot }) => createExistingPathFilter({ vaultRoot }),
    ...overrides,
  };
}

/**
 * Boots the server and returns a disposer that releases every vault's
 * background resources. The disposer is also wired to the transport's
 * `onclose`, so a client that disconnects takes the watchers down with it —
 * chokidar holds the event loop open, and without this the process would
 * outlive the client that started it (design D10). The return value exists for
 * tests and for future callers that shut the server down themselves; `cli.ts`
 * ignores it and lets `onclose` do the work.
 */
export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<() => Promise<void>> {
  // One model, one embed in flight process-wide (design D7): every vault's
  // indexing and every query share this queue, with queries jumping ahead.
  const embedder = createQueuedEmbedder(new EmbeddingService({ modelId: config.semantic.modelId }));

  const registry = await VaultRegistry.create(
    {
      vaults: config.vaults,
      semanticEnabled: config.semantic.enabled,
    },
    buildDefaultVaultEntryDeps(embedder, deps.vaultEntryDeps),
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
      // The retrieval path embeds through the same queue as indexing, on the
      // query lane — so a search issued mid cold-index is not stuck behind
      // thousands of queued note embeds (design D7).
      { embeddingServiceFactory: () => embedder.asProvider(), ...deps.semantic },
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

  const transport = transportFactory();
  await server.connect(transport);
  void warmup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`semantic warmup failed: ${message}\n`);
  });

  /**
   * Releases every vault's background resources. Never rejects: one vault's
   * failure is reported to stderr and the others still get disposed. It is
   * called from `onclose` as `void dispose()`, and an unhandled rejection
   * there is `ERR_UNHANDLED_REJECTION` on Node ≥ 20 — a crash in place of the
   * clean teardown this exists to produce.
   */
  const dispose = async (): Promise<void> => {
    // `async` per entry so a backend whose `dispose()` throws synchronously
    // becomes one settled rejection rather than blowing up the whole map.
    const results = await Promise.allSettled(
      registry.list().map(async (entry) => entry.backend?.dispose()),
    );
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      process.stderr.write(`semantic backend disposal failed: ${message}\n`);
    }
  };

  // `server.connect()` installs the MCP SDK's own `onclose` (it aborts
  // in-flight request handlers and rejects pending responses), so chain onto
  // it rather than replacing it — a bare assignment here would silently
  // disable the protocol's own teardown. `finally`, so a throw from the
  // protocol's handler cannot skip disposal and leave the watchers holding
  // the event loop open past the client that started us (design D10).
  const protocolOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      protocolOnClose?.();
    } finally {
      void dispose();
    }
  };
  return dispose;
}
