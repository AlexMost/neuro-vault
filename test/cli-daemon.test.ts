import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
  CALL_TIMEOUT_MS,
  daemonProviderFor,
  runDaemonCommand,
  STOP_DEADLINE_MS,
  type DaemonCommandDeps,
} from '../src/cli-daemon.js';
import { startDaemonServer } from '../src/daemon/socket-server.js';
import { parseDaemonInfo } from '../src/daemon/info.js';
import { cliBuild, daemonKey } from '../src/daemon/paths.js';
import type { Timers } from '../src/daemon/probe.js';
import type { ServiceRegistry } from '../src/daemon/protocol.js';
import {
  VaultEntries,
  type VaultEntriesDeps,
  type VaultInfo,
} from '../src/lib/vault-entry/index.js';
import { EmbeddingService } from '../src/modules/semantic/embedding-service.js';
import { identityOf, MODEL_PROFILES, type ModelProfile } from '../src/lib/model-profiles.js';
import type { EmbeddingProvider } from '../src/modules/semantic/types.js';
import { testCtx } from './daemon/_ctx.js';

const BASE = '/home/u/.cache/neuro-vault/daemons';
const BUILD = { size: 1000, mtimeMs: 1 };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Timers that fire only when a test says so. */
function fakeClock() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      pending.delete(id);
    },
  } as unknown as Timers;
  return {
    timers,
    has: (ms: number) => [...pending.values()].some((t) => t.ms === ms),
    fire(ms: number): void {
      for (const [id, t] of [...pending]) {
        if (t.ms !== ms) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await flush();
  expect(condition()).toBe(true);
}

function harness(overrides: Partial<DaemonCommandDeps> = {}) {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const out: string[] = [];
  const err: string[] = [];
  const handle = {
    clients: vi.fn(() => 0),
    beginClose: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const startServer = vi.fn(async (_opts: unknown) => handle);
  const signals = new Map<string, () => void>();
  const exit = vi.fn();
  const clock = fakeClock();
  const unlink = vi.fn((f: string) => {
    files.delete(f);
  });
  const chmod = vi.fn();
  const children = (d: string): string[] =>
    [...new Set([...dirs, ...files.keys()])]
      .filter((x) => x.startsWith(d + '/') && !x.slice(d.length + 1).includes('/'))
      .map((x) => x.slice(d.length + 1));
  const deps: DaemonCommandDeps = {
    platform: 'darwin',
    uid: 501,
    env: {},
    home: '/home/u',
    pid: 42,
    version: '18.0.0',
    build: BUILD,
    now: () => new Date('2026-10-14T10:00:00.000Z'),
    fs: {
      mkdirp: (d) => {
        dirs.add(d);
      },
      openExclusive: (f, c) => (files.has(f) ? false : (files.set(f, c), true)),
      read: (f) => files.get(f),
      unlink,
      rename: (from, to) => {
        const content = files.get(from);
        if (content === undefined) return false;
        files.delete(from);
        files.set(to, content);
        return true;
      },
      linkExclusive: (existing, newPath) => {
        if (files.has(newPath)) return false;
        files.set(newPath, files.get(existing)!);
        return true;
      },
      readdir: children,
      rmrf: (d) => {
        for (const x of [...dirs]) if (x === d || x.startsWith(d + '/')) dirs.delete(x);
        for (const f of [...files.keys()]) if (f.startsWith(d + '/')) files.delete(f);
      },
      chmod,
      exists: (p) => files.has(p) || dirs.has(p),
      lstat: (p) => {
        if (!dirs.has(p)) throw errno('ENOENT');
        return { isDirectory: () => true, isSymbolicLink: () => false, uid: 501 };
      },
    },
    isAlive: () => false,
    connect: () => Promise.reject(errno('ENOENT')),
    startServer,
    createProvider: vi.fn(),
    writeInfo: (f, info) => {
      files.set(f, JSON.stringify(info));
      return Promise.resolve();
    },
    readInfo: (f) => {
      const raw = files.get(f);
      return raw === undefined ? undefined : parseDaemonInfo(raw);
    },
    onSignal: (signal, h) => {
      signals.set(signal, h);
    },
    exit,
    timers: clock.timers,
    stdout: { write: (s: string) => (out.push(s), true) },
    stderr: { write: (s: string) => (err.push(s), true) },
    kill: vi.fn(),
    ...overrides,
  };
  return { deps, files, dirs, out, err, handle, startServer, signals, exit, clock, unlink, chmod };
}

type Harness = ReturnType<typeof harness>;

function keyOf(h: Harness): string {
  return daemonKey(h.deps.version!, h.deps.build!);
}

function stateFile(h: Harness, name: string): string {
  return `${BASE}/${keyOf(h)}/${name}`;
}

function socketOf(h: Harness): string {
  return `/tmp/neuro-vault-501/${keyOf(h)}.sock`;
}

function serverOptions(h: Harness): { registry: ServiceRegistry; onIdle: () => void } {
  return h.startServer.mock.calls[0][0] as { registry: ServiceRegistry; onIdle: () => void };
}

const RUN = { idleTimeoutMinutes: 30 };

function infoJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    pid: 1,
    version: '18.0.0',
    socket: '/tmp/a.sock',
    started_at: 'x',
    cli_size: 1000,
    cli_mtime_ms: 1,
    ...over,
  });
}

function addKnown(h: Harness, name: string, info: string | undefined): void {
  h.dirs.add(`${BASE}/${name}`);
  if (info !== undefined) h.files.set(`${BASE}/${name}/daemon.json`, info);
}

describe('daemonProviderFor', () => {
  it('builds the in-process provider for every profile — never a facade onto itself', () => {
    // Construction loads nothing; the model loads on initialize().
    for (const profile of Object.values(MODEL_PROFILES)) {
      expect(daemonProviderFor(profile)).toBeInstanceOf(EmbeddingService);
    }
  });
});

