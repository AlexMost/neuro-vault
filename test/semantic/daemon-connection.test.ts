import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCRequest,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonPaths } from '../../src/daemon/paths.js';
import { DaemonRpcError } from '../../src/daemon/protocol.js';
import {
  DaemonConnection,
  DaemonConnectionError,
  DaemonUnavailableError,
  type DaemonConnectionDeps,
  type SpawnedDaemon,
} from '../../src/modules/semantic/daemon-connection.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

type FakeSocket = Duplex & { ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };

/** A fake daemon socket: `reply(request)` returns the answer, or undefined to stay silent. */
function fakeSocket(reply: (req: JSONRPCRequest) => JSONRPCMessage | undefined): FakeSocket {
  const buffer = new ReadBuffer();
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      buffer.append(chunk);
      for (;;) {
        const m = buffer.readMessage();
        if (!m) break;
        if (isJSONRPCRequest(m)) {
          const r = reply(m);
          if (r) socket.push(serializeMessage(r));
        }
      }
      cb();
    },
  }) as FakeSocket;
  socket.ref = vi.fn();
  socket.unref = vi.fn();
  return socket;
}

const echo = (): FakeSocket =>
  fakeSocket((m) => ({ jsonrpc: '2.0', id: m.id, result: { ok: m.method } }));

const silent = (): FakeSocket => fakeSocket(() => undefined);

function fakeChild(): SpawnedDaemon & EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

const paths = daemonPaths({
  version: '18.0.0',
  build: { size: 1, mtimeMs: 2 },
  uid: 1,
  platform: 'linux',
  cacheBase: '/c',
});

