import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once as onceEvent } from 'node:events';
import { PassThrough } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describe, expect, it, vi } from 'vitest';

import { modelCorpusDir } from '../src/lib/obsidian/corpus/layout.js';
import type { BackendStatus, ISemanticBackend } from '../src/lib/obsidian/semantic-backend.js';
import { main } from '../src/cli.js';
import { DEFAULT_MODEL_KEY, identityOf, resolveModelProfile } from '../src/lib/model-profiles.js';
import { createSharedServices } from '../src/modules/semantic/shared-services.js';
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
