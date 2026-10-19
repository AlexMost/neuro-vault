import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import { createVaultEntryServices } from '../../src/daemon/services/vault-entry-services.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import { MODEL_PROFILES } from '../../src/lib/model-profiles.js';
import type { BackendStatus } from '../../src/lib/obsidian/semantic-backend.js';
import { VaultEntries } from '../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../src/lib/vault-entry/vault-entry.js';
import type { DaemonConnection } from '../../src/modules/semantic/daemon-connection.js';
import { createGraphReaderView } from '../../src/modules/semantic/graph/index.js';
import {
  createAttachment,
  createDaemonVaultClient,
  createInProcessLink,
  createLinkedVaultClient,
  type IVaultClient,
} from '../../src/modules/semantic/vault-client/index.js';
import { daemonServices } from './_daemon-fixture.js';

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

const READ = { profile: PROFILE, anchors: [{ path: 'alpha.md' }], threshold: 0.5 };

/**
 * Sessions' vault clients against the real socket server, whose registry is what the daemon
 * registers — `createVaultEntryServices(entries)` and the `daemon` service — over real vault
 * entries: the daemon without its process and its model.
 */
describe.skipIf(!posix)('vault clients over a daemon socket', () => {
  let dir: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  let entries: VaultEntries;
  let registry: ServiceRegistry;
  let connections: DaemonConnection[];
  let clients: IVaultClient[];

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-vc-'));
    socketPath = path.join(dir, 's.sock');
    connections = [];
    clients = [];
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
    for (const [name, handlers] of Object.entries(createVaultEntryServices(entries))) {
      registry.register(name, handlers);
    }
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
    await Promise.all(clients.map((client) => client.dispose()));
    for (const connection of connections) connection.close();
    await handle?.close();
    await entries.dispose();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    handle = await startDaemonServer({ socketPath, registry, idleTimeoutMs: 0, onIdle: () => {} });
  }

  /** One session: its own connection to the socket, and the vault's client over it. */
  function session(vaultRoot: string) {
    const { connection, services, sent } = daemonServices({ dir, socketPath });
    const client = createDaemonVaultClient({
      services,
      attachment: createAttachment({ link: services.connection, vaultRoot, profiles: [PROFILE] }),
      local: () => {
        throw new Error('must not fall back: the daemon is listening');
      },
    });
    connections.push(connection);
    clients.push(client);
    return { connection, client, sent };
  }

  function makeVault(): string {
    const root = path.join(dir, 'notes');
    fs.mkdirSync(root, { recursive: true });
    for (const seed of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(path.join(root, `${seed}.md`), noteBody(seed));
    }
    return root;
  }

  const untilReady = (client: IVaultClient) =>
    poll<BackendStatus>(
      () => client.status(PROFILE),
      (status) => status.state === 'ready',
    );

  const attaches = (sent: string[]) => sent.filter((method) => method === 'vault.attach');

  it('two sessions share one entry through their clients', { timeout: 15_000 }, async () => {
    await startServer();
    const root = makeVault();
    const first = session(root);
    const second = session(root);

    await untilReady(first.client);
    await untilReady(second.client);

    const listed = entries.info();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ clients: 2 });
    // Each session read the one corpus the entry built, under the key it attached.
    const reads = await Promise.all(
      [first, second].map(({ client }) => client.call('corpus.nearest', READ)),
    );
    expect(reads[0]).toEqual(reads[1]);
    expect(reads[0].hits[0]?.map((hit) => hit.path)).toEqual(['alpha.md', 'beta.md', 'gamma.md']);
    expect(attaches(first.sent)).toHaveLength(1);
    expect(attaches(second.sent)).toHaveLength(1);

    // A session that leaves detaches; the other keeps the entry.
    first.connection.close();
    await poll(
      async () => entries.info()[0]?.clients,
      (clients) => clients === 1,
    );
    expect(await second.client.status(PROFILE)).toEqual({ state: 'ready' });
  });

  it(
    'a killed server is reconnected and re-attached once on the next call',
    { timeout: 20_000 },
    async () => {
      await startServer();
      const root = makeVault();
      const { client, connection, sent } = session(root);
      await untilReady(client);
      await client.call('corpus.nearest', READ);
      const epoch = connection.epoch;
      expect(attaches(sent)).toHaveLength(1);

      // The daemon dies: its sockets close, and a fresh one listens on the same path.
      await handle!.close();
      handle = undefined;
      fs.rmSync(socketPath, { force: true });
      await startServer();

      // Some call finds the connection gone and reconnects; the status settles back to ready.
      await vi.waitFor(
        async () => {
          expect((await client.status(PROFILE)).state).toBe('ready');
        },
        { timeout: 10_000 },
      );
      const { hits } = await client.call('corpus.nearest', READ);
      expect(hits[0]?.map((hit) => hit.path)).toEqual(['alpha.md', 'beta.md', 'gamma.md']);

      // One new epoch, one attach on it: the reads after it ride the same attach.
      expect(connection.epoch).toBe(epoch + 1);
      expect(attaches(sent)).toHaveLength(2);
      const reattach = sent.lastIndexOf('vault.attach');
      expect(sent.slice(reattach + 1)).not.toContain('vault.attach');
      // The new connection is one client of the entry; the dead one detached.
      await poll(
        async () => entries.info()[0]?.clients,
        (clients) => clients === 1,
      );
    },
  );
  it('two sessions read one entry graph', { timeout: 15_000 }, async () => {
    await startServer();
    const root = makeVault();
    fs.writeFileSync(path.join(root, 'links.md'), 'see [[beta]] and [[nowhere]]\n');
    const first = createGraphReaderView(session(root).client);
    await expect(first.backlinkCounts(['beta.md', 'alpha.md'])).resolves.toEqual([1, 0]);

    // A link written after the first build: within the TTL, every reader still sees that build.
    fs.writeFileSync(path.join(root, 'more.md'), 'and [[beta]] again\n');
    const second = createGraphReaderView(session(root).client);
    await expect(second.backlinkCounts(['beta.md', 'alpha.md'])).resolves.toEqual([1, 0]);

    const reads = await Promise.all(
      [first, second].map(async (graph) => ({
        links: await graph.noteLinks('links.md'),
        resolved: await graph.resolve(['beta', 'nowhere']),
      })),
    );
    expect(reads[0]).toEqual(reads[1]);
    expect(reads[0]).toEqual({
      links: {
        incoming: [],
        outgoing: [
          { target: 'beta', resolved: true, path: 'beta.md' },
          { target: 'nowhere', resolved: false },
        ],
      },
      resolved: ['beta.md', null],
    });
    expect(entries.info()).toEqual([expect.objectContaining({ clients: 2 })]);

    // The in-process client over the same entries reads the same build.
    const link = createInProcessLink(createVaultEntryServices(entries));
    const local = createGraphReaderView(
      createLinkedVaultClient({
        link,
        attachment: createAttachment({ link, vaultRoot: root, profiles: [] }),
      }),
    );
    await expect(local.backlinkCounts(['beta.md'])).resolves.toEqual([1]);
    await expect(local.noteLinks('links.md')).resolves.toEqual(reads[0].links);
    link.close();
  });
});
