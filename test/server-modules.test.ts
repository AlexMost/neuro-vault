import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once as onceEvent } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { modelCorpusDir } from '../src/lib/obsidian/corpus/layout.js';
import type { BackendStatus, ISemanticBackend } from '../src/lib/obsidian/semantic-backend.js';
import { main } from '../src/cli.js';
import { DEFAULT_MODEL_KEY, identityOf, resolveModelProfile } from '../src/lib/model-profiles.js';
import { VaultEntries } from '../src/lib/vault-entry/index.js';
import { DaemonEmbeddingProvider } from '../src/modules/semantic/daemon-embedding-provider.js';
import { createSharedServices } from '../src/modules/semantic/shared-services.js';
import { createStandaloneLexicalReader } from '../src/modules/semantic/lexical/index.js';
import type { IRegisteredVaultDeps } from '../src/lib/vault-registry.js';
import { startNeuroVaultServer } from '../src/server.js';

function createTempVaultPath() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-server-'));
}

function createFakeServer() {
  const registeredToolNames: string[] = [];
  const registeredResourceUris: string[] = [];
  const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    registeredToolNames,
    registeredResourceUris,
    toolHandlers,
    registerTool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1] as (a: unknown) => Promise<unknown>;
      registeredToolNames.push(name);
      toolHandlers.set(name, handler);
      return {} as never;
    }) as never,
    registerResource: vi.fn((_name: string, uri: string) => {
      registeredResourceUris.push(uri);
      return {} as never;
    }) as never,
    connect: vi.fn().mockResolvedValue(undefined),
  };
}

/** A backend parked in `status`, whose reads answer nothing. */
function fakeBackend(
  status: BackendStatus = { state: 'ready' },
  dispose: () => Promise<void> = async () => {},
): ISemanticBackend {
  return {
    nearest: async (anchors) => anchors.map(() => []),
    nearestBlocks: async (anchors) => anchors.map(() => []),
    status: async () => status,
    dispose,
  };
}

/**
 * The lexical leg for a test whose semantic backend is a double: the session's
 * own cache over its reader, so no vault entry is built and no daemon is asked.
 */
const standaloneLexical: IRegisteredVaultDeps['lexicalReaderFactory'] = ({
  vaultRoot,
  reader,
  graph,
}) => createStandaloneLexicalReader({ vaultRoot, reader, graph });

/**
 * Boot the server over a real temp vault with the semantic backend replaced by
 * one parked in a fixed state. What is under test is what the *server* does
 * with a non-`ready` backend — startup tolerance, and the error every semantic
 * tool returns — not how a backend arrives at that state (Task 5's tests own
 * that), so the state is an input here, never the conclusion.
 */
async function startWithBackendStatus(
  status: BackendStatus,
  server: ReturnType<typeof createFakeServer>,
  vaultPath: string,
): Promise<{ initialize: ReturnType<typeof vi.fn> }> {
  const initialize = vi.fn();
  await startNeuroVaultServer(
    {
      vaults: [
        {
          name: path.basename(vaultPath),
          path: vaultPath,
        },
      ],
      semantic: { enabled: true, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: false },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize, embedQuery: vi.fn() }),
      },
      vaultEntryDeps: {
        lexicalReaderFactory: standaloneLexical,
        semanticBackendFactory: () => ({
          ...fakeBackend(status),
          nearest: () => Promise.reject(new Error('the corpus must not be read when not ready')),
          nearestBlocks: () =>
            Promise.reject(new Error('the corpus must not be read when not ready')),
        }),
      },
      serverFactory: (_instructions: string) => server,
      transportFactory: () => ({}) as never,
      // The fake transport has no `close()`, so keep the hang-up wiring off
      // the real `process.stdin` — this stream never ends.
      stdin: new PassThrough(),
    },
  );
  return { initialize };
}

/** Let the fire-and-forget `void dispose()` and Node's rejection check run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Boot the server over `vaultPaths` with a fake transport, so a test can close
 * it by hand. Every vault gets a ready backend whose `dispose()` is
 * `backendDispose(vaultName)` — the name is how a test makes exactly one
 * vault's disposal fail.
 */
async function startForShutdown(opts: {
  vaultPaths: string[];
  backendDispose: (vaultName: string) => Promise<void>;
  protocolOnClose?: () => void;
}): Promise<{ transport: { onclose?: () => void }; protocolOnClose: () => void }> {
  const transport = {} as { onclose?: () => void };
  // The MCP SDK installs its own `onclose` when the server connects — it
  // aborts in-flight request handlers and rejects pending responses. Model
  // that here, so a disposal hook that *replaced* the handler instead of
  // chaining onto it fails these tests rather than silently disabling the
  // protocol's teardown in production.
  const protocolOnClose = opts.protocolOnClose ?? vi.fn();
  const server = createFakeServer();
  server.connect = vi.fn((t: { onclose?: () => void }) => {
    t.onclose = protocolOnClose;
    return Promise.resolve();
  }) as never;

  await startNeuroVaultServer(
    {
      vaults: opts.vaultPaths.map((vaultPath) => ({
        name: path.basename(vaultPath),
        path: vaultPath,
      })),
      semantic: { enabled: true, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: false },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize: vi.fn(), embedQuery: vi.fn() }),
      },
      serverFactory: () => server as never,
      transportFactory: () => transport as never,
      stdin: new PassThrough(),
      vaultEntryDeps: {
        lexicalReaderFactory: standaloneLexical,
        semanticBackendFactory: ({ vaultName }) =>
          fakeBackend({ state: 'ready' }, () => opts.backendDispose(vaultName)),
      },
    },
  );

  return { transport, protocolOnClose };
}

