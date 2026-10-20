import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  createEmbeddingProvider,
  createLexicalOnlyTools,
  createQueuedEmbedder,
  createSemanticModule,
  createSharedServices,
  createVaultClients,
  createLexicalOnlyVaultFactories,
  SharedServicesClosedError,
  type EmbeddingProvider,
  type ISemanticModuleDeps,
  type ISharedServices,
  type IVaultClients,
} from './modules/semantic/index.js';
import { createOperationsModule, operationsVaultFactories } from './modules/operations/index.js';
import {
  defaultVaultDeps,
  VaultRegistry,
  type IRegisteredVaultDeps,
} from './lib/vault-registry.js';
import type { ToolRegistration } from './lib/tool-registration.js';
import type { ResourceRegistration } from './lib/resource-registration.js';
import type { ServerConfig } from './types.js';
import { packageMeta } from './package-meta.js';

const { name: SERVER_NAME, version: SERVER_VERSION } = packageMeta;

type ToolServer = Pick<McpServer, 'registerTool' | 'registerResource' | 'connect'>;

/**
 * Just enough of the transport's input stream to notice a client hanging up.
 * Narrow on purpose: nothing here reads stdin — the transport owns that — this
 * only observes the end of it.
 */
export interface StdinLike {
  once(event: 'end' | 'close', listener: () => void): unknown;
}

