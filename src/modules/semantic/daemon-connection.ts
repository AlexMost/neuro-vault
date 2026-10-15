import path from 'node:path';
import type { Duplex } from 'node:stream';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { DaemonPaths } from '../../daemon/paths.js';
import type { SocketConnect, Timers } from '../../daemon/probe.js';
import { DaemonRpcError, type DaemonErrorCode } from '../../daemon/protocol.js';

/** Spawn-and-poll: one `connect` attempt every 50 ms, for at most 10 s (design D6). */
export const POLL_INTERVAL_MS = 50;
export const POLL_TIMEOUT_MS = 10_000;
/** A `connect` that neither succeeds nor fails within this long is ambiguous. */
export const CONNECT_TIMEOUT_MS = 2_000;

/** The daemon could not be found or started; the caller falls back in-process. */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/** The connection dropped with requests in flight; the next call reconnects. */
export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonConnectionError';
  }
}

/** What `ensure()` needs from a spawned child: detach it, and hear an asynchronous spawn failure. */
export interface SpawnedDaemon {
  unref(): void;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnDaemon = (
  file: string,
  args: string[],
  opts: { detached: true; stdio: ['ignore', number, number]; windowsHide: true },
) => SpawnedDaemon;

export interface DaemonConnectionDeps {
  paths: DaemonPaths;
  /** Realpath of the running CLI script; the daemon is spawned from it. */
  cliPath: string;
  /** The running Node binary. */
  execPath: string;
  platform: NodeJS.Platform;
  /**
   * POSIX: make the `/tmp/neuro-vault-<uid>` socket directory a private
   * directory of ours or throw (`ensurePrivateSocketDir`). Run before every
   * connect, so a symlinked or foreign-owned directory is never connected to.
   */
  ensureSocketDir: (dir: string) => void;
  connect: SocketConnect;
  spawn: SpawnDaemon;
  /** Open `daemon.log` for appending; returns the fd. */
  openLog: (file: string) => number;
  closeFd: (fd: number) => void;
  /** `mkdir -p` the state directory (mode 0700). */
  mkdirp: (dir: string) => void;
  timers?: Timers;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** `net.Socket` has these; a test double may not. */
interface Refable {
  ref?: () => unknown;
  unref?: () => unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only ENOENT and ECONNREFUSED prove nothing listens; anything else is ambiguous. */
function isNotListening(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/**
 * One client connection to the shared daemon of this build: find it, start it
 * if nothing listens, and carry JSON-RPC requests with ids and timeouts.
 *
 * `ensure()` connects lazily and coalesces concurrent callers. When nothing
 * listens (ENOENT, ECONNREFUSED) it spawns `<node> <cli.js> daemon` detached
 * with stdout and stderr appended to `daemon.log`, then polls `connect`. The
 * spawn race needs no handling here: a second daemon for the key loses at the
 * lock or the live-socket probe and exits into the log, and both clients
 * connect to the winner. Any doubt — an ambiguous connect error, a connect
 * that never settles, a socket directory that is not ours, a `.ts` entry
 * point, a spawn or log failure, a poll that runs out — is a
 * `DaemonUnavailableError`, on which the caller falls back in-process.
 *
 * A socket that closes, errors or is ended by the daemon rejects every pending
 * request with `DaemonConnectionError` and is forgotten; the next request
 * connects again (respawning if needed). A request the daemon never answers
 * rejects after its own timeout. The socket is unref'd while nothing is
 * pending, so an idle connection never keeps a finished process alive.
 */
export class DaemonConnection {
  private socket?: Duplex;
  /** Forgets `socket` and rejects what is pending on it; set by `attach`. */
  private dropSocket?: () => void;
  private connecting?: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private connections = 0;
  private readonly timers: Timers;

  constructor(private readonly deps: DaemonConnectionDeps) {
    this.timers = deps.timers ?? { setTimeout, clearTimeout };
  }

  /** Bumped on every new connection, so a caller can redo per-connection setup. */
  get epoch(): number {
    return this.connections;
  }

  /** Connected, spawning the daemon first if nothing listens. Idempotent and coalescing. */
  ensure(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    // A socket ended or destroyed without its `close` delivered yet is already gone.
    if (this.socket && (this.socket.destroyed || this.socket.writableEnded)) this.dropSocket?.();
    await this.ensure();
    const socket = this.socket;
    if (!socket) throw new DaemonConnectionError(`daemon connection closed before ${method}`);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        this.refWhilePending(socket);
        reject(new Error(`daemon request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.refWhilePending(socket);
      socket.write(serializeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.dropSocket?.();
  }

  private async establish(): Promise<void> {
    const { paths, platform } = this.deps;
    if (platform !== 'win32') {
      try {
        this.deps.ensureSocketDir(path.posix.dirname(paths.socketPath));
      } catch (error) {
        throw new DaemonUnavailableError(messageOf(error));
      }
    }
    let socket: Duplex;
    try {
      socket = await this.connectOnce();
    } catch (error) {
      if (!isNotListening(error)) {
        throw error instanceof DaemonUnavailableError
          ? error
          : new DaemonUnavailableError(`cannot reach the daemon: ${messageOf(error)}`);
      }
      const spawnFailure = this.spawnDaemon();
      socket = await this.poll(spawnFailure);
    }
    this.attach(socket);
  }

  /** `connect`, bounded: a late socket after the timeout is destroyed, never leaked. */
  private connectOnce(): Promise<Duplex> {
    const socketPath = this.deps.paths.socketPath;
    const timeoutMs = this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    return new Promise<Duplex>((resolve, reject) => {
      let settled = false;
      const timer = this.timers.setTimeout(() => {
        settled = true;
        reject(
          new DaemonUnavailableError(
            `connect to ${socketPath} did not settle within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      // Started inside a chain so a synchronous throw from `connect` is a rejection.
      Promise.resolve()
        .then(() => this.deps.connect(socketPath))
        .then(
          (socket) => {
            if (settled) {
              socket.destroy();
              return;
            }
            settled = true;
            this.timers.clearTimeout(timer);
            resolve(socket);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            this.timers.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  }

  /**
   * Start `<node> <cli.js> daemon` detached, its output appended to
   * `daemon.log`. Returns a getter for an asynchronous spawn failure (Node
   * reports a missing binary as an `error` event, not a throw).
   */
  private spawnDaemon(): () => Error | undefined {
    const { cliPath, execPath, paths } = this.deps;
    if (cliPath.endsWith('.ts')) {
      throw new DaemonUnavailableError(
        'the daemon cannot be started from a TypeScript entry point (development run)',
      );
    }
    let failure: Error | undefined;
    try {
      // The state directory first: a fresh cache has no daemons/<key>/ to put the log in.
      this.deps.mkdirp(paths.stateDir);
      const log = this.deps.openLog(paths.logFile);
      try {
        const child = this.deps.spawn(execPath, [cliPath, 'daemon'], {
          detached: true,
          stdio: ['ignore', log, log],
          windowsHide: true,
        });
        child.once('error', (error) => {
          failure = error;
        });
        child.unref();
      } finally {
        this.deps.closeFd(log);
      }
    } catch (error) {
      throw new DaemonUnavailableError(`could not start the daemon: ${messageOf(error)}`);
    }
    return () => failure;
  }

  private async poll(spawnFailure: () => Error | undefined): Promise<Duplex> {
    const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const budget = this.deps.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    for (let waited = 0; waited <= budget; waited += interval) {
      await new Promise<void>((resolve) => void this.timers.setTimeout(resolve, interval));
      const failed = spawnFailure();
      if (failed) {
        throw new DaemonUnavailableError(`could not start the daemon: ${failed.message}`);
      }
      try {
        return await this.connectOnce();
      } catch (error) {
        if (!isNotListening(error)) {
          throw error instanceof DaemonUnavailableError
            ? error
            : new DaemonUnavailableError(`cannot reach the daemon: ${messageOf(error)}`);
        }
      }
    }
    throw new DaemonUnavailableError(
      `the daemon did not answer within ${budget} ms (see ${this.deps.paths.logFile})`,
    );
  }

  private attach(socket: Duplex): void {
    this.socket = socket;
    this.connections += 1;
    this.refWhilePending(socket);
    const buffer = new ReadBuffer();
    socket.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch {
          // Not our daemon's framing: nothing more on this socket can be trusted.
          socket.destroy();
          return;
        }
        if (!message) return;
        this.settle(socket, message);
      }
    });
    const drop = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.dropSocket = undefined;
      for (const [id, entry] of this.pending) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new DaemonConnectionError(`daemon connection closed during ${entry.method}`));
      }
      socket.destroy();
    };
    this.dropSocket = drop;
    // The daemon ends a socket when it stops; a request written after that is
    // never answered, so the end of input already counts as the close.
    socket.on('end', drop);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private settle(socket: Duplex, message: JSONRPCMessage): void {
    if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) return;
    const id = typeof message.id === 'number' ? message.id : Number.NaN;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.timers.clearTimeout(entry.timer);
    this.refWhilePending(socket);
    if (isJSONRPCErrorResponse(message)) {
      const data = message.error.data as { code?: unknown } | undefined;
      const code = typeof data?.code === 'string' ? (data.code as DaemonErrorCode) : 'INTERNAL';
      entry.reject(new DaemonRpcError(code, message.error.message));
    } else {
      entry.resolve(message.result);
    }
  }

  /** Hold the event loop open only while an answer is awaited. */
  private refWhilePending(socket: Duplex): void {
    const handle = socket as Refable;
    if (this.pending.size > 0) handle.ref?.();
    else handle.unref?.();
  }
}