/**
 * Boot the server the way production does — a real `McpServer`, a real
 * `StdioServerTransport`, the real `onclose` chain — with stdin and stdout
 * replaced by in-memory pipes. The only substitution is *which* streams the
 * transport reads and writes, so a test can hang up the way a stdio client
 * does: by closing the pipe. Nothing in the close path is faked, and
 * critically the test cannot fire `onclose` itself — the server has to notice
 * end-of-input on its own or the assertions fail.
 */
async function startOverPipedStdin(opts: {
  vaultPath: string;
  backendDispose: () => Promise<void>;
}): Promise<{ stdin: PassThrough; protocolClosed: ReturnType<typeof vi.fn> }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.resume();
  const protocolClosed = vi.fn();

  await startNeuroVaultServer(
    {
      vaults: [{ name: path.basename(opts.vaultPath), path: opts.vaultPath }],
      semantic: { enabled: true, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: false },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize: vi.fn(), embedQuery: vi.fn() }),
      },
      serverFactory: (instructions: string) => {
        const mcp = new McpServer({ name: 'test', version: '0.0.0' }, { instructions });
        // The protocol's own teardown — it aborts in-flight request handlers
        // and rejects pending responses. Observed here so a fix that bypassed
        // `transport.close()` (calling the disposer directly, say) and left
        // the SDK's half of the teardown unrun fails this test.
        mcp.server.onclose = protocolClosed;
        return mcp;
      },
      transportFactory: () => new StdioServerTransport(stdin, stdout),
      stdin,
      vaultEntryDeps: {
        lexicalReaderFactory: standaloneLexical,
        semanticBackendFactory: () => fakeBackend({ state: 'ready' }, opts.backendDispose),
      },
    },
  );

  return { stdin, protocolClosed };
}