describe('runDaemonCommand (run)', () => {
  it('locks, listens, chmods, writes daemon.json and announces on stderr', async () => {
    const h = harness();
    await expect(runDaemonCommand({ idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(0);
    expect(h.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: expect.stringMatching(/^\/tmp\/neuro-vault-501\/[0-9a-f]{12}\.sock$/),
        idleTimeoutMs: 30 * 60_000,
      }),
    );
    expect(h.dirs.has('/tmp/neuro-vault-501')).toBe(true);
    expect(h.chmod).toHaveBeenCalledWith('/tmp/neuro-vault-501', 0o700);
    expect(h.chmod).toHaveBeenCalledWith(socketOf(h), 0o600);
    expect(h.files.get(stateFile(h, 'daemon.lock'))).toBe('42');
    expect(parseDaemonInfo(h.files.get(stateFile(h, 'daemon.json'))!)).toEqual({
      pid: 42,
      version: '18.0.0',
      socket: socketOf(h),
      started_at: '2026-10-14T10:00:00.000Z',
      cli_size: 1000,
      cli_mtime_ms: 1,
    });
    expect(h.err.join('')).toMatch(/neuro-vault-mcp v18\.0\.0 daemon listening/);
    expect(h.out).toEqual([]);
    expect(h.deps.createProvider).not.toHaveBeenCalled();
    expect([...h.signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('chmods the socket only after the server listens', async () => {
    const h = harness();
    const order: string[] = [];
    h.chmod.mockImplementation((p: string) => order.push(`chmod ${p}`));
    h.startServer.mockImplementation(async () => (order.push('listen'), h.handle));
    await runDaemonCommand(RUN, h.deps);
    expect(order).toEqual(['chmod /tmp/neuro-vault-501', 'listen', `chmod ${socketOf(h)}`]);
  });

  it('unlinks a socket file nobody answers on before listening', async () => {
    const h = harness({ connect: () => Promise.reject(errno('ECONNREFUSED')) });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(0);
    expect(h.unlink).toHaveBeenCalledWith(socketOf(h));
  });

  it('exits 1 when the lock is held by a live pid', async () => {
    const h = harness({ isAlive: (pid) => pid === 7 });
    h.files.set(stateFile(h, 'daemon.lock'), '7');
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.err.join('')).toMatch(/already running \(pid 7\)/);
    expect(h.err.join('')).toContain(stateFile(h, 'daemon.lock'));
    expect(h.err.join('')).toContain('run `neuro-vault-mcp daemon status` to check');
    expect(h.startServer).not.toHaveBeenCalled();
    expect(h.files.get(stateFile(h, 'daemon.lock'))).toBe('7');
  });

  it('exits 1 when the lock is contended', async () => {
    const h = harness();
    h.deps.fs = { ...h.deps.fs!, openExclusive: () => false, read: () => undefined };
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.err.join('')).toMatch(/could not take the daemon lock \(contended\); try again/);
    expect(h.startServer).not.toHaveBeenCalled();
  });

  it('exits 1 when something already listens on the socket, releasing the lock', async () => {
    const h = harness({ connect: () => Promise.resolve(new PassThrough()) });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.startServer).not.toHaveBeenCalled();
    expect(h.err.join('')).toContain(socketOf(h));
    expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
    expect(h.unlink).not.toHaveBeenCalledWith(socketOf(h));
  });

  it.each([
    ['a symlink', { isDirectory: () => false, isSymbolicLink: () => true, uid: 501 }, 'a symlink'],
    [
      'owned by another uid',
      { isDirectory: () => true, isSymbolicLink: () => false, uid: 0 },
      'uid 0',
    ],
    [
      'not a directory',
      { isDirectory: () => false, isSymbolicLink: () => false, uid: 501 },
      'not a directory',
    ],
  ])(
    'refuses a socket directory that is %s: releases the lock, one stderr line, exit 1',
    async (_, found, why) => {
      const h = harness();
      h.deps.fs = { ...h.deps.fs!, lstat: () => found };
      await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
      expect(h.startServer).not.toHaveBeenCalled();
      expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toContain('/tmp/neuro-vault-501');
      expect(h.err[0]).toContain(why);
      expect(h.unlink).not.toHaveBeenCalledWith(socketOf(h));
    },
  );

  it('exits 1 through the failure path when the socket directory cannot be chmodded', async () => {
    const h = harness();
    h.chmod.mockImplementation(() => {
      throw errno('EPERM');
    });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.startServer).not.toHaveBeenCalled();
    expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/failed to start: .*\/tmp\/neuro-vault-501.*EPERM/);
  });

  it('does not check the socket directory on Windows', async () => {
    const h = harness({ platform: 'win32' });
    const lstat = vi.fn(() => {
      throw new Error('lstat called');
    });
    h.deps.fs = { ...h.deps.fs!, lstat };
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(0);
    expect(lstat).not.toHaveBeenCalled();
  });

  it('resolves the uid without os.userInfo (no passwd entry in a container)', async () => {
    const userInfo = vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, uv_os_get_passwd');
    });
    try {
      const h = harness({ uid: undefined });
      await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
      const run = harness({ uid: undefined });
      run.deps.fs = {
        ...run.deps.fs!,
        lstat: () => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          uid: process.getuid?.() ?? -1,
        }),
      };
      await expect(runDaemonCommand(RUN, run.deps)).resolves.toBe(0);
      const expectedUid = process.getuid?.() ?? -1;
      expect(run.startServer).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: expect.stringContaining(`/neuro-vault-${expectedUid}/`),
        }),
      );
      expect(userInfo).not.toHaveBeenCalled();
    } finally {
      userInfo.mockRestore();
    }
  });

  it('releases the lock and exits 1 when listening fails', async () => {
    const h = harness();
    h.startServer.mockRejectedValue(
      Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
    );
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
    expect(h.err.join('')).toMatch(/EADDRINUSE/);
    expect(h.out).toEqual([]);
  });

  it('closes the server and releases the lock when writing daemon.json fails', async () => {
    const h = harness({ writeInfo: () => Promise.reject(new Error('disk full')) });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.handle.close).toHaveBeenCalled();
    expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
    expect(h.err.join('')).toMatch(/disk full/);
    expect(h.signals.size).toBe(0);
  });

  it('exits 1 naming the path when the CLI script cannot be identified', async () => {
    const h = harness({ build: undefined, cliPath: '/nonexistent/neuro-vault/cli.js' });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(1);
    expect(h.err.join('')).toContain('/nonexistent/neuro-vault/cli.js');
    expect(h.startServer).not.toHaveBeenCalled();
    expect(h.files.size).toBe(0);
  });

  it('resolves an injected CLI path through realpath before reading its build', async () => {
    const real = fileURLToPath(import.meta.url);
    const realpath = vi.fn((p: string) => (p === '/link/neuro-vault/cli.js' ? real : p));
    const h = harness({ build: undefined, cliPath: '/link/neuro-vault/cli.js', realpath });
    await expect(runDaemonCommand(RUN, h.deps)).resolves.toBe(0);
    expect(realpath).toHaveBeenCalledWith('/link/neuro-vault/cli.js');
    const key = daemonKey(h.deps.version!, cliBuild(real));
    expect(h.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: `/tmp/neuro-vault-501/${key}.sock` }),
    );
  });

  it.each(['SIGTERM', 'SIGINT'])(
    '%s closes the server, removes the files and exits 0',
    async (sig) => {
      const h = harness();
      await runDaemonCommand(RUN, h.deps);
      h.signals.get(sig)!();
      await flush();
      expect(h.handle.close).toHaveBeenCalledTimes(1);
      expect(h.files.has(stateFile(h, 'daemon.json'))).toBe(false);
      expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
      expect(h.unlink).toHaveBeenCalledWith(socketOf(h));
      expect(h.exit).toHaveBeenCalledTimes(1);
      expect(h.exit).toHaveBeenCalledWith(0);
      expect(h.clock.has(STOP_DEADLINE_MS)).toBe(false);
    },
  );

  it('a second signal during stop is a no-op', async () => {
    const h = harness();
    await runDaemonCommand(RUN, h.deps);
    h.signals.get('SIGINT')!();
    h.signals.get('SIGTERM')!();
    await flush();
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('idle expiry stops it the same way', async () => {
    const h = harness();
    await runDaemonCommand({ idleTimeoutMinutes: 1 }, h.deps);
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutMs: 60_000 }));
    serverOptions(h).onIdle();
    await flush();
    expect(h.handle.close).toHaveBeenCalled();
    expect(h.files.has(stateFile(h, 'daemon.json'))).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('daemon.shutdown answers first and stops one tick later', async () => {
    const h = harness();
    await runDaemonCommand(RUN, h.deps);
    const response = await serverOptions(h).registry.dispatch(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'daemon.shutdown',
      },
      testCtx(),
    );
    expect(isJSONRPCResultResponse(response) && response.result).toEqual({});
    await flush();
    expect(h.handle.close).not.toHaveBeenCalled();
    expect(h.clock.has(0)).toBe(true);
    h.clock.fire(0);
    await flush();
    expect(h.handle.close).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('daemon.info reports the running daemon', async () => {
    const h = harness();
    h.handle.clients.mockReturnValue(3);
    await runDaemonCommand(RUN, h.deps);
    const response = await serverOptions(h).registry.dispatch(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'daemon.info',
      },
      testCtx(),
    );
    expect(isJSONRPCResultResponse(response) && response.result).toEqual({
      name: 'neuro-vault-mcp',
      version: '18.0.0',
      pid: 42,
      started_at: '2026-10-14T10:00:00.000Z',
      idle_timeout_min: 30,
      clients: 3,
      services: { embed: { loaded: [] }, vault: [] },
    });
  });

  describe('vault entries', () => {
    function entriesHarness(overrides: Partial<DaemonCommandDeps> = {}) {
      const created: Array<{ deps: VaultEntriesDeps; entries: VaultEntries }> = [];
      const createVaultEntries = vi.fn((deps: VaultEntriesDeps) => {
        const entries = new VaultEntries(deps);
        created.push({ deps, entries });
        return entries;
      });
      const h = harness({ createVaultEntries, ...overrides });
      return { h, created, createVaultEntries };
    }

    it('builds them from the daemon idle timeout, its timers and the embed service', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand({ idleTimeoutMinutes: 2 }, h.deps);
      expect(created).toHaveLength(1);
      expect(created[0].deps.idleTimeoutMs).toBe(120_000);
      expect(created[0].deps.timers).toBe(h.deps.timers);
      expect(created[0].deps.embedderFor).toBeTypeOf('function');
    });

    it('--idle-timeout 0 never idles them out', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand({ idleTimeoutMinutes: 0 }, h.deps);
      expect(created[0].deps.idleTimeoutMs).toBe(0);
    });

    it('writes their warnings to stderr, never stdout', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      h.err.length = 0;
      created[0].deps.warn?.('neuro-vault: something');
      expect(h.err).toEqual(['neuro-vault: something\n']);
      expect(h.out).toEqual([]);
    });

    it('embeds through the embed service queue of the profile', async () => {
      const createProvider = vi.fn(
        (profile: ModelProfile): EmbeddingProvider => ({
          identity: identityOf(profile),
          maxBatchSize: 8,
          initialize: async () => {},
          embedQuery: async () => [1, 0, 0],
          embedDocuments: async (texts: string[]) => texts.map(() => [0, 1, 0]),
        }),
      );
      const { h, created } = entriesHarness({ createProvider });
      await runDaemonCommand(RUN, h.deps);
      await expect(created[0].deps.embedderFor('granite-97m')(['a'])).resolves.toEqual([[0, 1, 0]]);
      expect(createProvider).toHaveBeenCalledTimes(1);
    });

    it('serves vault.attach over the registry', async () => {
      const { h } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      const response = await serverOptions(h).registry.dispatch(
        { jsonrpc: '2.0', id: 1, method: 'vault.attach', params: { vault: 1, profiles: [] } },
        testCtx(),
      );
      expect(isJSONRPCResultResponse(response)).toBe(false);
      expect(JSON.stringify(response)).toContain('INVALID_PARAMS');
    });

    it.each([
      ['a signal', (h: Harness) => h.signals.get('SIGTERM')!()],
      ['idle expiry', (h: Harness) => serverOptions(h).onIdle()],
    ])('%s disposes them before it closes the server', async (_name, trigger) => {
      const { h, created } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      const order: string[] = [];
      let disposed!: () => void;
      vi.spyOn(created[0].entries, 'dispose').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            order.push('dispose');
            disposed = resolve;
          }),
      );
      h.handle.close.mockImplementation(async () => void order.push('close'));
      trigger(h);
      await flush();
      expect(order).toEqual(['dispose']);
      expect(h.exit).not.toHaveBeenCalled();
      disposed();
      await flush();
      expect(order).toEqual(['dispose', 'close']);
      expect(h.exit).toHaveBeenCalledWith(0);
    });

    it('begins closing the server before it disposes the entries', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      const order: string[] = [];
      h.handle.beginClose.mockImplementation(() => void order.push('begin'));
      vi.spyOn(created[0].entries, 'dispose').mockImplementation(async () => {
        order.push('dispose');
      });
      h.signals.get('SIGTERM')!();
      expect(order).toEqual(['begin']);
      await flush();
      expect(order).toEqual(['begin', 'dispose']);
    });

    it('answers SHUTTING_DOWN to vault and embed requests while the entries dispose', async () => {
      const dir = mkdtempSync('/tmp/nv-daemon-');
      try {
        const { h, created } = entriesHarness();
        h.deps.startServer = (opts) =>
          startDaemonServer({ ...opts, socketPath: path.join(dir, 's.sock') });
        await runDaemonCommand(RUN, h.deps);
        let disposed!: () => void;
        vi.spyOn(created[0].entries, 'dispose').mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              disposed = resolve;
            }),
        );
        const socket = net.connect(path.join(dir, 's.sock'));
        await new Promise((resolve) => socket.once('connect', resolve));
        const replies: JSONRPCMessage[] = [];
        const buffer = new ReadBuffer();
        socket.on('data', (chunk: Buffer) => {
          buffer.append(chunk);
          for (let m = buffer.readMessage(); m; m = buffer.readMessage()) replies.push(m);
        });
        h.signals.get('SIGTERM')!();
        await flush();
        const requests: Array<[string, unknown]> = [
          ['vault.status', { vault: '/v', profile: 'harrier-270m' }],
          ['vault.attach', { vault: '/v', profiles: [] }],
          ['embed.query', { profile: 'granite-97m', text: 'x' }],
          ['daemon.info', undefined],
        ];
        requests.forEach(([method, params], i) =>
          socket.write(serializeMessage({ jsonrpc: '2.0', id: i + 1, method, params } as never)),
        );
        await until(() => replies.length === requests.length);
        for (const reply of replies) {
          expect(reply).toMatchObject({ error: { data: { code: 'SHUTTING_DOWN' } } });
        }
        // Nothing was served: no provider was built for the embed call.
        expect(h.deps.createProvider).not.toHaveBeenCalled();
        disposed();
        await until(() => h.exit.mock.calls.length > 0);
        socket.destroy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still closes the server and exits 0 when disposing fails', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      vi.spyOn(created[0].entries, 'dispose').mockRejectedValue(new Error('watcher stuck'));
      h.signals.get('SIGINT')!();
      await flush();
      expect(h.handle.close).toHaveBeenCalled();
      expect(h.exit).toHaveBeenCalledWith(0);
      expect(h.err.join('')).toContain('dispose failed: watcher stuck');
    });

    it('exits 0 at the deadline when disposing never finishes', async () => {
      const { h, created } = entriesHarness();
      await runDaemonCommand(RUN, h.deps);
      vi.spyOn(created[0].entries, 'dispose').mockImplementation(() => new Promise<void>(() => {}));
      h.signals.get('SIGTERM')!();
      await flush();
      expect(h.exit).not.toHaveBeenCalled();
      h.clock.fire(STOP_DEADLINE_MS);
      expect(h.exit).toHaveBeenCalledWith(0);
    });
  });

  it('logs a profile load and a load failure to stderr, nothing to stdout', async () => {
    let fail = false;
    const createProvider = vi.fn(
      (profile: ModelProfile): EmbeddingProvider => ({
        identity: identityOf(profile),
        maxBatchSize: 8,
        initialize: async () => {
          if (fail) throw new Error('no weights');
        },
        embedQuery: async () => [1, 0, 0],
        embedDocuments: async (texts: string[]) => texts.map(() => [1, 0, 0]),
      }),
    );
    const h = harness({ createProvider });
    await runDaemonCommand(RUN, h.deps);
    h.err.length = 0;
    const initialize = (id: number, profile: string) =>
      serverOptions(h).registry.dispatch(
        {
          jsonrpc: '2.0',
          id,
          method: 'embed.initialize',
          params: { profile },
        },
        testCtx(),
      );
    expect(isJSONRPCResultResponse(await initialize(1, 'granite-97m'))).toBe(true);
    fail = true;
    expect(isJSONRPCResultResponse(await initialize(2, 'harrier-270m'))).toBe(false);
    expect(h.err).toHaveLength(2);
    expect(h.err[0]).toMatch(/^neuro-vault-mcp daemon: loaded granite-97m in \d+ ms\n$/);
    expect(h.err[1]).toMatch(
      /^neuro-vault-mcp daemon: failed to load harrier-270m after \d+ ms: no weights\n$/,
    );
    expect(h.out).toEqual([]);
  });

  it('exits 0 at the deadline when close never finishes', async () => {
    const h = harness();
    h.handle.close.mockImplementation(() => new Promise<void>(() => {}));
    await runDaemonCommand(RUN, h.deps);
    h.signals.get('SIGTERM')!();
    await flush();
    expect(h.exit).not.toHaveBeenCalled();
    h.clock.fire(STOP_DEADLINE_MS);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.files.has(stateFile(h, 'daemon.lock'))).toBe(false);
  });
});

