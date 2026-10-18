import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import { createCorpusService } from '../../src/daemon/services/corpus.js';
import { createLexicalService } from '../../src/daemon/services/lexical.js';
import { createVaultService } from '../../src/daemon/services/vault.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import { MODEL_PROFILES } from '../../src/lib/model-profiles.js';
import type { BackendStatus, ISemanticBackend } from '../../src/lib/obsidian/semantic-backend.js';
import { FsVaultReader, type VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../src/lib/tool-registry.js';
import { VaultEntries } from '../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../src/lib/vault-entry/vault-entry.js';
import { createDaemonAttachment } from '../../src/modules/semantic/backend/attachment.js';
import { createDaemonSemanticBackend } from '../../src/modules/semantic/backend/daemon-backend.js';
import {
  createDaemonLexicalReader,
  createStandaloneLexicalReader,
} from '../../src/modules/semantic/lexical/index.js';
import type { DaemonConnection } from '../../src/modules/semantic/daemon-connection.js';
import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../src/modules/semantic/tools/search-notes.js';
import { callTool } from '../_gate.js';
import { TEST_SIMILARITY } from '../_identity.js';
import { makeTestRegistry } from '../operations/tools/_test-registry.js';
import { daemonServices, recording, type IRecordedRequest } from './_daemon-fixture.js';

const PROFILE = 'granite-97m';
const DEBOUNCE_MS = 100;
const posix = process.platform !== 'win32';

/** A note long enough to be embedded (`MIN_CHARS`), distinct per `seed`. */
const noteBody = (seed: string) =>
  `# ${seed}\n\n${`${seed} is a note that talks about one thing in some detail. `.repeat(8)}\n`;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`condition not met in ${timeoutMs} ms; last: ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Two sessions' worth of daemon backends against the real socket server, vault
 * and corpus services and vault entries — the daemon without its process and its
 * model. The sessions are the real `DaemonConnection` and daemon backend;
 * `ISharedServices` is the thin shell a session builds around the connection.
 */
describe.skipIf(!posix)('sessions over a daemon socket', () => {
  let dir: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  let entries: VaultEntries;
  let registry: ServiceRegistry;
  let connections: DaemonConnection[];
  let backends: ISemanticBackend[];
  /** Every request the daemon side received since the last restart, in arrival order. */
  let log: IRecordedRequest[];

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-sd-'));
    socketPath = path.join(dir, 's.sock');
    connections = [];
    backends = [];
    log = [];
    entries = new VaultEntries({
      // Vectors of the profile's own width, so the real ShardStore accepts them; no model loads.
      embedderFor: (key) => async (texts) =>
        texts.map(() => {
          const v = new Array<number>(MODEL_PROFILES[key].dims).fill(0);
          v[0] = 1;
          return v;
        }),
      idleTimeoutMs: 0,
      createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: DEBOUNCE_MS }),
      warn: () => {},
    });
    registry = new ServiceRegistry();
    registry.register('vault', recording('vault', createVaultService(entries), log));
    registry.register('corpus', recording('corpus', createCorpusService(entries), log));
    registry.register('lexical', recording('lexical', createLexicalService(entries), log));
    registry.register(
      'daemon',
      createDaemonService({
        name: 'neuro-vault-mcp',
        version: 'test',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        idleTimeoutMin: 0,
        clients: () => handle?.clients() ?? 0,
        embedLoaded: () => [],
        vaultInfo: () => entries.info(),
        requestShutdown: () => {},
      }),
    );
  });

  afterEach(async () => {
    await Promise.all(backends.map((b) => b.dispose()));
    for (const connection of connections) connection.close();
    await handle?.close();
    await entries.dispose();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    handle = await startDaemonServer({ socketPath, registry, idleTimeoutMs: 0, onIdle: () => {} });
  }

  /** One session: its own connection to the socket, and a backend over it for `vaultRoot`. */
  function session(vaultRoot: string) {
    const { connection, services, sent } = daemonServices({ dir, socketPath });
    const attachment = createDaemonAttachment({ services, vaultRoot, profiles: [PROFILE] });
    const backend = createDaemonSemanticBackend({
      services,
      attachment,
      profile: PROFILE,
      local: () => {
        throw new Error('must not fall back: the daemon is listening');
      },
    });
    connections.push(connection);
    backends.push(backend);
    return { connection, services, attachment, backend, sent };
  }

  function makeVault(): string {
    const root = path.join(dir, 'notes');
    fs.mkdirSync(root, { recursive: true });
    for (const seed of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(path.join(root, `${seed}.md`), noteBody(seed));
    }
    return root;
  }

  const untilReady = (backend: ISemanticBackend) =>
    poll<BackendStatus>(
      () => backend.status(),
      (status) => status.state === 'ready',
    );

  it('two sessions share one entry', { timeout: 15_000 }, async () => {
    await startServer();
    const root = makeVault();
    const first = session(root);
    const second = session(root);

    // The first status of each session is its attach.
    await first.backend.status();
    await second.backend.status();
    await untilReady(first.backend);
    await untilReady(second.backend);

    const listed = entries.info();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ clients: 2 });
    // Each session read the one corpus the entry built.
    const reads = await Promise.all(
      [first, second].map(({ backend }) =>
        backend.nearest([{ path: 'alpha.md' }], { threshold: 0.5 }),
      ),
    );
    expect(reads[0]).toEqual(reads[1]);
    expect(reads[0][0]?.map((hit) => hit.path)).toEqual(['alpha.md', 'beta.md', 'gamma.md']);

    // A session that leaves detaches; the other keeps the entry.
    first.connection.close();
    await poll(
      async () => entries.info()[0]?.clients,
      (clients) => clients === 1,
    );
    expect(await second.backend.status()).toEqual({ state: 'ready' });
  });

  it('a killed server socket is reconnected on the next call', { timeout: 20_000 }, async () => {
    await startServer();
    const root = makeVault();
    const { backend, connection, sent } = session(root);
    await backend.status();
    await untilReady(backend);
    const epoch = connection.epoch;
    expect(sent.filter((method) => method === 'vault.attach')).toHaveLength(1);

    // The daemon dies: its sockets close, and a fresh one listens on the same path.
    await handle!.close();
    handle = undefined;
    fs.rmSync(socketPath, { force: true });
    await startServer();

    // The call that finds the connection gone fails or reads unavailable...
    await vi.waitFor(async () => {
      expect((await backend.status()).state).toBe('ready');
    });
    // ...and the next one reconnected, attached again and serves.
    expect(connection.epoch).toBeGreaterThan(epoch);
    expect(sent.filter((method) => method === 'vault.attach')).toHaveLength(2);
    const hits = await backend.nearest([{ path: 'alpha.md' }], { threshold: 0.5 });
    expect(hits[0]?.map((hit) => hit.path)).toEqual(['alpha.md', 'beta.md', 'gamma.md']);
    // The new connection is one client of the entry; the dead one detached.
    await poll(
      async () => entries.info()[0]?.clients,
      (clients) => clients === 1,
    );
  });
  /** The vault key the daemon answered `vault.attach` with: the realpath of the root. */
  const keyOf = (root: string) => fs.realpathSync(root);

  /**
   * A `search_notes` tool over one session: the daemon backend and lexical reader share the
   * session's one attachment, and the session keeps its own graph over `reader`.
   */
  function searchOver(s: ReturnType<typeof session>, root: string, reader: VaultReader) {
    const dims = MODEL_PROFILES[PROFILE].dims;
    const queryVector = new Array<number>(dims).fill(0);
    queryVector[0] = 1;
    const lexical = createDaemonLexicalReader({
      services: s.services,
      attachment: s.attachment,
      local: () => {
        throw new Error('must not fall back: the daemon is listening');
      },
    });
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: root,
        reader,
        graph: new WikilinkGraphIndex({ reader }),
        backend: s.backend,
        lexical,
      },
    ]);
    const tool = registerTool(
      buildSearchNotesTool({
        registry,
        embeddingProvider: { initialize: async () => {}, embedQuery: async () => queryVector },
        modelKey: PROFILE,
        similarity: TEST_SIMILARITY,
      }),
    );
    return (input: Record<string, unknown>) => callTool<SearchNotesOutput>(tool, input);
  }

  it('a restarted server sees one attach before both legs', { timeout: 25_000 }, async () => {
    await startServer();
    const root = makeVault();
    const s = session(root);
    const search = searchOver(s, root, new FsVaultReader({ vaultRoot: root }));
    await untilReady(s.backend);
    const before = await search({ query: 'alpha' });
    expect(before.matches[0]?.found_in).toEqual(expect.arrayContaining(['semantic']));

    // The daemon dies and a fresh one listens on the same path; the log is the new one's.
    await handle!.close();
    handle = undefined;
    fs.rmSync(socketPath, { force: true });
    log.length = 0;
    await startServer();

    // The call that finds the connection gone fails or degrades; a later one is served whole.
    const after = await vi.waitFor(async () => {
      const out = await search({ query: 'alpha' });
      expect(out.matches[0]?.found_in).toEqual(
        expect.arrayContaining(['semantic', 'lexical:title']),
      );
      return out;
    });
    expect(after.matches.map((m) => m.path)).toEqual(before.matches.map((m) => m.path));

    const key = keyOf(root);
    const methods = log.map((request) => request.method);
    expect(methods.filter((method) => method === 'vault.attach')).toHaveLength(1);
    expect(methods[0]).toBe('vault.attach');
    // Both legs went out after the one attach, on the key the daemon answered.
    const corpus = log.find((request) => request.method.startsWith('corpus.'));
    const lexical = log.find((request) => request.method === 'lexical.search');
    expect(corpus?.params).toMatchObject({ vault: key });
    expect(lexical?.params).toMatchObject({ vault: key, queries: ['alpha'] });
    for (const request of log.filter((r) => r.method !== 'vault.attach')) {
      expect(request.params).toMatchObject({ vault: key });
    }
    // The new connection is one client of the entry; the dead one detached.
    await poll(
      async () => entries.info()[0]?.clients,
      (clients) => clients === 1,
    );
  });

  describe('a daemon-served session reads no note for a lexical call', () => {
    /** A reader over `root` that counts every way a note can be read. */
    function spiedReader(root: string) {
      const readFile = vi.fn<(p: string) => void>();
      const reader = new FsVaultReader({
        vaultRoot: root,
        readFile: (p, enc) => {
          readFile(p);
          return fs.promises.readFile(p, enc);
        },
      });
      const scan = vi.spyOn(reader, 'scan');
      const readNotes = vi.spyOn(reader, 'readNotes');
      return {
        reader,
        reset: () => {
          scan.mockClear();
          readNotes.mockClear();
          readFile.mockClear();
        },
        calls: () => ({
          scan: scan.mock.calls.length,
          readNotes: readNotes.mock.calls.length,
          readFile: readFile.mock.calls.length,
        }),
      };
    }

    it('the second lexical call, inside the graph TTL, touches the reader not at all', async () => {
      await startServer();
      const root = makeVault();
      const s = session(root);
      const { reader, reset, calls } = spiedReader(root);
      const search = searchOver(s, root, reader);

      // The first call builds the session's own graph, which reads notes through its reader.
      const first = await search({ query: 'alpha', mode: 'lexical' });
      expect(first.matches.map((m) => m.path)).toContain('alpha.md');
      expect(calls().readNotes).toBeGreaterThan(0);

      reset();
      const second = await search({ query: 'alpha', mode: 'lexical' });

      expect(calls()).toEqual({ scan: 0, readNotes: 0, readFile: 0 });
      // Still answered, by the daemon.
      expect(second.matches.map((m) => m.path)).toEqual(first.matches.map((m) => m.path));
      expect(log.filter((r) => r.method === 'lexical.search')).toHaveLength(2);
    });

    it('the standalone reader scans on the second call, so the spy would catch a read', async () => {
      const root = makeVault();
      const { reader, reset, calls } = spiedReader(root);
      const graph = new WikilinkGraphIndex({ reader });
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: root,
          reader,
          graph,
          lexical: createStandaloneLexicalReader({ vaultRoot: root, reader, graph }),
        },
      ]);
      const tool = registerTool(
        buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: async () => {}, embedQuery: async () => [1] },
          modelKey: PROFILE,
          similarity: TEST_SIMILARITY,
        }),
      );

      await callTool<SearchNotesOutput>(tool, { query: 'alpha', mode: 'lexical' });
      reset();
      await callTool<SearchNotesOutput>(tool, { query: 'alpha', mode: 'lexical' });

      expect(calls().scan).toBeGreaterThan(0);
    });
  });
});