describe('Neuro Vault MCP server bootstrap', () => {
  it('does not warm the embedding model when every vault opted out', async () => {
    const vaultPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nv-warmup-')), 'v');
    await fs.mkdir(vaultPath, { recursive: true });

    const { initialize } = await startWithBackendStatus(
      { state: 'disabled' },
      createFakeServer(),
      vaultPath,
    );
    await settle();

    // No indexing pass and no query embed can run for a disabled vault, so
    // downloading and initializing ONNX is work for calls that never arrive.
    expect(initialize).not.toHaveBeenCalled();
  });

  it('warms the embedding model when a vault can still embed', async () => {
    const vaultPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nv-warmup-')), 'v');
    await fs.mkdir(vaultPath, { recursive: true });

    const { initialize } = await startWithBackendStatus(
      { state: 'ready' },
      createFakeServer(),
      vaultPath,
    );
    await settle();

    expect(initialize).toHaveBeenCalled();
  });

  it('closes the shared services when it disposes, so a pending daemon request cannot hold the process', async () => {
    const vaultPath = await createTempVaultPath();
    const close = vi.fn();
    const provider = {
      identity: identityOf(resolveModelProfile(DEFAULT_MODEL_KEY)),
      maxBatchSize: 8,
      initialize: vi.fn(async () => {}),
      embedQuery: vi.fn(),
      embedDocuments: vi.fn(),
    };
    const sharedServices = {
      mode: 'daemon' as const,
      connection: {} as never,
      ensure: vi.fn(),
      close,
    };
    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: path.basename(vaultPath), path: vaultPath }],
        semantic: { enabled: true, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: true },
      },
      {
        embeddingProvider: provider,
        sharedServices,
        vaultEntryDeps: {
          semanticBackendFactory: () => fakeBackend(),
          lexicalReaderFactory: standaloneLexical,
        },
        serverFactory: () => createFakeServer() as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    expect(close).not.toHaveBeenCalled();
    await dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('warms up through the injected embedding provider, behind the per-process queue', async () => {
    const vaultPath = await createTempVaultPath();
    const initialize = vi.fn(async () => {});
    const provider = {
      identity: identityOf(resolveModelProfile(DEFAULT_MODEL_KEY)),
      maxBatchSize: 8,
      initialize,
      embedQuery: vi.fn(),
      embedDocuments: vi.fn(),
    };
    await startNeuroVaultServer(
      {
        vaults: [{ name: path.basename(vaultPath), path: vaultPath }],
        semantic: { enabled: true, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: true },
      },
      {
        embeddingProvider: provider,
        vaultEntryDeps: {
          semanticBackendFactory: () => fakeBackend(),
          lexicalReaderFactory: standaloneLexical,
        },
        serverFactory: () => createFakeServer() as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    await settle();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('returns SEMANTIC_INDEX_BUILDING with progress while a vault is still building its corpus (startup tolerant)', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
    const server = createFakeServer();

    try {
      // Startup should NOT throw — a corpus still being built is tolerated at
      // module init time; the backend decides its readiness live (design D9).
      await startWithBackendStatus({ state: 'indexing', indexed: 0, total: 12 }, server, vaultPath);

      // The tool is registered, but calling it on the not-yet-ready vault
      // returns a structured error (not a thrown exception — MCP wraps ToolHandlerError).
      const findDuplicates = server.toolHandlers.get('find_duplicates');
      expect(findDuplicates).toBeDefined();
      const result = await findDuplicates!({});
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'SEMANTIC_INDEX_BUILDING',
          details: { indexed: 0, total: 12 },
        },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns SEMANTIC_INDEX_NOT_FOUND carrying the backend's reason when the corpus is unavailable", async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
    const server = createFakeServer();

    try {
      // Startup should NOT throw — a broken corpus is tolerated at module init time.
      await startWithBackendStatus(
        { state: 'unavailable', reason: 'corpus shard notes/a.json is not valid JSON' },
        server,
        vaultPath,
      );

      const findDuplicates = server.toolHandlers.get('find_duplicates');
      expect(findDuplicates).toBeDefined();
      const result = await findDuplicates!({});
      // The reason travels from the backend into the tool error — in the
      // details as its own field, not prose alone — so an owner (and a
      // client parsing `details`) sees *why* the corpus is unusable rather
      // than a bare code.
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'SEMANTIC_INDEX_NOT_FOUND',
          message: expect.stringContaining('corpus shard notes/a.json is not valid JSON'),
          details: {
            reason: 'corpus shard notes/a.json is not valid JSON',
            hint: expect.stringContaining('neuro-vault-mcp index'),
          },
        },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('disposes every vault backend when the client closes stdin', async () => {
    const vaultPath = await createTempVaultPath();
    const dispose = vi.fn(async () => {});

    try {
      const { stdin, protocolClosed } = await startOverPipedStdin({
        vaultPath,
        backendDispose: dispose,
      });

      // The hang-up a stdio client actually performs: EOF on the server's
      // stdin. `StdioServerTransport` registers only 'data' and 'error' on
      // stdin, so nothing in the SDK turns this into an `onclose` — the
      // server must read end-of-input itself, or the watchers (and the
      // process) outlive the client that started them (design D10).
      stdin.end();
      await onceEvent(stdin, 'end');
      await settle();

      // Exactly once, not merely at least once: a stream that ends also
      // destroys itself, emitting 'close' right after 'end', and teardown is
      // wired to both events — so both handlers have already run by here and
      // these counts are also the idempotency assertion.
      expect(dispose).toHaveBeenCalledTimes(1);
      // …and the protocol's own teardown ran too, rather than being bypassed.
      expect(protocolClosed).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('disposes every vault backend when stdin is destroyed without reaching EOF', async () => {
    const vaultPath = await createTempVaultPath();
    const dispose = vi.fn(async () => {});

    try {
      const { stdin } = await startOverPipedStdin({ vaultPath, backendDispose: dispose });

      // No 'end' here: the pipe is torn down under the server, which is what
      // an abruptly killed host leaves behind. Only 'close' fires.
      stdin.destroy();
      await onceEvent(stdin, 'close');
      await settle();

      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('disposes every vault backend when the transport closes', async () => {
    const vaultPath = await createTempVaultPath();
    const dispose = vi.fn(async () => {});

    try {
      const { transport, protocolOnClose } = await startForShutdown({
        vaultPaths: [vaultPath],
        backendDispose: dispose,
      });

      transport.onclose?.();
      await settle();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(protocolOnClose).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("disposes the other vaults, and raises no unhandled rejection, when one backend's dispose rejects", async () => {
    const [failingPath, healthyPath] = await Promise.all([
      createTempVaultPath(),
      createTempVaultPath(),
    ]);
    const failingName = path.basename(failingPath);
    const healthyDispose = vi.fn(async () => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // The disposal hook is invoked as `void dispose()`, so a rejection that
    // escapes it is ERR_UNHANDLED_REJECTION on Node >= 20 — a stack trace and
    // a non-zero exit in place of the clean teardown design D10 exists for.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { transport } = await startForShutdown({
        vaultPaths: [failingPath, healthyPath],
        backendDispose: (vaultName) =>
          vaultName === failingName
            ? Promise.reject(new Error('watcher close blew up'))
            : healthyDispose(),
      });

      transport.onclose?.();
      await settle();

      // The healthy vault is disposed even though the other one failed first,
      // and the failure is reported on stderr rather than swallowed.
      expect(healthyDispose).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('semantic backend disposal failed: watcher close blew up'),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      stderr.mockRestore();
      await fs.rm(failingPath, { recursive: true, force: true });
      await fs.rm(healthyPath, { recursive: true, force: true });
    }
  });

  it("still disposes every vault backend when the protocol's own onclose throws", async () => {
    const vaultPath = await createTempVaultPath();
    const dispose = vi.fn(async () => {});

    try {
      const { transport } = await startForShutdown({
        vaultPaths: [vaultPath],
        backendDispose: dispose,
        protocolOnClose: vi.fn(() => {
          throw new Error('protocol teardown failed');
        }),
      });

      // The throw still propagates to whoever closed the transport; what must
      // not happen is disposal being skipped — that is precisely the "process
      // outlives its client" failure design D10 targets.
      expect(() => transport.onclose?.()).toThrow('protocol teardown failed');
      await settle();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(vaultPath, { recursive: true, force: true });
    }
  });

  it('registers search_notes plus the eleven operations tools when --no-semantic is passed', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      replaceInNote: vi.fn().mockResolvedValue(undefined),
      replaceFullBody: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
        server: {
          vaultEntryDeps: {
            providerFactory: () => fakeProvider,
            readerFactory: () => ({
              readNotes: vi.fn().mockResolvedValue([]),
              scan: vi.fn().mockResolvedValue([]),
            }),
          },
          serverFactory: (_instructions: string) => server,
          transportFactory: () => ({}) as never,
          // Same reason as the helpers above: with a fake transport that has
          // no `close()`, the hang-up wiring must not land on the real
          // `process.stdin`. This stream never ends.
          stdin: new PassThrough(),
        },
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'read_notes',
        'query_notes',
        'create_note',
        'edit_note',
        'read_daily',
        'set_property',
        'remove_property',
        'list_tags',
        'list_properties',
        'get_note_links',
        'get_vault_overview',
      ]);
      // The tools with no non-semantic leg stay unregistered.
      expect(server.registeredToolNames).not.toContain('get_similar_notes');
      expect(server.registeredToolNames).not.toContain('find_duplicates');
      // Removed tools are absent; the unique low-use tools we keep are present.
      expect(server.registeredToolNames).not.toContain('read_property');
      expect(server.registeredToolNames).toContain('list_properties');
      expect(server.registeredToolNames).toContain('remove_property');
      expect(server.registeredToolNames).toContain('get_note_links');
      expect(server.registeredResourceUris).toEqual(['vault://overview']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('serves search_notes from its lexical leg alone, reporting semantic_status disabled, under --no-semantic', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.writeFile(path.join(vaultPath, 'Heron.md'), '# Heron\n\nA wading bird.\n');
    await fs.writeFile(path.join(vaultPath, 'Other.md'), '# Other\n\nNothing relevant.\n');

    const server = createFakeServer();
    // Any embedding work under --no-semantic is a bug: the factory must not be
    // reached, and nothing may be embedded.
    const embeddingServiceFactory = vi.fn();

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
        server: {
          semantic: { embeddingServiceFactory },
          serverFactory: (_instructions: string) => server,
          transportFactory: () => ({}) as never,
          stdin: new PassThrough(),
        },
      });

      const searchNotes = server.toolHandlers.get('search_notes');
      expect(searchNotes).toBeDefined();
      const result = (await searchNotes!({ query: 'heron' })) as {
        isError?: boolean;
        structuredContent?: {
          matches: { path: string; found_in: string[] }[];
          semantic_status: { state: string; note?: string };
        };
      };

      expect(result.isError).not.toBe(true);
      const payload = result.structuredContent!;
      expect(payload.matches.map((m) => m.path)).toEqual(['Heron.md']);
      expect(payload.matches[0].found_in.every((f) => f.startsWith('lexical:'))).toBe(true);
      expect(payload.semantic_status).toEqual({
        state: 'disabled',
        note: expect.stringContaining('lexical-only'),
      });
      expect(embeddingServiceFactory).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('--no-semantic opens no connection, at startup or on a search_notes call', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.writeFile(path.join(vaultPath, 'Heron.md'), '# Heron\n\nA wading bird.\n');
    const request = vi.fn();
    const sharedServices = {
      mode: 'pending' as const,
      connection: { epoch: 1, ensure: vi.fn(), close: vi.fn(), request } as never,
      ensure: vi.fn(async () => 'daemon' as const),
      close: vi.fn(),
    };
    const server = createFakeServer();

    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'vault', path: vaultPath }],
        semantic: { enabled: false, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: true },
      },
      {
        sharedServices,
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      await settle();
      const result = (await server.toolHandlers.get('search_notes')!({ query: 'heron' })) as {
        isError?: boolean;
        structuredContent?: { matches: { path: string }[] };
      };
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent!.matches.map((m) => m.path)).toEqual(['Heron.md']);
      expect(sharedServices.ensure).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await dispose();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers fourteen tools (3 semantic + 11 operations) when both modules are enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      replaceInNote: vi.fn().mockResolvedValue(undefined),
      replaceFullBody: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        server: {
          vaultEntryDeps: {
            semanticBackendFactory: () => fakeBackend(),
            lexicalReaderFactory: standaloneLexical,
            providerFactory: () => fakeProvider,
            readerFactory: () => ({
              readNotes: vi.fn().mockResolvedValue([]),
              scan: vi.fn().mockResolvedValue([]),
            }),
          },
          semantic: {
            embeddingServiceFactory: () => ({
              initialize: vi.fn().mockResolvedValue(undefined),
              embedQuery: vi.fn(),
            }),
          },
          serverFactory: (_instructions: string) => server,
          transportFactory: () => ({}) as never,
          // Same reason as the helpers above: with a fake transport that has
          // no `close()`, the hang-up wiring must not land on the real
          // `process.stdin`. This stream never ends.
          stdin: new PassThrough(),
        },
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'read_notes',
        'query_notes',
        'create_note',
        'edit_note',
        'read_daily',
        'set_property',
        'remove_property',
        'list_tags',
        'list_properties',
        'get_note_links',
        'get_vault_overview',
      ]);
      // The two removed tools must be gone from the combined surface;
      // list_properties is back (full property inventory for consistency audits).
      expect(server.registeredToolNames).not.toContain('read_property');
      expect(server.registeredToolNames).not.toContain('get_stats');
      expect(server.registeredToolNames).toContain('list_properties');
      // The unique low-use tools we keep stay registered.
      expect(server.registeredToolNames).toContain('find_duplicates');
      expect(server.registeredToolNames).toContain('get_note_links');
      expect(server.registeredToolNames).toContain('remove_property');
      expect(server.registeredResourceUris).toEqual(['vault://overview']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('two vaults, one model', () => {
  /** Above MIN_CHARS, so every note is embedded; `marker` tells the vaults apart in the embed texts. */
  function noteBody(marker: string, n: number): string {
    return `${marker} note ${n}. ${'Plain prose that is long enough to clear the size gate. '.repeat(5)}`;
  }

  async function writeVault(root: string, name: string, notes: number): Promise<string> {
    const vaultPath = path.join(root, name);
    await fs.mkdir(vaultPath, { recursive: true });
    for (let n = 1; n <= notes; n += 1) {
      await fs.writeFile(path.join(vaultPath, `note-${n}.md`), noteBody(`${name}-marker`, n));
    }
    return vaultPath;
  }

  it('embeds both vaults through the one --model provider, with progress counted per vault', async () => {
    const root = await createTempVaultPath();
    const alphaPath = await writeVault(root, 'alpha', 2);
    const betaPath = await writeVault(root, 'beta', 3);

    // `--model granite-97m`: the profile in the config, and one provider with
    // its identity. Every document embed parks until the test releases it, so
    // the test steps the shared queue one note at a time.
    const granite = resolveModelProfile('granite-97m');
    const pending: Array<{ texts: string[]; release: () => void }> = [];
    const embedDocuments = vi.fn(
      (texts: string[]) =>
        new Promise<number[][]>((resolve) => {
          pending.push({
            texts,
            release: () =>
              resolve(
                texts.map(() => Array.from({ length: granite.dims }, (_, i) => (i === 0 ? 1 : 0))),
              ),
          });
        }),
    );
    const provider = {
      identity: identityOf(granite),
      maxBatchSize: 64,
      initialize: vi.fn(async () => {}),
      embedQuery: vi.fn(),
      embedDocuments,
    };
    const server = createFakeServer();
    // No CLI script to key a daemon by: the first corpus call flips the switch
    // and both vaults are served by this process's own vault entries.
    const stderrLines: string[] = [];
    const sharedServices = createSharedServices({
      shared: true,
      stderr: { write: (line) => (stderrLines.push(line), true) },
    });

    const dispose = await startNeuroVaultServer(
      {
        vaults: [
          { name: 'alpha', path: alphaPath },
          { name: 'beta', path: betaPath },
        ],
        semantic: { enabled: true, model: granite, shared: true },
      },
      {
        embeddingProvider: provider,
        sharedServices,
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );

    type Progress = { vault: string; indexed: number; total: number } | 'ready';
    const findDuplicates = server.toolHandlers.get('find_duplicates')!;
    const progressOf = async (vault: string): Promise<Progress> => {
      const result = (await findDuplicates({ vault })) as {
        isError?: boolean;
        structuredContent?: {
          code?: string;
          details?: { vault: string; indexed: number; total: number };
        };
      };
      if (!result.isError) return 'ready';
      expect(result.structuredContent?.code).toBe('SEMANTIC_INDEX_BUILDING');
      return result.structuredContent!.details!;
    };

    try {
      const totals: Record<string, number> = { alpha: 2, beta: 3 };
      const done: Record<string, number> = { alpha: 0, beta: 0 };
      for (let step = 0; step < 5; step += 1) {
        // One model, one embed in flight: a single call is ever parked.
        await vi.waitFor(() => expect(pending.length).toBe(1));
        const call = pending.shift()!;
        const vault = call.texts.some((t) => t.includes('alpha-marker')) ? 'alpha' : 'beta';
        const other = vault === 'alpha' ? 'beta' : 'alpha';
        const otherBefore = await progressOf(other);
        call.release();
        done[vault] += 1;

        await vi.waitFor(async () => {
          const progress = await progressOf(vault);
          if (done[vault] === totals[vault] && progress === 'ready') return;
          expect(progress).toEqual({ vault, indexed: done[vault], total: totals[vault] });
        });
        // The note that landed counted for its own vault only.
        expect(await progressOf(other)).toEqual(otherBefore);
      }

      await vi.waitFor(async () => {
        expect(await progressOf('alpha')).toBe('ready');
        expect(await progressOf('beta')).toBe('ready');
      });

      // One fallback line for the whole process, however many vaults switched.
      expect(stderrLines).toEqual([
        'neuro-vault-mcp: shared daemon unavailable (no CLI script path to key it by); ' +
          'running in-process for this session\n',
      ]);
      // The one provider served both vaults.
      const texts = embedDocuments.mock.calls.flatMap(([batch]) => batch);
      expect(texts.some((t) => t.includes('alpha-marker'))).toBe(true);
      expect(texts.some((t) => t.includes('beta-marker'))).toBe(true);
      // Each vault's corpus sits under the granite-97m directory and records its identity.
      for (const vaultPath of [alphaPath, betaPath]) {
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(modelCorpusDir(vaultPath, 'granite-97m'), 'manifest.json'),
            'utf8',
          ),
        ) as { model_key: string; dims: number };
        expect(manifest).toMatchObject({ model_key: 'granite-97m', dims: 384 });
      }
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Startup attaches every vault in the background (spec: shared-corpus-reads). The
 * session talks to a scripted daemon through the real `DaemonConnection`,
 * `SharedServices` and daemon vault client; only the socket behind them is a double.
 */
describe('startup attach', () => {
  const GRANITE = resolveModelProfile('granite-97m');
  const vector = () => Array.from({ length: GRANITE.dims }, (_, i) => (i === 0 ? 1 : 0));
  const CLI = { size: 10, mtimeMs: 20 };

  interface IDaemonCall {
    method: string;
    params: Record<string, unknown>;
  }

  /** A daemon on the other end of `io.connect`; `answer` returns a result, or a promise that never settles. */
  function fakeDaemon(answer: (call: IDaemonCall) => unknown) {
    const calls: IDaemonCall[] = [];
    const sockets: Duplex[] = [];
    const closed: Duplex[] = [];
    const connect = vi.fn(async () => {
      const read = new ReadBuffer();
      const socket: Duplex = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, done) {
          read.append(chunk);
          for (let m = read.readMessage(); m; m = read.readMessage()) {
            const { id, method, params } = m as unknown as {
              id: number;
              method: string;
              params: Record<string, unknown>;
            };
            const call = { method, params };
            calls.push(call);
            void Promise.resolve(answer(call)).then((result) => {
              if (!socket.destroyed) {
                socket.push(serializeMessage({ jsonrpc: '2.0', id, result } as never));
              }
            });
          }
          done();
        },
      });
      socket.once('close', () => closed.push(socket));
      sockets.push(socket);
      return socket;
    });
    return { calls, sockets, closed, connect };
  }

  function servicesOver(daemon: { connect: ReturnType<typeof vi.fn> }, lines: string[] = []) {
    return createSharedServices({
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      version: '18.0.0',
      env: { XDG_CACHE_HOME: '/xdg' },
      home: '/home/u',
      uid: 501,
      platform: 'linux',
      build: () => CLI,
      stderr: { write: (line) => (lines.push(line), true) },
      io: {
        ensureSocketDir: () => {},
        connect: daemon.connect as never,
        spawn: () => {
          throw new Error('must not spawn: the scripted daemon is listening');
        },
        openLog: () => -1,
        closeFd: () => {},
        mkdirp: () => {},
      },
    });
  }

  function fakeProvider(embedDocuments = vi.fn(async (texts: string[]) => texts.map(vector))) {
    return {
      identity: identityOf(GRANITE),
      maxBatchSize: 64,
      initialize: vi.fn(async () => {}),
      embedQuery: vi.fn(),
      embedDocuments,
    };
  }

  async function makeVault(root: string, name: string, config?: object): Promise<string> {
    const vaultPath = path.join(root, name);
    await fs.mkdir(path.join(vaultPath, '.neuro-vault'), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, 'note.md'),
      `${name} note. ${'Plain prose. '.repeat(20)}`,
    );
    if (config) {
      await fs.writeFile(
        path.join(vaultPath, '.neuro-vault', 'config.json'),
        JSON.stringify(config),
      );
    }
    return vaultPath;
  }

  const attachesOf = (daemon: { calls: IDaemonCall[] }) =>
    daemon.calls.filter((call) => call.method === 'vault.attach').map((call) => call.params.vault);

  it('attaches every vault at startup without waiting for a call, an opted-out vault with profiles []', async () => {
    const root = await createTempVaultPath();
    const alpha = await makeVault(root, 'alpha');
    const beta = await makeVault(root, 'beta');
    const off = await makeVault(root, 'off', { semantic: false });
    const daemon = fakeDaemon(({ method }) =>
      method === 'vault.attach'
        ? { vault: '/real', profiles: { 'granite-97m': { state: 'ready' } } }
        : { state: 'ready' },
    );
    const services = servicesOver(daemon);

    const dispose = await startNeuroVaultServer(
      {
        vaults: [
          { name: 'alpha', path: alpha },
          { name: 'beta', path: beta },
          { name: 'off', path: off },
        ],
        semantic: { enabled: true, model: GRANITE, shared: true },
      },
      {
        embeddingProvider: fakeProvider(),
        sharedServices: services,
        serverFactory: () => createFakeServer() as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      // No tool was called: the attaches are the server's own, one per vault. The opted-out
      // vault attaches for its lexical leg alone; the others for their profile as well.
      await vi.waitFor(() => expect(attachesOf(daemon)).toHaveLength(3));
      await settle();
      const profilesByVault = Object.fromEntries(
        daemon.calls
          .filter((call) => call.method === 'vault.attach')
          .map((call) => [call.params.vault, call.params.profiles]),
      );
      expect(profilesByVault).toEqual({
        [alpha]: ['granite-97m'],
        [beta]: ['granite-97m'],
        [off]: [],
      });
      // The backend and the lexical reader of a vault share its attach, and the same
      // status reads gate the warmup: no second read per vault.
      expect(daemon.calls.map((call) => call.method)).toEqual([
        'vault.attach',
        'vault.attach',
        'vault.attach',
      ]);
      expect(daemon.connect).toHaveBeenCalledTimes(1);
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('startup does not wait for attach', async () => {
    const root = await createTempVaultPath();
    const vaultPath = await makeVault(root, 'alpha');
    // The attach is answered never.
    const daemon = fakeDaemon(() => new Promise(() => {}));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'alpha', path: vaultPath }],
        semantic: { enabled: true, model: GRANITE, shared: true },
      },
      {
        embeddingProvider: fakeProvider(),
        sharedServices: servicesOver(daemon),
        transportFactory: () => new StdioServerTransport(stdin, stdout),
        stdin,
      },
    );
    try {
      await vi.waitFor(() => expect(attachesOf(daemon)).toEqual([vaultPath]));
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        })}\n`,
      );
      // The handshake completes while the attach is still unanswered.
      await vi.waitFor(() => expect(written.join('')).toContain('"serverInfo"'));
      expect(attachesOf(daemon)).toEqual([vaultPath]);
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('status reads indexing 0/0 before attach answers', async () => {
    const root = await createTempVaultPath();
    const vaultPath = await makeVault(root, 'alpha');
    let answerAttach!: () => void;
    const attachAnswered = new Promise<void>((resolve) => (answerAttach = resolve));
    const daemon = fakeDaemon(async ({ method }) => {
      if (method !== 'vault.attach') return { state: 'ready' };
      await attachAnswered;
      return { vault: '/real', profiles: { 'granite-97m': { state: 'ready' } } };
    });
    const server = createFakeServer();

    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'alpha', path: vaultPath }],
        semantic: { enabled: true, model: GRANITE, shared: true },
      },
      {
        embeddingProvider: fakeProvider(),
        sharedServices: servicesOver(daemon),
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      await vi.waitFor(() => expect(attachesOf(daemon)).toHaveLength(1));
      const result = (await server.toolHandlers.get('find_duplicates')!({})) as {
        isError?: boolean;
        structuredContent?: { code?: string; details?: unknown };
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.code).toBe('SEMANTIC_INDEX_BUILDING');
      expect(result.structuredContent?.details).toMatchObject({ indexed: 0, total: 0 });
      // The call joined the attach in flight instead of sending another.
      expect(attachesOf(daemon)).toHaveLength(1);

      answerAttach();
      await vi.waitFor(async () => {
        const answer = (await server.toolHandlers.get('find_duplicates')!({})) as {
          structuredContent?: { code?: string };
        };
        expect(answer.structuredContent?.code).not.toBe('SEMANTIC_INDEX_BUILDING');
      });
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('one fallback line when the daemon cannot start', async () => {
    const root = await createTempVaultPath();
    const vaultPath = await makeVault(root, 'alpha');
    const lines: string[] = [];
    // No CLI script to key a daemon by: the first facade to ask flips the switch.
    const services = createSharedServices({
      shared: true,
      stderr: { write: (line) => (lines.push(line), true) },
    });
    // Embedding AND corpus go through the one switch: the embedding facade falls
    // back to a fake local provider, the corpus to this process's own vault entry.
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map(vector));
    const localEmbedder = fakeProvider(embedDocuments);
    const embeddingProvider = new DaemonEmbeddingProvider({
      profile: GRANITE,
      services,
      createFallback: () => localEmbedder,
      initialMaxBatchSize: 8,
    });
    const server = createFakeServer();

    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'alpha', path: vaultPath }],
        semantic: { enabled: true, model: GRANITE, shared: true },
      },
      {
        embeddingProvider,
        sharedServices: services,
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      // The vault was indexed in this process through the local embedder.
      await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalled());
      await vi.waitFor(async () => {
        const answer = (await server.toolHandlers.get('find_duplicates')!({})) as {
          isError?: boolean;
        };
        expect(answer.isError).toBeFalsy();
      });
      expect(services.mode).toBe('local');
      expect(lines).toEqual([
        'neuro-vault-mcp: shared daemon unavailable (no CLI script path to key it by); ' +
          'running in-process for this session\n',
      ]);
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('transport close detaches', async () => {
    const root = await createTempVaultPath();
    const vaultPath = await makeVault(root, 'alpha');
    const daemon = fakeDaemon(({ method }) =>
      method === 'vault.attach'
        ? { vault: '/real', profiles: { 'granite-97m': { state: 'ready' } } }
        : { state: 'ready' },
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();

    await startNeuroVaultServer(
      {
        vaults: [{ name: 'alpha', path: vaultPath }],
        semantic: { enabled: true, model: GRANITE, shared: true },
      },
      {
        embeddingProvider: fakeProvider(),
        sharedServices: servicesOver(daemon),
        transportFactory: () => new StdioServerTransport(stdin, stdout),
        stdin,
      },
    );
    try {
      await vi.waitFor(() => expect(attachesOf(daemon)).toHaveLength(1));
      expect(daemon.closed).toHaveLength(0);

      // The client hangs up the way a stdio client does.
      stdin.end();

      // Closing the connection is how the daemon learns this session left every vault.
      await vi.waitFor(() => expect(daemon.closed).toHaveLength(1));
      expect(daemon.sockets).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /** Hangs up the way a stdio client does mid-warmup, and returns what the server wrote to stderr. */
  async function hangUpMidWarmup(opts: {
    daemon: ReturnType<typeof fakeDaemon>;
    services: ReturnType<typeof servicesOver>;
    embeddingProvider: never;
    warming: () => boolean;
    settle: () => Promise<void>;
  }): Promise<string[]> {
    const root = await createTempVaultPath();
    const vaultPath = await makeVault(root, 'alpha');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await startNeuroVaultServer(
        {
          vaults: [{ name: 'alpha', path: vaultPath }],
          semantic: { enabled: true, model: GRANITE, shared: true },
        },
        {
          embeddingProvider: opts.embeddingProvider,
          sharedServices: opts.services,
          transportFactory: () => new StdioServerTransport(stdin, stdout),
          stdin,
        },
      );
      await vi.waitFor(() => expect(opts.warming()).toBe(true));
      stdin.end();
      await vi.waitFor(() => expect(opts.daemon.closed).toHaveLength(1));
      await opts.settle();
      await settle();
      return written;
    } finally {
      stderr.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const attachReady = ({ method }: IDaemonCall) =>
    method === 'vault.attach'
      ? { vault: '/real', profiles: { 'granite-97m': { state: 'ready' } } }
      : new Promise(() => {});

  it('a warmup that meets the closed services at hang-up writes nothing to stderr', async () => {
    const daemon = fakeDaemon(attachReady);
    const services = servicesOver(daemon);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let initialized: Promise<unknown> | undefined;
    const provider = fakeProvider();
    // The warmup reaches the services only once the session has hung up.
    provider.initialize = vi.fn(async () => {
      await released;
      await services.ensure();
    });
    const written = await hangUpMidWarmup({
      daemon,
      services,
      embeddingProvider: provider as never,
      warming: () => provider.initialize.mock.calls.length > 0,
      settle: async () => {
        initialized = provider.initialize.mock.results[0]?.value as Promise<unknown>;
        release();
        await initialized?.catch(() => {});
      },
    });
    await expect(initialized).rejects.toThrow('shared services closed');
    expect(written.filter((line) => line.includes('semantic warmup failed'))).toEqual([]);
  });

  it('a warmup whose daemon handshake is in flight at hang-up writes nothing to stderr', async () => {
    const daemon = fakeDaemon(attachReady);
    const services = servicesOver(daemon);
    const embeddingProvider = new DaemonEmbeddingProvider({
      profile: GRANITE,
      services,
      createFallback: () => fakeProvider(),
      initialMaxBatchSize: 8,
    });
    const written = await hangUpMidWarmup({
      daemon,
      services,
      embeddingProvider: embeddingProvider as never,
      // `embed.initialize` is never answered: the hang-up lands mid-handshake.
      warming: () => daemon.calls.some((call) => call.method === 'embed.initialize'),
      settle: () => settle(),
    });
    expect(written.filter((line) => line.includes('semantic warmup failed'))).toEqual([]);
  });

  it('--no-shared builds local entries and no connection', async () => {
    const root = await createTempVaultPath();
    const alpha = await makeVault(root, 'alpha');
    const beta = await makeVault(root, 'beta');
    const off = await makeVault(root, 'off', { semantic: false });
    const lines: string[] = [];
    // A connection that would show up in the daemon's log if anything touched it.
    const daemon = fakeDaemon(() => ({}));
    const services = servicesOver(daemon, lines);
    const ensure = vi.spyOn(services, 'ensure');
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map(vector));
    const server = createFakeServer();

    const dispose = await startNeuroVaultServer(
      {
        vaults: [
          { name: 'alpha', path: alpha },
          { name: 'beta', path: beta },
          { name: 'off', path: off },
        ],
        semantic: { enabled: true, model: GRANITE, shared: false },
      },
      {
        embeddingProvider: fakeProvider(embedDocuments),
        sharedServices: services,
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      // Indexing starts at startup, before any tool call: the entries were built up front
      // and every vault attached to them; the opted-out one with no profile, so it embeds
      // nothing.
      const embeddedTexts = () => embedDocuments.mock.calls.flatMap(([batch]) => batch);
      await vi.waitFor(() => {
        expect(embeddedTexts().some((t) => t.includes('alpha note'))).toBe(true);
        expect(embeddedTexts().some((t) => t.includes('beta note'))).toBe(true);
      });
      expect(embeddedTexts().some((t) => t.includes('off note'))).toBe(false);
      await vi.waitFor(async () => {
        for (const vault of ['alpha', 'beta']) {
          const answer = (await server.toolHandlers.get('find_duplicates')!({ vault })) as {
            isError?: boolean;
          };
          expect(answer.isError).toBeFalsy();
        }
      });
      // The daemon was never probed, connected to or mentioned.
      expect(daemon.connect).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('--no-shared serves the lexical leg from the in-process entry', async () => {
    const root = await createTempVaultPath();
    const alpha = await makeVault(root, 'alpha');
    await fs.writeFile(path.join(alpha, 'Heron.md'), '# Heron\n\nA wading bird.\n');
    const daemon = fakeDaemon(() => ({}));
    const services = servicesOver(daemon);
    const ensure = vi.spyOn(services, 'ensure');
    const lexical = vi.spyOn(VaultEntries.prototype, 'lexical');
    const server = createFakeServer();
    const provider = fakeProvider();
    provider.embedQuery = vi.fn(async () => vector());

    const dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'alpha', path: alpha }],
        semantic: { enabled: true, model: GRANITE, shared: false },
      },
      {
        embeddingProvider: provider,
        sharedServices: services,
        serverFactory: () => server as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    try {
      const result = (await server.toolHandlers.get('search_notes')!({
        query: 'heron',
        mode: 'lexical',
      })) as {
        isError?: boolean;
        structuredContent?: { matches: { path: string }[] };
      };
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent!.matches.map((m) => m.path)).toEqual(['Heron.md']);
      // The lexical leg read the in-process entry's cache, and nothing touched the daemon.
      expect(lexical).toHaveBeenCalled();
      expect(daemon.connect).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      lexical.mockRestore();
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("startup warms every vault's lexical reader, after the backend status reads", async () => {
    const root = await createTempVaultPath();
    const alpha = await makeVault(root, 'alpha');
    const beta = await makeVault(root, 'beta', { semantic: false });
    const order: string[] = [];

    const dispose = await startNeuroVaultServer(
      {
        vaults: [
          { name: 'alpha', path: alpha },
          { name: 'beta', path: beta },
        ],
        semantic: { enabled: true, model: GRANITE, shared: false },
      },
      {
        embeddingProvider: fakeProvider(),
        serverFactory: () => createFakeServer() as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
        vaultEntryDeps: {
          semanticBackendFactory: ({ vaultName }) => ({
            ...fakeBackend(),
            status: async () => {
              order.push(`status:${vaultName}`);
              return { state: 'ready' };
            },
          }),
          lexicalReaderFactory: ({ vaultName }) => ({
            search: () => Promise.reject(new Error('not searched here')),
            warm: async () => {
              order.push(`warm:${vaultName}`);
            },
          }),
        },
      },
    );
    try {
      expect(order).toEqual(['status:alpha', 'status:beta', 'warm:alpha', 'warm:beta']);
    } finally {
      await dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('informational flags', () => {
  it.each([['--version'], ['--help']])(
    '%s never constructs a server or opens the transport',
    async (flag) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const serverFactory = vi.fn(() => createFakeServer());
      const transportFactory = vi.fn(() => ({}) as never);

      try {
        await main(['node', 'cli.js', flag], { server: { serverFactory, transportFactory } });

        expect(serverFactory).not.toHaveBeenCalled();
        expect(transportFactory).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it('`daemon status` never constructs a server or opens the transport', async () => {
    const serverFactory = vi.fn(() => createFakeServer());
    const transportFactory = vi.fn(() => ({}) as never);
    const out: string[] = [];
    const nothing = () => {
      throw new Error('daemon status must only read');
    };
    const savedExitCode = process.exitCode;

    try {
      await main(['node', 'cli.js', 'daemon', 'status'], {
        server: { serverFactory, transportFactory },
        daemon: {
          home: '/nonexistent-home',
          env: {},
          fs: {
            readdir: () => [],
            exists: () => false,
            read: () => undefined,
            mkdirp: nothing,
            openExclusive: nothing,
            unlink: nothing,
            rename: nothing,
            linkExclusive: nothing,
            rmrf: nothing,
            chmod: nothing,
            lstat: nothing,
          },
          readInfo: () => undefined,
          stdout: { write: (s: string) => (out.push(s), true) },
          stderr: { write: () => true },
        },
      });

      expect(serverFactory).not.toHaveBeenCalled();
      expect(transportFactory).not.toHaveBeenCalled();
      expect(out.join('')).toMatch(/no daemon known/);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
