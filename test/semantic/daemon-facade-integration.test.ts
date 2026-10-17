import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { daemonPaths } from '../../src/daemon/paths.js';
import { defaultConnect } from '../../src/daemon/probe.js';
import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createEmbedService } from '../../src/daemon/services/embed.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import {
  DaemonConnection,
  DaemonConnectionError,
} from '../../src/modules/semantic/daemon-connection.js';
import { DaemonEmbeddingProvider } from '../../src/modules/semantic/daemon-embedding-provider.js';
import { identityOf, resolveModelProfile } from '../../src/lib/model-profiles.js';
import type { EmbeddingProvider } from '../../src/modules/semantic/types.js';

const posix = process.platform !== 'win32';
const profile = resolveModelProfile('granite-97m');

/** A provider the daemon builds: vectors encode the text length; `hold` parks queries. */
function fakeProvider(state: { hold?: Promise<void> }): EmbeddingProvider {
  return {
    identity: identityOf(profile),
    maxBatchSize: 2,
    initialize: async () => {},
    embedQuery: async (text) => {
      await state.hold;
      return [text.length];
    },
    embedDocuments: async (texts) => texts.map((t) => [t.length]),
  };
}

/**
 * The session-side facade and connection against the real daemon socket
 * server and embed service: framing, ids, the handshake, the batch size, and
 * what a stopping daemon does to a request in flight.
 */
describe.skipIf(!posix)('DaemonEmbeddingProvider over a real daemon socket', () => {
  let dir: string;
  let server: DaemonServerHandle | undefined;
  const state: { hold?: Promise<void> } = {};

  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/nv-facade-');
    state.hold = undefined;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<{
    provider: DaemonEmbeddingProvider;
    connection: DaemonConnection;
  }> {
    const socketPath = path.join(dir, 'd.sock');
    const registry = new ServiceRegistry();
    registry.register(
      'embed',
      createEmbedService({ createProvider: () => fakeProvider(state) }).handlers,
    );
    server = await startDaemonServer({ socketPath, registry, idleTimeoutMs: 0, onIdle: () => {} });
    const paths = {
      ...daemonPaths({
        version: '0.0.0',
        build: { size: 1, mtimeMs: 1 },
        uid: 1,
        platform: 'linux',
        cacheBase: dir,
      }),
      socketPath,
    };
    const connection = new DaemonConnection({
      paths,
      cliPath: '/never/spawned.js',
      build: { size: 1, mtimeMs: 1 },
      statBuild: () => ({ size: 1, mtimeMs: 1 }),
      cwd: dir,
      execPath: process.execPath,
      platform: 'linux',
      ensureSocketDir: () => {},
      connect: defaultConnect,
      spawn: () => {
        throw new Error('must not spawn: the daemon is listening');
      },
      openLog: () => -1,
      closeFd: () => {},
      mkdirp: () => {},
    });
    const provider = new DaemonEmbeddingProvider({
      profile,
      connection,
      createFallback: () => {
        throw new Error('must not fall back');
      },
      initialMaxBatchSize: 8,
      stderr: { write: () => true },
    });
    return { provider, connection };
  }

  it('initializes, becomes a client, and embeds texts with newlines and quotes', async () => {
    const { provider } = await start();
    await provider.initialize();
    expect(provider.maxBatchSize).toBe(2);
    expect(server!.clients()).toBe(1);
    await expect(provider.embedQuery('a "quoted"\nline')).resolves.toEqual([15]);
    await expect(provider.embedDocuments(['x', 'yy', 'zzz'])).resolves.toEqual([[1], [2], [3]]);
  });

  it('a daemon that stops answers the in-flight request and the next call reconnects', async () => {
    const { provider, connection } = await start();
    await provider.initialize();
    let release!: () => void;
    state.hold = new Promise((r) => (release = r));
    const inFlight = provider.embedQuery('held');
    await new Promise((r) => setTimeout(r, 20));
    const outcome = expect(inFlight).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    await server!.close();
    await outcome;
    release();
    await new Promise((r) => setTimeout(r, 20));
    // The socket is gone: a bare request fails fast instead of hanging.
    await expect(connection.request('embed.query', {}, 1000)).rejects.toBeInstanceOf(
      DaemonConnectionError,
    );

    // A fresh daemon on the same path: the facade reconnects and re-initializes.
    fs.rmSync(path.join(dir, 'd.sock'), { force: true });
    const registry = new ServiceRegistry();
    registry.register(
      'embed',
      createEmbedService({ createProvider: () => fakeProvider({}) }).handlers,
    );
    server = await startDaemonServer({
      socketPath: path.join(dir, 'd.sock'),
      registry,
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    await expect(provider.embedQuery('again')).resolves.toEqual([5]);
    expect(connection.epoch).toBe(2);
    expect(server.clients()).toBe(1);
  });
});
