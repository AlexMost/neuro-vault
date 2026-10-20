import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Timers } from '../../src/lib/timers.js';
import { ServiceRegistry, type IConnectionContext } from '../../src/daemon/protocol.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';

const posix = process.platform !== 'win32';

class LineClient {
  private readonly buffer = new ReadBuffer();
  private readonly waiting: Array<(m: JSONRPCMessage) => void> = [];
  private readonly queued: JSONRPCMessage[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.readMessage();
        if (!message) break;
        const take = this.waiting.shift();
        if (take) take(message);
        else this.queued.push(message);
      }
    });
  }
  static connect(p: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(p);
      socket.once('connect', () => resolve(new LineClient(socket)));
      socket.once('error', reject);
    });
  }
  send(message: JSONRPCMessage): void {
    this.socket.write(serializeMessage(message));
  }
  next(): Promise<JSONRPCMessage> {
    const queued = this.queued.shift();
    return queued ? Promise.resolve(queued) : new Promise((resolve) => this.waiting.push(resolve));
  }
  closed(): Promise<void> {
    return new Promise((resolve) => this.socket.once('close', () => resolve()));
  }
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

describe.skipIf(!posix)('startDaemonServer', () => {
  let dir: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/nv-sock-');
    socketPath = path.join(dir, 's.sock');
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function registryWith(
    handlers: Record<string, (p: unknown, ctx: IConnectionContext) => Promise<unknown>>,
  ): ServiceRegistry {
    const registry = new ServiceRegistry();
    registry.register('t', handlers);
    return registry;
  }

  /** A `Timers` that records every timer and never schedules a real one, so nothing outlives the test. */
  function fakeTimers(): { timers: Timers; armed: FakeTimer[] } {
    const armed: FakeTimer[] = [];
    const timers = {
      setTimeout: vi.fn((fn: () => void, ms: number) => {
        const entry: FakeTimer = { fn, ms, cleared: false };
        armed.push(entry);
        return entry;
      }),
      clearTimeout: vi.fn((entry: FakeTimer) => {
        entry.cleared = true;
      }),
    };
    return { timers: timers as unknown as Timers, armed };
  }

  it('answers requests from two clients and counts them once they send a request', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    const b = await LineClient.connect(socketPath);
    await tick();
    expect(handle.clients()).toBe(0);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: { text: 'line one\nline "two"' } });
    b.send({ jsonrpc: '2.0', id: 2, method: 't.echo', params: { n: 2 } });
    expect(await a.next()).toMatchObject({ id: 1, result: { text: 'line one\nline "two"' } });
    expect(await b.next()).toMatchObject({ id: 2, result: { n: 2 } });
    expect(handle.clients()).toBe(2);
    a.socket.destroy();
    await a.closed();
    await tick();
    expect(handle.clients()).toBe(1);
    b.socket.destroy();
  });

  /** `t.*` plus a `daemon` namespace whose `info` reports `clients()` as seen by its caller. */
  function registryWithDaemon(): ServiceRegistry {
    const registry = registryWith({ echo: async (p) => p });
    registry.register('daemon', { info: async () => ({ clients: handle?.clients() }) });
    return registry;
  }

  it('does not count a connection that only calls daemon.* methods', async () => {
    const { timers, armed } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWithDaemon(),
      idleTimeoutMs: 60_000,
      onIdle: () => {},
      timers,
    });
    const admin = await LineClient.connect(socketPath);
    admin.send({ jsonrpc: '2.0', id: 1, method: 'daemon.info' });
    expect(await admin.next()).toMatchObject({ id: 1, result: { clients: 0 } });
    expect(handle.clients()).toBe(0);
    admin.socket.destroy();
    await admin.closed();
    await tick();
    // Neither its arrival, its request nor its close touched the timer armed at listen.
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.clearTimeout).not.toHaveBeenCalled();
    expect(armed[0]?.cleared).toBe(false);
  });

  it('daemon.info counts the clients but not its own caller', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWithDaemon(),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const client = await LineClient.connect(socketPath);
    client.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: {} });
    await client.next();
    const admin = await LineClient.connect(socketPath);
    admin.send({ jsonrpc: '2.0', id: 2, method: 'daemon.info' });
    expect(await admin.next()).toMatchObject({ id: 2, result: { clients: 1 } });
    client.socket.destroy();
    admin.socket.destroy();
  });

  it('keeps the connection open after an UNKNOWN_METHOD answer', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWithDaemon(),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const client = await LineClient.connect(socketPath);
    let closed = false;
    void client.closed().then(() => {
      closed = true;
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'watch.subscribe', params: {} });
    expect(await client.next()).toMatchObject({
      id: 1,
      error: { code: -32601, data: { code: 'UNKNOWN_METHOD' } },
    });
    client.send({ jsonrpc: '2.0', id: 2, method: 'daemon.info' });
    expect(await client.next()).toMatchObject({ id: 2, result: expect.any(Object) });
    expect(closed).toBe(false);
    client.socket.destroy();
  });

  it('gives each connection its own context id', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ who: async (_p, ctx) => ({ id: ctx.id }) }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    const b = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.who' });
    b.send({ jsonrpc: '2.0', id: 1, method: 't.who' });
    a.send({ jsonrpc: '2.0', id: 2, method: 't.who' });
    const [a1, a2, b1] = [await a.next(), await a.next(), await b.next()];
    const idOf = (m: JSONRPCMessage): number =>
      (m as unknown as { result: { id: number } }).result.id;
    expect(idOf(a1)).toBe(idOf(a2));
    expect(idOf(a1)).not.toBe(idOf(b1));
    expect(new Set([idOf(a1), idOf(b1)])).toEqual(new Set([1, 2]));
    a.socket.destroy();
    b.socket.destroy();
  });

  /** A server whose `t.watch` registers `onClose` callbacks that push `label` onto `closed`. */
  async function watching(
    closed: string[],
    log?: (line: string) => void,
  ): Promise<{ ctxs: IConnectionContext[] }> {
    const ctxs: IConnectionContext[] = [];
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({
        watch: async (p, ctx) => {
          ctxs.push(ctx);
          ctx.onClose(() => closed.push((p as { label: string }).label));
          return {};
        },
      }),
      idleTimeoutMs: 0,
      onIdle: () => {},
      ...(log ? { log } : {}),
    });
    return { ctxs };
  }

  it('runs onClose callbacks when that socket closes, not another', async () => {
    const closed: string[] = [];
    await watching(closed);
    const a = await LineClient.connect(socketPath);
    const b = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.watch', params: { label: 'a' } });
    b.send({ jsonrpc: '2.0', id: 1, method: 't.watch', params: { label: 'b' } });
    await a.next();
    await b.next();
    expect(closed).toEqual([]);
    a.socket.destroy();
    await a.closed();
    await tick();
    expect(closed).toEqual(['a']);
    b.socket.destroy();
    await b.closed();
    await tick();
    expect(closed).toEqual(['a', 'b']);
  });

  it('runs onClose callbacks for a connection closed by a bad line', async () => {
    const closed: string[] = [];
    await watching(closed);
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.watch', params: { label: 'a' } });
    await a.next();
    a.socket.write('this is not json\n');
    await a.closed();
    await tick();
    expect(closed).toEqual(['a']);
  });

  it('runs onClose callbacks when the server shuts down', async () => {
    const closed: string[] = [];
    await watching(closed);
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.watch', params: { label: 'a' } });
    await a.next();
    await handle?.close();
    handle = undefined;
    expect(closed).toEqual(['a']);
  });

  it('a throwing onClose callback is logged and does not skip the rest', async () => {
    const lines: string[] = [];
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({
        watch: async (_p, ctx) => {
          ctx.onClose(() => {
            throw new Error('first failed');
          });
          ctx.onClose(() => lines.push('second ran'));
          return {};
        },
      }),
      idleTimeoutMs: 0,
      onIdle: () => {},
      log: (line) => lines.push(line),
    });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.watch' });
    await a.next();
    a.socket.destroy();
    await a.closed();
    await tick();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first failed');
    expect(lines[1]).toBe('second ran');
  });

  it('runs an onClose callback registered after the socket closed immediately', async () => {
    const closed: string[] = [];
    const { ctxs } = await watching(closed);
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.watch', params: { label: 'early' } });
    await a.next();
    a.socket.destroy();
    await a.closed();
    await tick();
    ctxs[0]?.onClose(() => closed.push('late'));
    expect(closed).toEqual(['early', 'late']);
  });

  it('closes only the client that sends a bad line', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const bad = await LineClient.connect(socketPath);
    const good = await LineClient.connect(socketPath);
    bad.socket.write('this is not json\n');
    await bad.closed();
    good.send({ jsonrpc: '2.0', id: 3, method: 't.echo', params: { ok: true } });
    expect(await good.next()).toMatchObject({ id: 3, result: { ok: true } });
    good.socket.destroy();
  });

  it('closes only the client whose chunk overflows the ReadBuffer', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    // SDK >= 1.30 throws from `append` past its size cap; 1.29 never does, so
    // simulate the throw for one marked chunk and leave every other call alone.
    const append = ReadBuffer.prototype.append;
    const spy = vi.spyOn(ReadBuffer.prototype, 'append').mockImplementation(function (
      this: ReadBuffer,
      chunk: Buffer,
    ) {
      if (chunk.includes('OVERFLOW')) throw new Error('ReadBuffer exceeded maximum size');
      append.call(this, chunk);
    });
    try {
      const bad = await LineClient.connect(socketPath);
      const good = await LineClient.connect(socketPath);
      bad.socket.write('OVERFLOW\n');
      await bad.closed();
      good.send({ jsonrpc: '2.0', id: 4, method: 't.echo', params: { ok: true } });
      expect(await good.next()).toMatchObject({ id: 4, result: { ok: true } });
      good.socket.destroy();
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores notifications and client-sent responses, and keeps the connection', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', method: 't.echo', params: { n: 0 } });
    a.send({ jsonrpc: '2.0', id: 7, result: {} });
    a.send({ jsonrpc: '2.0', id: 4, method: 't.echo', params: { n: 4 } });
    expect(await a.next()).toMatchObject({ id: 4, result: { n: 4 } });
    a.socket.destroy();
  });

  it('arms the idle timer when the last client leaves and disarms it on a new one', async () => {
    const onIdle = vi.fn();
    const { timers, armed } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 60_000,
      onIdle,
      timers,
    });
    // Armed once at listen (zero clients), before anyone connects.
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    const a = await LineClient.connect(socketPath);
    await tick();
    // A connection is not a client until it sends a service request.
    expect(timers.clearTimeout).not.toHaveBeenCalled();
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: {} });
    await a.next();
    // The first client disarms it.
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(armed[0]?.cleared).toBe(true);
    a.socket.destroy();
    await a.closed();
    await tick();
    // The last client leaving re-arms it.
    expect(timers.setTimeout).toHaveBeenCalledTimes(2);
    const b = await LineClient.connect(socketPath);
    b.send({ jsonrpc: '2.0', id: 2, method: 't.echo', params: {} });
    await b.next();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(2);
    expect(armed[1]?.cleared).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();
    b.socket.destroy();
  });

  it('a second client neither disarms nor re-arms the timer', async () => {
    const { timers } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 60_000,
      onIdle: () => {},
      timers,
    });
    const a = await LineClient.connect(socketPath);
    const b = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: {} });
    await a.next();
    b.send({ jsonrpc: '2.0', id: 2, method: 't.echo', params: {} });
    await b.next();
    a.socket.destroy();
    await a.closed();
    await tick();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    b.socket.destroy();
  });

  it('idles out a daemon nobody ever connects to', async () => {
    const onIdle = vi.fn();
    const { timers, armed } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({}),
      idleTimeoutMs: 60_000,
      onIdle,
      timers,
    });
    expect(armed).toHaveLength(1);
    expect(armed[0]?.ms).toBe(60_000);
    armed[0]?.fn();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never arms an idle timer when idleTimeoutMs is 0', async () => {
    const { timers } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({}),
      idleTimeoutMs: 0,
      onIdle: () => {},
      timers,
    });
    const a = await LineClient.connect(socketPath);
    a.socket.destroy();
    await a.closed();
    await tick();
    expect(timers.setTimeout).not.toHaveBeenCalled();
  });

  it('close() ends connections and answers in-flight requests with SHUTTING_DOWN', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({
        slow: async () => {
          await gate;
          return {};
        },
      }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 9, method: 't.slow' });
    await tick();
    const closing = handle.close();
    expect(await a.next()).toMatchObject({ id: 9, error: { data: { code: 'SHUTTING_DOWN' } } });
    await a.closed();
    release();
    await closing;
    handle = undefined;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('answers SHUTTING_DOWN to a request that arrives during shutdown', async () => {
    let closing: Promise<void> | undefined;
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({
        stop: async () => {
          closing = handle?.close();
          return {};
        },
        echo: async (p) => p,
      }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    // One write, two lines: id 1 is in flight when close() starts, id 2 arrives during shutdown.
    a.socket.write(
      serializeMessage({ jsonrpc: '2.0', id: 1, method: 't.stop' }) +
        serializeMessage({ jsonrpc: '2.0', id: 2, method: 't.echo', params: {} }),
    );
    const first = await a.next();
    const second = await a.next();
    expect(first).toMatchObject({ id: 1, error: { data: { code: 'SHUTTING_DOWN' } } });
    expect(second).toMatchObject({ id: 2, error: { data: { code: 'SHUTTING_DOWN' } } });
    await a.closed();
    await closing;
    handle = undefined;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('beginClose() answers every later request SHUTTING_DOWN, keeps connections, refuses new ones', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    handle.beginClose();
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: {} });
    expect(await a.next()).toMatchObject({ id: 1, error: { data: { code: 'SHUTTING_DOWN' } } });
    // Still open: ending the connections is close()'s job.
    expect(a.socket.destroyed).toBe(false);
    await expect(LineClient.connect(socketPath)).rejects.toThrow();
    handle.beginClose();
    const closing = handle.close();
    await a.closed();
    await closing;
    handle = undefined;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('beginClose() answers a request already in flight with SHUTTING_DOWN', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({
        slow: async () => {
          await gate;
          return {};
        },
      }),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 4, method: 't.slow' });
    await tick();
    handle.beginClose();
    expect(await a.next()).toMatchObject({ id: 4, error: { data: { code: 'SHUTTING_DOWN' } } });
    release();
    await handle.close();
    handle = undefined;
  });

  it('does not idle out when a client arrived in the same turn the timer fired', async () => {
    const onIdle = vi.fn();
    const { timers, armed } = fakeTimers();
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({ echo: async (p) => p }),
      idleTimeoutMs: 60_000,
      onIdle,
      timers,
    });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: {} });
    await a.next();
    // The timer armed at listen was cleared by the first client, but suppose its callback still runs.
    armed[0]?.fn();
    expect(onIdle).not.toHaveBeenCalled();
    a.socket.destroy();
  });

  it('close() is idempotent', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({}),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    await tick();
    // close() now resolves after the connection's own close handler, so listen before it.
    const clientClosed = a.closed();
    await handle.close();
    await handle.close();
    await clientClosed;
  });

  it('close() does not throw when a client already went away', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({}),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    const a = await LineClient.connect(socketPath);
    await tick();
    a.socket.destroy();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('stops accepting connections once close() has begun', async () => {
    handle = await startDaemonServer({
      socketPath,
      registry: registryWith({}),
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
    await handle.close();
    await expect(LineClient.connect(socketPath)).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|ECONNREFUSED/),
    });
  });
});