describe('runDaemonCommand (status / stop)', () => {
  it('status lists a live daemon and sweeps a stale one', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1, socket: '/tmp/a.sock' }));
    addKnown(h, 'bbbbbbbbbbbb', infoJson({ pid: 2, version: '17.0.0', socket: '/tmp/b.sock' }));
    h.deps.connect = (p) =>
      p === '/tmp/a.sock'
        ? Promise.resolve(
            fakeInfoSocket({ version: '18.0.0', pid: 1, clients: 2, loaded: ['granite-97m'] }),
          )
        : Promise.reject(errno('ECONNREFUSED'));
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    const report = h.out.join('');
    expect(report).toMatch(/18\.0\.0 .*pid 1 .*clients 2 .*granite-97m.*alive.*\/tmp\/a\.sock/);
    expect(report).toMatch(/17\.0\.0 .*pid 2 .*stale/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
    expect(h.dirs.has(`${BASE}/bbbbbbbbbbbb`)).toBe(false);
    expect(h.files.has(`${BASE}/bbbbbbbbbbbb/daemon.json`)).toBe(false);
  });

  it('status prints each vault entry and its profiles under the daemon line', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 4242, version: '17.2.0', socket: '/tmp/a.sock' }));
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket({
          version: '17.2.0',
          pid: 4242,
          clients: 2,
          loaded: ['harrier-270m'],
          vault: [
            {
              vault: '/vaults/notes',
              clients: 2,
              profiles: [
                {
                  profile: 'harrier-270m',
                  state: 'ready',
                  notes: 955,
                  last_reconcile: {
                    at: '2026-10-16T09:00:00Z',
                    added: 1,
                    changed: 0,
                    removed: 0,
                    ms: 340,
                  },
                },
              ],
            },
            {
              vault: '/vaults/work',
              clients: 0,
              idle_since: '2026-10-14T09:48:00Z',
              profiles: [{ profile: 'harrier-270m', state: 'indexing', indexed: 120, total: 840 }],
            },
          ],
        }),
      );
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('').split('\n')).toEqual([
      '17.2.0  pid 4242  clients 2  loaded [harrier-270m]  alive  /tmp/a.sock',
      '  vault /vaults/notes  clients 2',
      '    harrier-270m  ready  955 notes  last reconcile 2026-10-16T09:00:00Z +1 ~0 -0 340 ms',
      '  vault /vaults/work  idle 12m (since 2026-10-14T09:48:00Z)',
      '    harrier-270m  indexing 120/840',
      '',
    ]);
  });

  it('status prints the other profile states', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ socket: '/tmp/a.sock' }));
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket({
          version: '18.0.0',
          pid: 1,
          clients: 1,
          loaded: [],
          vault: [
            {
              vault: '/v',
              clients: 1,
              profiles: [
                { profile: 'a', state: 'unavailable' },
                { profile: 'b', state: 'disabled' },
                { profile: 'c', state: 'ready', notes: 3 },
                { profile: 'd', state: 'indexing' },
              ],
            },
          ],
        }),
      );
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('').split('\n').slice(1, -1)).toEqual([
      '  vault /v  clients 1',
      '    a  unavailable',
      '    b  disabled',
      '    c  ready  3 notes',
      '    d  indexing',
    ]);
  });

  it('status prints a daemon of another version, which has no vault key, without entries', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ socket: '/tmp/a.sock' }));
    h.deps.connect = () =>
      Promise.resolve(fakeInfoSocket({ version: '17.0.0', pid: 1, clients: 0, loaded: [] }));
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe('17.0.0  pid 1  clients 0  loaded []  alive  /tmp/a.sock\n');
  });

  it.each([
    ['a vault entry without profiles', [{ vault: '/v', clients: 1 }]],
    ['a non-array vault', 'nope'],
    ['a null entry and a null profile', [null, { vault: '/v', clients: 1, profiles: [null] }]],
    [
      'a null or scalar last_reconcile',
      [
        {
          vault: '/v',
          clients: 1,
          profiles: [
            { profile: 'a', state: 'ready', last_reconcile: null },
            { profile: 'b', state: 'ready', last_reconcile: 'yesterday' },
          ],
        },
      ],
    ],
  ])('status survives a future daemon sending %s', async (_name, vault) => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ socket: '/tmp/a.sock' }));
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket({
          version: '19.0.0',
          pid: 1,
          clients: 0,
          loaded: [],
          vault: vault as never,
        }),
      );
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out.join('')).toMatch(/^19\.0\.0 .*alive/);
  });

  it('status sweeps an entry whose socket file is gone', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toMatch(/18\.0\.0 .*pid 1 .*stale/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
  });

  it('status reports a listening daemon that does not answer as busy and keeps it', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    h.deps.connect = () => Promise.resolve(new PassThrough());
    const done = runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    await until(() => h.clock.has(CALL_TIMEOUT_MS));
    h.clock.fire(CALL_TIMEOUT_MS);
    await expect(done).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/18\.0\.0 .*pid 1 .*busy \(no answer\).*\/tmp\/a\.sock/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it('status sweeps an unreadable daemon.json whose lock holder is dead', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', '{not json');
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(
      /aaaaaaaaaaaa {2}stale \(unreadable daemon\.json\) {2}\(swept\)/,
    );
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
  });

  it('status shows an unreadable daemon.json under a live lock as starting', async () => {
    const h = harness({ isAlive: (pid) => pid === 9 });
    addKnown(h, 'aaaaaaaaaaaa', '{not json');
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toMatch(/aaaaaaaaaaaa {2}starting/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it.each(['9', 'garbage'])(
    'status sweeps a lock-only directory whose lock (%s) names no live holder',
    async (raw) => {
      const h = harness();
      addKnown(h, 'aaaaaaaaaaaa', undefined);
      h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, raw);
      await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
      expect(h.out.join('')).toBe('aaaaaaaaaaaa  stale (lock only)  (swept)\n');
      expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
      expect(h.files.has(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe(false);
    },
  );

  it('status shows a lock-only directory under a live lock as starting and keeps it', async () => {
    const h = harness({ isAlive: (pid) => pid === 9 });
    addKnown(h, 'aaaaaaaaaaaa', undefined);
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toBe('aaaaaaaaaaaa  starting\n');
    expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe('9');
  });

  it('status keeps a lock-only directory whose lock a daemon takes before the claim', async () => {
    const h = harness({ isAlive: (pid) => pid === 88 });
    const lock = `${BASE}/aaaaaaaaaaaa/daemon.lock`;
    addKnown(h, 'aaaaaaaaaaaa', undefined);
    h.files.set(lock, '9');
    const fs = h.deps.fs!;
    let raced = false;
    h.deps.fs = {
      ...fs,
      rename: (from, to) => {
        if (from === lock && !raced) {
          raced = true;
          h.files.set(lock, '88');
        }
        return fs.rename(from, to);
      },
    };
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toBe('aaaaaaaaaaaa  starting\n');
    expect(h.files.get(lock)).toBe('88');
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it('status removes a truly empty directory silently', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', undefined);
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe('no daemon known\n');
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
    expect(h.files.has(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe(false);
  });

  it('status leaves a directory holding only daemon.log alone, silently', async () => {
    const h = harness();
    const fs = h.deps.fs!;
    const claimed: string[] = [];
    h.deps.fs = { ...fs, openExclusive: (f, c) => (claimed.push(f), fs.openExclusive(f, c)) };
    addKnown(h, 'aaaaaaaaaaaa', undefined);
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.log`, 'last run\n');
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe('no daemon known\n');
    expect(h.err).toEqual([]);
    expect(claimed).toEqual([]);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
    expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.log`)).toBe('last run\n');
    expect(h.files.has(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe(false);
  });

  it('stop leaves a dead lock-only directory for status to sweep', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', undefined);
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe('9');
    expect(h.deps.kill).not.toHaveBeenCalled();
  });

  it('status keeps a stale-looking entry whose lock names another live pid as starting', async () => {
    const h = harness({ isAlive: (pid) => pid === 77 });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '77');
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe('18.0.0  pid 77  starting\n');
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
    expect(h.files.has(`${BASE}/aaaaaaaaaaaa/daemon.json`)).toBe(true);
    expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe('77');
  });

  it('status sweeps a stale entry whose lock names its own pid, even if that pid is alive', async () => {
    const h = harness({ isAlive: () => true });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '1');
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toMatch(/18\.0\.0 {2}pid 1 {2}stale {2}\(swept\)/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
  });

  it('status sweeps a stale entry whose lock names another dead pid', async () => {
    const h = harness({ isAlive: (pid) => pid === 1 });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '77');
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toMatch(/pid 1 {2}stale {2}\(swept\)/);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
  });

  it('status sweeps a stale entry only after taking its lock over', async () => {
    const h = harness();
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    const fs = h.deps.fs!;
    const order: string[] = [];
    h.deps.fs = {
      ...fs,
      openExclusive: (f, c) => (order.push(`claim ${f} ${c}`), fs.openExclusive(f, c)),
      rmrf: (d) => (order.push(`rmrf ${d}`), fs.rmrf(d)),
    };
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toBe('18.0.0  pid 1  stale  (swept)\n');
    expect(order).toEqual([
      `claim ${BASE}/aaaaaaaaaaaa/daemon.lock 42`,
      `rmrf ${BASE}/aaaaaaaaaaaa`,
    ]);
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(false);
  });

  it('status keeps a stale-looking entry whose lock a daemon takes before the claim', async () => {
    const h = harness({ isAlive: (pid) => pid === 88 });
    const lock = `${BASE}/aaaaaaaaaaaa/daemon.lock`;
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(lock, '9');
    const fs = h.deps.fs!;
    let raced = false;
    h.deps.fs = {
      ...fs,
      rename: (from, to) => {
        // A new daemon replaces the dead holder's lock right after status judged it.
        if (from === lock && !raced) {
          raced = true;
          h.files.set(lock, '88');
        }
        return fs.rename(from, to);
      },
    };
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe('18.0.0  pid 88  starting\n');
    expect(h.files.get(lock)).toBe('88');
    expect(h.files.has(`${BASE}/aaaaaaaaaaaa/daemon.json`)).toBe(true);
    expect([...h.files.keys()].filter((f) => f.includes('.stale.'))).toEqual([]);
  });

  it('status keeps a lockless stale-looking entry when a daemon creates the lock first', async () => {
    const h = harness({ isAlive: (pid) => pid === 88 });
    const lock = `${BASE}/aaaaaaaaaaaa/daemon.lock`;
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    const fs = h.deps.fs!;
    h.deps.fs = {
      ...fs,
      openExclusive: (f, c) => {
        if (f === lock && !h.files.has(lock)) h.files.set(lock, '88');
        return fs.openExclusive(f, c);
      },
    };
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toBe('18.0.0  pid 88  starting\n');
    expect(h.files.get(lock)).toBe('88');
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it('status keeps an unreadable daemon.json whose lock a daemon takes before the claim', async () => {
    const h = harness({ isAlive: (pid) => pid === 88 });
    const lock = `${BASE}/aaaaaaaaaaaa/daemon.lock`;
    addKnown(h, 'aaaaaaaaaaaa', '{not json');
    h.files.set(lock, '9');
    const fs = h.deps.fs!;
    let raced = false;
    h.deps.fs = {
      ...fs,
      rename: (from, to) => {
        if (from === lock && !raced) {
          raced = true;
          h.files.set(lock, '88');
        }
        return fs.rename(from, to);
      },
    };
    await runDaemonCommand({ action: 'status', ...RUN }, h.deps);
    expect(h.out.join('')).toBe('aaaaaaaaaaaa  starting\n');
    expect(h.files.get(lock)).toBe('88');
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it('stop skips a stale-looking entry whose lock names another live pid', async () => {
    const h = harness({ isAlive: (pid) => pid === 77 });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1 }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '77');
    h.deps.connect = () => Promise.reject(errno('ECONNREFUSED'));
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.deps.kill).not.toHaveBeenCalled();
    expect(h.out.join('')).toBe(
      '18.0.0 (pid 77)  starting — not stopped; run `neuro-vault-mcp daemon stop` again\n',
    );
    expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
  });

  it.each([
    ['an unreadable daemon.json', '{not json'],
    ['a lock and no daemon.json', undefined],
  ])('stop reports a daemon starting with %s instead of no daemon known', async (_, info) => {
    const h = harness({ isAlive: (pid) => pid === 9 });
    addKnown(h, 'aaaaaaaaaaaa', info);
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe(
      'aaaaaaaaaaaa  starting — not stopped; run `neuro-vault-mcp daemon stop` again\n',
    );
    expect(h.deps.kill).not.toHaveBeenCalled();
    expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe('9');
  });

  it('stop stops an alive daemon and reports a starting one beside it', async () => {
    const h = harness({ isAlive: (pid) => pid === 9 });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    addKnown(h, 'bbbbbbbbbbbb', undefined);
    h.files.set(`${BASE}/bbbbbbbbbbbb/daemon.lock`, '9');
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket(
          { version: '18.0.0', pid: 1, clients: 0, loaded: [] },
          {
            onRequest: (method) => {
              if (method === 'daemon.shutdown') h.files.delete(`${BASE}/aaaaaaaaaaaa/daemon.json`);
            },
          },
        ),
      );
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toBe(
      'stopped 18.0.0 (pid 1)\n' +
        'bbbbbbbbbbbb  starting — not stopped; run `neuro-vault-mcp daemon stop` again\n',
    );
  });

  it('stop stops two live daemons of different builds, and status then knows none', async () => {
    const h = harness({ isAlive: () => true });
    const daemons = [
      { key: daemonKey('18.0.0', { size: 1000, mtimeMs: 1 }), pid: 1, socket: '/tmp/a.sock' },
      { key: daemonKey('18.0.0', { size: 2000, mtimeMs: 2 }), pid: 2, socket: '/tmp/b.sock' },
    ];
    expect(daemons[0].key).not.toBe(daemons[1].key);
    for (const d of daemons) {
      addKnown(h, d.key, infoJson({ pid: d.pid, socket: d.socket }));
      h.files.set(`${BASE}/${d.key}/daemon.lock`, String(d.pid));
    }
    const shutdowns: number[] = [];
    h.deps.connect = (p) => {
      const d = daemons.find((x) => x.socket === p);
      if (d === undefined) return Promise.reject(errno('ECONNREFUSED'));
      return Promise.resolve(
        fakeInfoSocket(
          { version: '18.0.0', pid: d.pid, clients: 1, loaded: ['harrier-270m'] },
          {
            onRequest: (method) => {
              if (method !== 'daemon.shutdown') return;
              // What a daemon's own stop removes: daemon.json, then the lock.
              shutdowns.push(d.pid);
              h.files.delete(`${BASE}/${d.key}/daemon.json`);
              h.files.delete(`${BASE}/${d.key}/daemon.lock`);
            },
          },
        ),
      );
    };

    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(shutdowns.sort()).toEqual([1, 2]);
    expect(h.out.join('').split('\n').filter(Boolean).sort()).toEqual([
      'stopped 18.0.0 (pid 1)',
      'stopped 18.0.0 (pid 2)',
    ]);
    expect(h.deps.kill).not.toHaveBeenCalled();
    expect(h.err).toEqual([]);

    h.out.length = 0;
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/no daemon known/);
    expect(h.err).toEqual([]);
  });

  /** Reading this entry's lock fails as an unreadable file would (EACCES). */
  function lockUnreadable(h: Harness, name: string): void {
    const fs = h.deps.fs!;
    h.deps.fs = {
      ...fs,
      read: (f) => {
        if (f === `${BASE}/${name}/daemon.lock`) throw errno('EACCES');
        return fs.read(f);
      },
    };
  }

  it.each([
    ['a stale-looking daemon.json', infoJson({ pid: 1 })],
    ['no daemon.json', undefined],
  ])(
    'status reports an entry with %s whose lock cannot be read on stderr and goes on',
    async (_, info) => {
      const h = harness();
      addKnown(h, 'aaaaaaaaaaaa', info);
      h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '9');
      addKnown(h, 'bbbbbbbbbbbb', infoJson({ pid: 2, version: '17.0.0', socket: '/tmp/b.sock' }));
      lockUnreadable(h, 'aaaaaaaaaaaa');
      await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
      expect(h.err.join('')).toBe('aaaaaaaaaaaa: EACCES\n');
      expect(h.out.join('')).toBe('17.0.0  pid 2  stale  (swept)\n');
      expect(h.dirs.has(`${BASE}/aaaaaaaaaaaa`)).toBe(true);
      expect(h.files.get(`${BASE}/aaaaaaaaaaaa/daemon.lock`)).toBe('9');
      expect(h.dirs.has(`${BASE}/bbbbbbbbbbbb`)).toBe(false);
    },
  );

  it('stop reports an entry whose lock cannot be read on stderr and stops the next', async () => {
    const h = harness({ isAlive: () => true });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({ pid: 1, socket: '/tmp/a.sock' }));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '1');
    addKnown(h, 'bbbbbbbbbbbb', infoJson({ pid: 2, socket: '/tmp/b.sock' }));
    lockUnreadable(h, 'aaaaaaaaaaaa');
    h.deps.connect = (p) =>
      p === '/tmp/b.sock'
        ? Promise.resolve(
            fakeInfoSocket(
              { version: '18.0.0', pid: 2, clients: 0, loaded: [] },
              {
                onRequest: (method) => {
                  if (method === 'daemon.shutdown') {
                    h.files.delete(`${BASE}/bbbbbbbbbbbb/daemon.json`);
                  }
                },
              },
            ),
          )
        : Promise.reject(errno('ECONNREFUSED'));
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.err.join('')).toBe('aaaaaaaaaaaa: EACCES\n');
    expect(h.out.join('')).toBe('stopped 18.0.0 (pid 2)\n');
    expect(h.deps.kill).not.toHaveBeenCalled();
  });

  it('status with nothing known says so and exits 0', async () => {
    const h = harness();
    await expect(runDaemonCommand({ action: 'status', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/no daemon known/);
    expect(h.err).toEqual([]);
  });

  it('stop with nothing known says so and exits 0', async () => {
    const h = harness();
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/no daemon known/);
  });

  it('stop sends daemon.shutdown and does not signal a daemon that answers', async () => {
    const h = harness({ isAlive: () => true });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    const methods: string[] = [];
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket(
          { version: '18.0.0', pid: 1, clients: 0, loaded: [] },
          {
            onRequest: (method) => {
              methods.push(method);
              if (method === 'daemon.shutdown') h.files.delete(`${BASE}/aaaaaaaaaaaa/daemon.json`);
            },
          },
        ),
      );
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(methods).toEqual(['daemon.shutdown']);
    expect(h.deps.kill).not.toHaveBeenCalled();
    expect(h.out.join('')).toMatch(/stopped 18\.0\.0 \(pid 1\)/);
  });

  it('stop sends daemon.shutdown and falls back to SIGTERM when it does not answer', async () => {
    const kill = vi.fn();
    const h = harness({ isAlive: () => true, kill });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, '1');
    kill.mockImplementation(() => h.files.delete(`${BASE}/aaaaaaaaaaaa/daemon.json`));
    h.deps.connect = () =>
      Promise.resolve(
        fakeInfoSocket(
          { version: '18.0.0', pid: 1, clients: 0, loaded: [] },
          { answerShutdown: false },
        ),
      );
    const done = runDaemonCommand({ action: 'stop', ...RUN }, h.deps);
    await until(() => h.clock.has(CALL_TIMEOUT_MS));
    h.clock.fire(CALL_TIMEOUT_MS);
    await expect(done).resolves.toBe(0);
    expect(kill).toHaveBeenCalledWith(1, 'SIGTERM');
    expect(h.out.join('')).toMatch(/stopped 18\.0\.0 \(pid 1\)/);
  });

  it.each([
    ['names another pid', '77', '77'],
    ['is missing', undefined, 'none'],
  ])(
    'stop does not signal a daemon that does not answer when its lock %s',
    async (_, lock, named) => {
      const h = harness({ isAlive: () => true });
      addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
      if (lock !== undefined) h.files.set(`${BASE}/aaaaaaaaaaaa/daemon.lock`, lock);
      h.deps.connect = () =>
        Promise.resolve(
          fakeInfoSocket(
            { version: '18.0.0', pid: 1, clients: 0, loaded: [] },
            { answerShutdown: false },
          ),
        );
      const done = runDaemonCommand({ action: 'stop', ...RUN }, h.deps);
      await until(() => h.clock.has(CALL_TIMEOUT_MS));
      h.clock.fire(CALL_TIMEOUT_MS);
      await expect(done).resolves.toBe(0);
      expect(h.deps.kill).not.toHaveBeenCalled();
      expect(h.err.join('')).toBe(
        `daemon 18.0.0 (pid 1) did not answer; not signalling pid 1 (lock names ${named})\n`,
      );
      expect(h.out).toEqual([]);
    },
  );

  it('stop leaves a stale entry alone: no shutdown, no signal', async () => {
    const h = harness({ isAlive: () => true });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    h.deps.connect = () => Promise.reject(errno('ECONNREFUSED'));
    await expect(runDaemonCommand({ action: 'stop', ...RUN }, h.deps)).resolves.toBe(0);
    expect(h.deps.kill).not.toHaveBeenCalled();
    expect(h.out.join('')).toMatch(/18\.0\.0 .*pid 1 .*not running/);
  });

  it('stop reports a daemon that is still there after the wait on stderr', async () => {
    const h = harness({ isAlive: () => true });
    addKnown(h, 'aaaaaaaaaaaa', infoJson({}));
    h.deps.connect = () =>
      Promise.resolve(fakeInfoSocket({ version: '18.0.0', pid: 1, clients: 0, loaded: [] }));
    const done = runDaemonCommand({ action: 'stop', ...RUN }, h.deps);
    let settled = false;
    void done.finally(() => (settled = true));
    for (let i = 0; i < 500 && !settled; i += 1) {
      await flush();
      h.clock.fire(100);
    }
    await expect(done).resolves.toBe(0);
    expect(h.err.join('')).toMatch(/pid 1 .*still running/);
  });
});