export interface NeuroVaultStartupDependencies {
  semantic?: ISemanticModuleDeps;
  vaultEntryDeps?: Partial<IRegisteredVaultDeps>;
  serverFactory?: (instructions: string) => ToolServer;
  transportFactory?: () => StdioServerTransport;
  /**
   * The stream the transport reads; defaults to `process.stdin`. Injected so a
   * test can hang up for real — by ending a pipe — instead of firing the close
   * hook by hand. Pass the same stream the `transportFactory` transport reads.
   */
  stdin?: StdinLike;
  /** Realpath of the running CLI script; the shared embedding daemon is keyed by it. */
  cliPath?: string;
  /** Replaces the provider the factory would build. For tests. */
  embeddingProvider?: EmbeddingProvider;
  /** Replaces the process's daemon connection and fallback switch. For tests. */
  sharedServices?: ISharedServices;
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
 * Boots the server and returns a disposer that releases every vault's
 * background resources. The disposer also runs on transport close, and
 * end-of-input on stdin closes the transport — so a client that disconnects
 * takes the watchers down with it. chokidar holds the event loop open, and
 * without both halves of that wiring the process would outlive the client that
 * started it (design D10). The return value exists for tests and for future
 * callers that shut the server down themselves; `cli.ts` ignores it and lets
 * the hang-up do the work.
 */
export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<() => Promise<void>> {
  // One model, one embed in flight process-wide (design D7): every vault's
  // indexing and every query share this queue, with queries jumping ahead. By
  // default the model itself lives in the shared daemon and this queue sits in
  // front of the facade; the daemon's own per-profile queue orders requests
  // across sessions.
  const shared = config.semantic.shared;
  const services =
    deps.sharedServices ??
    createSharedServices({ shared, cliPath: deps.cliPath, version: SERVER_VERSION });
  const provider =
    deps.embeddingProvider ??
    createEmbeddingProvider({ profile: config.semantic.model, shared }, services);
  const embedder = createQueuedEmbedder(provider);
  // Each vault's corpus and lexical cache: the daemon's vault entry, or this
  // process's own when `--no-shared` or the daemon cannot be started (design
  // D8, D11, D12). Under `--no-semantic` there are no vault clients at all
  // (brainstorm F1): nothing calls `services.ensure()`, so no daemon starts.
  const clients: IVaultClients | undefined = config.semantic.enabled
    ? createVaultClients({ services, shared, profile: config.semantic.model.key, embedder })
    : undefined;

  const registry = await VaultRegistry.create(
    {
      vaults: config.vaults,
      semanticEnabled: config.semantic.enabled,
    },
    defaultVaultDeps(
      { ...operationsVaultFactories, ...(clients ?? createLexicalOnlyVaultFactories()) },
      deps.vaultEntryDeps,
    ),
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
      { profile: config.semantic.model },
      // The retrieval path embeds through the same queue as indexing, on the
      // query lane — so a search issued mid cold-index is not stuck behind
      // thousands of queued note embeds (design D7).
      { embeddingServiceFactory: () => embedder.asProvider(), ...deps.semantic },
    );
    toolRegistrations.push(...semantic.tools);
    warmup = semantic.warmup;
  } else {
    // `search_notes` does not need the embedding corpus for its lexical leg, so
    // it outlives the module; only the tools with no non-semantic leg go.
    toolRegistrations.push(...createLexicalOnlyTools(registry, { profile: config.semantic.model }));
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
  // Every vault attaches now, in the background, so the corpus and the lexical
  // cache start building before the first tool call. A backend's first
  // `status()` makes its vault client attach — the connect and `vault.attach`
  // on the daemon side, the in-process entry on the other; the vault's lexical
  // reader is a view over the same client, so it shares that one attach, and
  // its `warm()` is what attaches a vault that opted out with
  // `"semantic": false` — with no profile, so nothing indexes it (its backend
  // is a constant that never attaches). The status reads start first, so each
  // backend's first answer is its own attach; the standalone reader of a
  // `--no-semantic` session has nothing to warm. Nothing waits on any of this
  // — a call that arrives before an attach answers, even while the daemon is
  // still being located or started, reads `indexing` 0/0, and so do these
  // reads then — and a warm never rejects. The status reads are the one per
  // vault at startup; the warmup decision below reuses them, and `indexing`
  // counts as embedding.
  const attaches = registry
    .list()
    .flatMap((entry) => (entry.backend === undefined ? [] : [entry.backend.status()]));
  for (const entry of registry.list()) void entry.lexical.warm();
  /** Set once teardown starts: a warmup decided after it must not reconnect to the daemon. */
  let disposed = false;
  // The module-level flag says the tools exist; it does not say any vault will
  // ever embed. When every registered vault opted out with `"semantic": false`,
  // no indexing pass and no query embed can run — warming the model would
  // download and initialize ONNX for work that will never arrive. The tools
  // stay registered either way: `search_notes` still answers from its lexical
  // leg, and the embeddings-only tools still report `SEMANTIC_DISABLED`.
  void Promise.all(attaches)
    .then((statuses) =>
      statuses.some((status) => status.state !== 'disabled') && !disposed ? warmup() : undefined,
    )
    .catch((error: unknown) => {
      // A warmup in flight at hang-up meets the closed services, or loses its daemon
      // handshake to the closed connection: teardown, not a failure worth a line.
      if (error instanceof SharedServicesClosedError || disposed) return;
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
    disposed = true;
    // A request pending on the shared daemon would hold the event loop open.
    services.close();
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
    // The in-process vault entries, if any vault needed them: their watchers,
    // timers and the pass in flight would otherwise outlive the client.
    try {
      await clients?.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`semantic vault entries disposal failed: ${message}\n`);
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

  /**
   * End of input is how a stdio client hangs up, and nothing else reports it:
   * `StdioServerTransport` registers only `'data'` and `'error'` on stdin, so
   * its `onclose` fires from an explicit `close()` and from nothing else.
   * Without this hookup the chain above is never pulled — a client that simply
   * closes the pipe leaves the chokidar watchers holding the event loop open,
   * and the server outlives it indefinitely (measured: still alive 60 s after
   * stdin EOF). That is exactly the failure design D10 exists to prevent.
   *
   * `'close'` as well as `'end'`, because stdin destroyed without EOF — the fd
   * closed under us — emits only the former, and that is a hang-up too. Both
   * routes go through `transport.close()` rather than calling `dispose()`
   * directly, so there stays exactly one teardown path and the SDK's own
   * `onclose` (aborting in-flight handlers) runs as well as ours.
   *
   * Signals are deliberately not handled: `SIGINT`/`SIGTERM` already terminate
   * the process by default, and installing handlers would replace that
   * unstarvable default with teardown of our own that could hang. Corpus
   * writes are atomic (temp + rename), so an abrupt signal cannot corrupt one.
   */
  let closing = false;
  const handleHangUp = (): void => {
    if (closing) return;
    closing = true;
    void transport.close().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`transport close failed: ${message}\n`);
    });
  };
  const stdin = deps.stdin ?? process.stdin;
  stdin.once('end', handleHangUp);
  stdin.once('close', handleHangUp);

  return dispose;
}
