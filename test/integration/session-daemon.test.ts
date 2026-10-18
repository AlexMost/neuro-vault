import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonPaths } from '../../src/daemon/paths.js';
import { defaultConnect } from '../../src/daemon/probe.js';
import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import { createCorpusService } from '../../src/daemon/services/corpus.js';
import { createVaultService } from '../../src/daemon/services/vault.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import { MODEL_PROFILES } from '../../src/lib/model-profiles.js';
import type { BackendStatus, ISemanticBackend } from '../../src/lib/obsidian/semantic-backend.js';
import { VaultEntries } from '../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../src/lib/vault-entry/vault-entry.js';
import { createDaemonAttachment } from '../../src/modules/semantic/backend/attachment.js';
import { createDaemonSemanticBackend } from '../../src/modules/semantic/backend/daemon-backend.js';
import { DaemonConnection } from '../../src/modules/semantic/daemon-connection.js';
import type { ISharedServices } from '../../src/modules/semantic/shared-services.js';

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

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-sd-'));
    socketPath = path.join(dir, 's.sock');
    connections = [];
    backends = [];
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
    registry.register('vault', createVaultService(entries));
    registry.register('corpus', createCorpusService(entries));
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
    const connection = new DaemonConnection({
      paths: {
        ...daemonPaths({
          version: '0.0.0',
          build: { size: 1, mtimeMs: 1 },
          uid: 1,
          platform: 'linux',
          cacheBase: dir,
        }),
        socketPath,
      },
      cliPath: '/never/spawned.js',
      build: { size: 1, mtimeMs: 1 },
      statBuild: () => ({ size: 1, mtimeMs: 1 }),
      cwd: dir,
      execPath: process.execPath,
      platform: 'linux',
      ensureSocketDir: () => {},
      connect: defaultConnect,
      spawn: () => {
        throw new Error('must not spawn: the test daemon owns the socket');
      },
      openLog: () => -1,
      closeFd: () => {},
      mkdirp: () => {},
    });
    const sent: string[] = [];
    const request = connection.request.bind(connection);
    connection.request = (method, params, timeoutMs) => {
      sent.push(method);
      return request(method, params, timeoutMs);
    };
    const services: ISharedServices = {
      mode: 'daemon',
      connection,
      ensure: async () => {
        await connection.ensure();
        return 'daemon';
      },
      close: () => connection.close(),
    };
    const backend = createDaemonSemanticBackend({
      services,
      attachment: createDaemonAttachment({ services, vaultRoot, profiles: [PROFILE] }),
      profile: PROFILE,
      local: () => {
        throw new Error('must not fall back: the daemon is listening');
      },
    });
    connections.push(connection);
    backends.push(backend);
    return { connection, backend, sent };
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
});
