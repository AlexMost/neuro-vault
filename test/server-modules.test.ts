import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once as onceEvent } from 'node:events';
import { PassThrough } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describe, expect, it, vi } from 'vitest';

import { buildBasenameIndex } from '../src/lib/obsidian/index.js';
import type { BackendStatus } from '../src/lib/obsidian/semantic-backend.js';
import { main } from '../src/cli.js';
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

const fakeSources = new Map([
  [
    'Folder/note-a.md',
    {
      path: 'Folder/note-a.md',
      embedding: [1, 0, 0],
      blocks: [
        {
          key: 'Folder/note-a.md#alpha',
          heading: '#alpha',
          lines: [1, 3] as [number, number],
          embedding: [],
        },
      ],
    },
  ],
]);

function makeFakeCorpusIndex(sources: typeof fakeSources = fakeSources) {
  const basenameIndex = buildBasenameIndex(sources.keys());
  return {
    snapshot: vi.fn().mockResolvedValue({ sources, basenameIndex }),
  };
}

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
): Promise<void> {
  await startNeuroVaultServer(
    {
      vaults: [
        {
          name: path.basename(vaultPath),
          path: vaultPath,
        },
      ],
      semantic: { enabled: true, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
      },
      vaultEntryDeps: {
        semanticBackendFactory: () => ({
          snapshot: () => Promise.reject(new Error('snapshot must not be read when not ready')),
          status: () => status,
          dispose: async () => {},
        }),
      },
      serverFactory: (_instructions: string) => server,
      transportFactory: () => ({}) as never,
      // The fake transport has no `close()`, so keep the hang-up wiring off
      // the real `process.stdin` — this stream never ends.
      stdin: new PassThrough(),
    },
  );
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
      semantic: { enabled: true, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
      },
      serverFactory: () => server as never,
      transportFactory: () => transport as never,
      stdin: new PassThrough(),
      vaultEntryDeps: {
        semanticBackendFactory: ({ vaultName }) => ({
          snapshot: async () => ({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
          status: () => ({ state: 'ready' as const }),
          dispose: () => opts.backendDispose(vaultName),
        }),
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
      semantic: { enabled: true, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
    },
    {
      semantic: {
        embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
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
        semanticBackendFactory: () => ({
          snapshot: async () => ({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
          status: () => ({ state: 'ready' as const }),
          dispose: opts.backendDispose,
        }),
      },
    },
  );

  return { stdin, protocolClosed };
}

describe('Neuro Vault MCP server bootstrap', () => {
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

  it('registers eleven operations tools when --no-semantic is passed', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
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
      });

      expect(server.registeredToolNames).toEqual([
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
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        vaultEntryDeps: {
          semanticBackendFactory: () => ({
            snapshot: () => makeFakeCorpusIndex().snapshot(),
            status: () => ({ state: 'ready' }),
            dispose: async () => {},
          }),
          providerFactory: () => fakeProvider,
          readerFactory: () => ({
            readNotes: vi.fn().mockResolvedValue([]),
            scan: vi.fn().mockResolvedValue([]),
          }),
        },
        semantic: {
          embeddingServiceFactory: () => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            embed: vi.fn(),
          }),
        },
        serverFactory: (_instructions: string) => server,
        transportFactory: () => ({}) as never,
        // Same reason as the helpers above: with a fake transport that has
        // no `close()`, the hang-up wiring must not land on the real
        // `process.stdin`. This stream never ends.
        stdin: new PassThrough(),
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

describe('informational flags', () => {
  it.each([['--version'], ['--help']])(
    '%s never constructs a server or opens the transport',
    async (flag) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const serverFactory = vi.fn(() => createFakeServer());
      const transportFactory = vi.fn(() => ({}) as never);

      try {
        await main(['node', 'cli.js', flag], { serverFactory, transportFactory });

        expect(serverFactory).not.toHaveBeenCalled();
        expect(transportFactory).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );
});