/**
 * A connected socket that speaks the daemon's line protocol: `daemon.info`
 * answers with `info`, `daemon.shutdown` with `{}` unless `answerShutdown` is false.
 */
function fakeInfoSocket(
  info: { version: string; pid: number; clients: number; loaded: string[]; vault?: VaultInfo[] },
  opts: { answerShutdown?: boolean; onRequest?: (method: string) => void } = {},
): Duplex {
  const { answerShutdown = true } = opts;
  const buffer = new ReadBuffer();
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      buffer.append(chunk);
      for (;;) {
        const message = buffer.readMessage();
        if (!message) break;
        if (!isJSONRPCRequest(message)) continue;
        opts.onRequest?.(message.method);
        let reply: JSONRPCMessage | undefined;
        if (message.method === 'daemon.info') {
          reply = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              name: 'neuro-vault-mcp',
              version: info.version,
              pid: info.pid,
              started_at: 'x',
              idle_timeout_min: 30,
              clients: info.clients,
              services: {
                embed: { loaded: info.loaded },
                // A daemon of another version has no `vault` key at all.
                ...(info.vault === undefined ? {} : { vault: info.vault }),
              },
            },
          };
        } else if (message.method === 'daemon.shutdown' && answerShutdown) {
          reply = { jsonrpc: '2.0', id: message.id, result: {} };
        }
        if (reply) socket.push(serializeMessage(reply));
      }
      callback();
    },
  });
  return socket;
}