function deps(overrides: Partial<DaemonConnectionDeps> = {}) {
  return {
    paths,
    cliPath: '/opt/nv/dist/cli.js',
    build: { size: 1, mtimeMs: 2 },
    statBuild: vi.fn(() => ({ size: 1, mtimeMs: 2 })),
    execPath: '/usr/bin/node',
    cwd: '/home/u',
    platform: 'linux' as const,
    ensureSocketDir: vi.fn(),
    connect: vi.fn(async () => echo() as Duplex),
    spawn: vi.fn(() => fakeChild()),
    openLog: vi.fn(() => 7),
    closeFd: vi.fn(),
    mkdirp: vi.fn(),
    pollIntervalMs: 1,
    pollTimeoutMs: 20,
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function connected(d: DaemonConnectionDeps): Promise<DaemonConnection> {
  const c = new DaemonConnection(d);
  await c.ensure();
  return c;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DaemonConnection — locating the daemon', () => {
  it('connects without spawning when the daemon listens', async () => {
    const d = deps();
    const c = await connected(d);
    await expect(c.request('daemon.info', {}, 1000)).resolves.toEqual({ ok: 'daemon.info' });
    expect(d.spawn).not.toHaveBeenCalled();
    expect(c.epoch).toBe(1);
  });

  it('checks the socket directory before connecting on POSIX', async () => {
    const order: string[] = [];
    const d = deps({
      ensureSocketDir: vi.fn((dir: string) => void order.push(`dir ${dir}`)),
      connect: vi.fn(async (p: string) => {
        order.push(`connect ${p}`);
        return echo();
      }),
    });
    await new DaemonConnection(d).ensure();
    expect(order).toEqual(['dir /tmp/neuro-vault-1', `connect ${paths.socketPath}`]);
  });

  it('is unavailable, without connecting or spawning, when the socket directory is not ours', async () => {
    const d = deps({
      ensureSocketDir: vi.fn(() => {
        throw new Error('socket directory /tmp/neuro-vault-1 is a symlink');
      }),
    });
    const ensuring = new DaemonConnection(d).ensure();
    await expect(ensuring).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(ensuring).rejects.toThrow(/is a symlink/);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('skips the socket directory check for a Windows pipe', async () => {
    const d = deps({ platform: 'win32' });
    await new DaemonConnection(d).ensure();
    expect(d.ensureSocketDir).not.toHaveBeenCalled();
  });

  it('coalesces concurrent callers onto one connect', async () => {
    const d = deps();
    const c = new DaemonConnection(d);
    await Promise.all([c.ensure(), c.ensure(), c.ensure()]);
    expect(d.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['EACCES', 'EPERM', 'ECONNRESET'])(
    'treats an ambiguous %s as unavailable and spawns nothing',
    async (code) => {
      const d = deps({
        connect: vi.fn(async () => {
          throw errno(code);
        }),
      });
      await expect(new DaemonConnection(d).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(d.spawn).not.toHaveBeenCalled();
    },
  );

  it('treats a connect that never settles as unavailable and destroys a late socket', async () => {
    vi.useFakeTimers();
    let late: (s: Duplex) => void = () => {};
    const d = deps({
      connect: vi.fn(() => new Promise<Duplex>((resolve) => (late = resolve))),
      connectTimeoutMs: 100,
    });
    const ensuring = new DaemonConnection(d).ensure();
    const outcome = expect(ensuring).rejects.toThrow(/did not settle within 100 ms/);
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
    const socket = echo();
    late(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroyed).toBe(true);
    expect(d.spawn).not.toHaveBeenCalled();
  });
});

describe('DaemonConnection — spawning the daemon', () => {
  it('creates the state dir, spawns detached with the log fd, and polls until the socket answers', async () => {
    let attempts = 0;
    const order: string[] = [];
    const child = fakeChild();
    const d = deps({
      connect: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw errno('ECONNREFUSED');
        if (attempts < 4) throw errno('ENOENT');
        return echo();
      }),
      mkdirp: vi.fn((dir: string) => void order.push(`mkdirp ${dir}`)),
      openLog: vi.fn((file: string) => {
        order.push(`open ${file}`);
        return 7;
      }),
      spawn: vi.fn(() => {
        order.push('spawn');
        return child;
      }),
      closeFd: vi.fn((fd: number) => void order.push(`close ${fd}`)),
    });
    const c = new DaemonConnection(d);
    await c.ensure();
    expect(order).toEqual([
      `mkdirp ${paths.stateDir}`,
      `open ${paths.logFile}`,
      'spawn',
      'close 7',
    ]);
    expect(d.spawn).toHaveBeenCalledWith('/usr/bin/node', ['/opt/nv/dist/cli.js', 'daemon'], {
      detached: true,
      stdio: ['ignore', 7, 7],
      windowsHide: true,
      cwd: '/home/u',
    });
    expect(child.unref).toHaveBeenCalled();
    expect(attempts).toBe(4);
    expect(c.epoch).toBe(1);
  });

  it.each(['/repo/src/cli.ts', '/repo/src/cli.mts', '/repo/src/cli.cts'])(
    'refuses to spawn from a TypeScript entry point (%s)',
    async (cliPath) => {
      const d = deps({
        cliPath,
        connect: vi.fn(async () => {
          throw errno('ENOENT');
        }),
      });
      const ensuring = new DaemonConnection(d).ensure();
      await expect(ensuring).rejects.toBeInstanceOf(DaemonUnavailableError);
      await expect(ensuring).rejects.toThrow(/TypeScript entry point/);
      expect(d.spawn).not.toHaveBeenCalled();
      expect(d.openLog).not.toHaveBeenCalled();
    },
  );

  it('refuses to spawn a daemon for a CLI script rebuilt since this session started', async () => {
    // An upgrade or `npm run build` replaced cli.js: a daemon spawned from it would key itself
    // by the new build and listen on another socket than the one this session polls.
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      statBuild: vi.fn(() => ({ size: 1, mtimeMs: 3 })),
    });
    const ensuring = new DaemonConnection(d).ensure();
    await expect(ensuring).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(ensuring).rejects.toThrow(/changed since this session started/);
    expect(d.statBuild).toHaveBeenCalledWith('/opt/nv/dist/cli.js');
    expect(d.spawn).not.toHaveBeenCalled();
    expect(d.openLog).not.toHaveBeenCalled();
  });

  it('refuses to spawn when the script was replaced with the same size and mtime (new inode)', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      build: { size: 1, mtimeMs: 2, ino: 10 },
      statBuild: vi.fn(() => ({ size: 1, mtimeMs: 2, ino: 11 })),
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toThrow(
      /changed since this session started/,
    );
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('refuses to spawn when the CLI script is gone', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      statBuild: vi.fn(() => {
        throw errno('ENOENT');
      }),
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toThrow(
      /cannot identify the CLI script/,
    );
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('wraps a spawn throw and still closes the log fd', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ECONNREFUSED');
      }),
      spawn: vi.fn(() => {
        throw new Error('EAGAIN');
      }),
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toThrow(
      /could not start the daemon: EAGAIN/,
    );
    expect(d.closeFd).toHaveBeenCalledWith(7);
  });

  it('wraps a log that cannot be opened (read-only cache) as unavailable', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      openLog: vi.fn(() => {
        throw errno('EROFS');
      }),
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('wraps a state dir that cannot be created as unavailable', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      mkdirp: vi.fn(() => {
        throw errno('EACCES');
      }),
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(d.openLog).not.toHaveBeenCalled();
  });

  it('spawns again when the daemon it started exits without listening', async () => {
    // A stopping daemon has already unlinked its socket but still holds its lock, so the
    // daemon spawned in that window exits ("already running"); once the lock is gone a second
    // spawn takes over. Without a respawn the session would poll a dead socket and fall back.
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      if (children.length === 1) setTimeout(() => child.emit('exit', 1, null), 0);
      return child;
    });
    const connect = vi.fn(async (): Promise<Duplex> => {
      if (children.length < 2) throw errno('ENOENT');
      return echo();
    });
    const d = deps({ connect, spawn, pollTimeoutMs: 10_000 });
    await new DaemonConnection(d).ensure();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('respawns a bounded number of times, then gives up naming the log', async () => {
    const spawn = vi.fn(() => {
      const child = fakeChild();
      setTimeout(() => child.emit('exit', 1, null), 0);
      return child;
    });
    const d = deps({
      connect: vi.fn(async (): Promise<Duplex> => {
        throw errno('ENOENT');
      }),
      spawn,
      pollTimeoutMs: 200,
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toThrow(paths.logFile);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('stops polling as soon as the child reports a spawn error', async () => {
    const child = fakeChild();
    const connect = vi.fn(async (): Promise<Duplex> => {
      throw errno('ENOENT');
    });
    const spawn = vi.fn(() => child);
    const d = deps({ connect, spawn, pollTimeoutMs: 10_000 });
    const ensuring = new DaemonConnection(d).ensure();
    while (spawn.mock.calls.length === 0) await tick();
    child.emit('error', errno('ENOENT'));
    await expect(ensuring).rejects.toThrow(/could not start the daemon: ENOENT/);
    expect(connect.mock.calls.length).toBeLessThan(5);
  });

  it('gives up after the poll budget, naming the log', async () => {
    const d = deps({
      connect: vi.fn(async () => {
        throw errno('ECONNREFUSED');
      }),
    });
    const ensuring = new DaemonConnection(d).ensure();
    await expect(ensuring).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(ensuring).rejects.toThrow(paths.logFile);
  });

  it('stops polling on an ambiguous error', async () => {
    let attempts = 0;
    const d = deps({
      connect: vi.fn(async () => {
        attempts += 1;
        throw errno(attempts === 1 ? 'ENOENT' : 'EACCES');
      }),
      pollTimeoutMs: 10_000,
    });
    await expect(new DaemonConnection(d).ensure()).rejects.toThrow(/cannot reach the daemon/);
    expect(attempts).toBe(2);
  });
});

describe('DaemonConnection — requests', () => {
  it('surfaces a JSON-RPC error as DaemonRpcError with its data.code', async () => {
    const d = deps({
      connect: vi.fn(async () =>
        fakeSocket((m) => ({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32603, message: 'no weights', data: { code: 'EMBED_FAILED' } },
        })),
      ),
    });
    const pending = (await connected(d)).request('embed.initialize', { profile: 'x' }, 1000);
    await expect(pending).rejects.toBeInstanceOf(DaemonRpcError);
    await expect(pending).rejects.toMatchObject({ code: 'EMBED_FAILED', message: 'no weights' });
  });

  it('reads an error without data.code as INTERNAL', async () => {
    const d = deps({
      connect: vi.fn(async () =>
        fakeSocket((m) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'x' } })),
      ),
    });
    await expect((await connected(d)).request('embed.query', {}, 1000)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('matches answers to requests by id, in any order', async () => {
    const held: JSONRPCRequest[] = [];
    let socket: FakeSocket | undefined;
    const d = deps({
      connect: vi.fn(async () => {
        socket = fakeSocket((m) => {
          held.push(m);
          return undefined;
        });
        return socket;
      }),
    });
    const c = await connected(d);
    const first = c.request('embed.query', { text: 'a' }, 1000);
    const second = c.request('embed.query', { text: 'b' }, 1000);
    await tick();
    expect(held).toHaveLength(2);
    socket!.push(serializeMessage({ jsonrpc: '2.0', id: held[1].id, result: { n: 2 } }));
    socket!.push(serializeMessage({ jsonrpc: '2.0', id: held[0].id, result: { n: 1 } }));
    await expect(first).resolves.toEqual({ n: 1 });
    await expect(second).resolves.toEqual({ n: 2 });
  });

  it('times out a request that is never answered, naming the method', async () => {
    vi.useFakeTimers();
    const d = deps({ connect: vi.fn(async () => silent()) });
    const pending = (await connected(d)).request('embed.query', { text: 'x' }, 50);
    const outcome = expect(pending).rejects.toThrow(/embed\.query timed out after 50 ms/);
    await vi.advanceTimersByTimeAsync(50);
    await outcome;
  });

  it('rejects pending requests when the socket closes and reconnects on the next call', async () => {
    const sockets: FakeSocket[] = [];
    const d = deps({
      connect: vi.fn(async () => {
        const s = sockets.length === 0 ? silent() : echo();
        sockets.push(s);
        return s;
      }),
    });
    const c = await connected(d);
    const pending = c.request('embed.query', { text: 'x' }, 1000);
    await tick();
    sockets[0].destroy(new Error('ECONNRESET'));
    await expect(pending).rejects.toBeInstanceOf(DaemonConnectionError);
    await expect(pending).rejects.toThrow(/closed during embed\.query: ECONNRESET/);
    await expect(c.request('embed.query', {}, 1000)).rejects.toBeInstanceOf(DaemonConnectionError);
    expect(d.connect).toHaveBeenCalledTimes(1);
    await c.ensure();
    await expect(c.request('embed.query', { text: 'y' }, 1000)).resolves.toEqual({
      ok: 'embed.query',
    });
    expect(d.connect).toHaveBeenCalledTimes(2);
    expect(c.epoch).toBe(2);
  });

  it('treats the daemon ending the socket as a close — a stopping daemon never hangs a request', async () => {
    let socket: FakeSocket | undefined;
    const d = deps({
      connect: vi.fn(async () => {
        socket = silent();
        return socket;
      }),
    });
    const c = await connected(d);
    const pending = c.request('embed.documents', { texts: ['a'] }, 60_000);
    await tick();
    socket!.push(null);
    await expect(pending).rejects.toBeInstanceOf(DaemonConnectionError);
  });

  it('drops the connection on a line that is not JSON-RPC', async () => {
    let socket: FakeSocket | undefined;
    const d = deps({
      connect: vi.fn(async () => {
        socket = silent();
        return socket;
      }),
    });
    const pending = (await connected(d)).request('embed.query', { text: 'x' }, 1000);
    await tick();
    socket!.push('not json\n');
    await expect(pending).rejects.toBeInstanceOf(DaemonConnectionError);
    // Dropped by the parse error itself (with its cause), not later by the close event.
    await expect(pending).rejects.toThrow(/closed during embed\.query: ./);
    expect(socket!.destroyed).toBe(true);
  });

  it('holds the event loop only while an answer is awaited', async () => {
    let socket: FakeSocket | undefined;
    const d = deps({
      connect: vi.fn(async () => {
        socket = echo();
        return socket;
      }),
    });
    const c = await connected(d);
    await c.ensure();
    expect(socket!.unref).toHaveBeenCalledTimes(1);
    expect(socket!.ref).not.toHaveBeenCalled();
    await c.request('embed.query', { text: 'x' }, 1000);
    expect(socket!.ref).toHaveBeenCalledTimes(1);
    expect(socket!.unref).toHaveBeenCalledTimes(2);
  });

  it('close() destroys the socket and the next call reconnects', async () => {
    const d = deps();
    const c = await connected(d);
    await c.ensure();
    c.close();
    await expect(c.request('embed.query', {}, 1000)).rejects.toBeInstanceOf(DaemonConnectionError);
    await c.ensure();
    await c.request('embed.query', {}, 1000);
    expect(d.connect).toHaveBeenCalledTimes(2);
  });

  it('never connects from request(): it fails until ensure() runs', async () => {
    const d = deps();
    const c = new DaemonConnection(d);
    await expect(c.request('embed.query', {}, 1000)).rejects.toThrow(/closed before embed\.query/);
    expect(d.connect).not.toHaveBeenCalled();
  });

  it('ensure() reconnects past a socket destroyed before its close event arrives', async () => {
    const sockets: FakeSocket[] = [];
    const d = deps({
      connect: vi.fn(async () => {
        const s = echo();
        sockets.push(s);
        return s;
      }),
    });
    const c = await connected(d);
    sockets[0].destroy();
    // No tick: the socket's close event has not been delivered yet.
    await c.ensure();
    expect(d.connect).toHaveBeenCalledTimes(2);
    expect(c.epoch).toBe(2);
  });
});
