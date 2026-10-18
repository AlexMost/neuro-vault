import path from 'node:path';
import type { Duplex } from 'node:stream';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { CliBuild, DaemonPaths } from '../../daemon/paths.js';
import type { SocketConnect } from '../../daemon/probe.js';
import type { Timers } from '../../lib/timers.js';
import { DaemonRpcError, type DaemonErrorCode } from '../../daemon/protocol.js';

/** Spawn-and-poll: one `connect` attempt every 50 ms, for at most 10 s (design D6). */
export const POLL_INTERVAL_MS = 50;
export const POLL_TIMEOUT_MS = 10_000;
/** A `connect` that neither succeeds nor fails within this long is ambiguous. */
export const CONNECT_TIMEOUT_MS = 2_000;
/**
 * Spawns after the first, when a started daemon exits without ever listening.
 * The usual cause is a daemon still stopping: it unlinks its socket at once
 * but releases its lock only once its connections close, so a daemon spawned
 * in that window exits "already running". A later spawn finds the lock gone.
 */
export const MAX_RESPAWNS = 2;

/** What the facades need from a connection — `DaemonConnection` in production. */
export interface IDaemonLink {
  /**
   * Changes on every new connection; per-connection setup (`embed.initialize`,
   * `vault.attach`) is re-sent once per value.
   */
  readonly epoch: number;
  /** Connect (spawning the daemon if needed); `DaemonUnavailableError` when that fails. */
  ensure(): Promise<void>;
  /**
   * Drop the connection, rejecting what is pending on it, and stop a connect in
   * flight (its `ensure()` rejects with `DaemonConnectionError`); the next
   * `ensure()` reconnects.
   */
  close(): void;
  /** One request on the current connection; never connects. */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

/** The daemon could not be found or started; the caller falls back in-process. */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/** The connection dropped with requests in flight; the next call reconnects. */
export class DaemonConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonConnectionError';
  }
}

/** The daemon did not answer a request within its timeout; the connection stays up. */
export class DaemonTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonTimeoutError';
  }
}

/**
 * The CLI script's build (size + mtime, which key the daemon) and, where the
 * platform has one, its inode: a replaced file is a new inode even when an
 * installer gives it the same size and mtime.
 */
export type CliStamp = CliBuild & { ino?: number };

/** What `ensure()` needs from a spawned child: detach it, hear a spawn failure and its exit. */
export interface SpawnedDaemon {
  unref(): void;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

/** One started daemon process, as the poll sees it. */
interface Launch {
  /** Node could not start the process at all (a missing binary arrives as an `error` event). */
  failure(): Error | undefined;
  /** The process ended; a daemon that serves never does while the poll runs. */
  exited(): boolean;
}

export type SpawnDaemon = (
  file: string,
  args: string[],
  opts: {
    detached: true;
    stdio: ['ignore', number, number];
    windowsHide: true;
    cwd: string;
  },
) => SpawnedDaemon;

export interface DaemonConnectionDeps {
  paths: DaemonPaths;
  /** Realpath of the running CLI script; the daemon is spawned from it. */
  cliPath: string;
  /** The size and mtime `paths` were keyed by (plus the inode), read when this session started. */
  build: CliStamp;
  /** Re-read `cliPath`'s stamp; compared with `build` before every spawn. */
  statBuild: (cliPath: string) => CliStamp;
  /**
   * Working directory of a spawned daemon. It outlives the session that
   * started it, so not that session's directory (a project the user may
   * delete or unmount).
   */
  cwd: string;
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

/** The rejection of an `ensure()` whose connect `close()` stopped. */
function closedWhileConnecting(): DaemonConnectionError {
  return new DaemonConnectionError('daemon connection closed while connecting');
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
 * request with `DaemonConnectionError` and is forgotten; the next `ensure()`
 * connects again (respawning if needed). `close()` drops the socket the same
 * way, and stops a connect in flight where it is: no timer of the poll is left,
 * nothing is spawned after it, a socket that connects after it is destroyed,
 * and that `ensure()` rejects with `DaemonConnectionError` — never
 * `DaemonUnavailableError`, so a hang-up is no reason to fall back. A request the daemon never answers
 * rejects after its own timeout. The socket is unref'd while nothing is
 * pending, so an idle connection never keeps a finished process alive.
 */
export class DaemonConnection implements IDaemonLink {
  private socket?: Duplex;
  /** Forgets `socket` and rejects what is pending on it; set by `attach`. */
  private dropSocket?: () => void;
  /** The establish in flight; `close()` aborts it. */
  private connecting?: { done: Promise<void>; abort: AbortController };
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
    // A socket ended or destroyed whose `close` has not arrived yet is already gone.
    if (this.socket && (this.socket.destroyed || this.socket.writableEnded)) this.dropSocket?.();
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting.done;
    const abort = new AbortController();
    const attempt = {
      abort,
      done: this.establish(abort.signal).finally(() => {
        // close() may have forgotten this attempt and a later ensure() started another.
        if (this.connecting === attempt) this.connecting = undefined;
      }),
    };
    this.connecting = attempt;
    return attempt.done;
  }

  /**
   * Send one request on the current connection. Never connects: a caller
   * runs `ensure()` first, so per-connection setup (the facade's
   * `embed.initialize`) cannot be skipped by a reconnect hidden in here.
   */
  async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed || socket.writableEnded) {
      throw new DaemonConnectionError(`daemon connection closed before ${method}`);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        this.refWhilePending(socket);
        reject(new DaemonTimeoutError(`daemon request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.refWhilePending(socket);
      socket.write(serializeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    // Only the attempt in flight stops: the next ensure() starts a fresh one.
    this.connecting?.abort.abort();
    this.connecting = undefined;
    this.dropSocket?.();
  }

  private async establish(signal: AbortSignal): Promise<void> {
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
      socket = await this.connectOnce(signal);
    } catch (error) {
      if (signal.aborted) throw closedWhileConnecting();
      if (!isNotListening(error)) {
        throw error instanceof DaemonUnavailableError
          ? error
          : new DaemonUnavailableError(`cannot reach the daemon: ${messageOf(error)}`);
      }
      this.checkSpawnable();
      socket = await this.poll(this.launch(), signal);
    }
    if (signal.aborted) {
      socket.destroy();
      throw closedWhileConnecting();
    }
    this.attach(socket);
  }

  /**
   * `connect`, bounded: a late socket after the timeout or an abort is
   * destroyed, never leaked.
   */
  private connectOnce(signal: AbortSignal): Promise<Duplex> {
    const socketPath = this.deps.paths.socketPath;
    const timeoutMs = this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    return new Promise<Duplex>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        reject(closedWhileConnecting());
      };
      const timer = this.timers.setTimeout(() => {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(
          new DaemonUnavailableError(
            `connect to ${socketPath} did not settle within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
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
            signal.removeEventListener('abort', onAbort);
            resolve(socket);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            this.timers.clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  }

  /**
   * Whether this session may start a daemon at all. Checked once per spawn
   * attempt, before anything is created.
   */
  private checkSpawnable(): void {
    const { cliPath } = this.deps;
    if (/\.[cm]?tsx?$/.test(cliPath)) {
      throw new DaemonUnavailableError(
        'the daemon cannot be started from a TypeScript entry point (development run)',
      );
    }
    // An upgrade or a rebuild replaced the script since this session keyed its
    // paths: a daemon spawned from it would key itself by the new build and
    // listen on another socket than the one polled here. That build's daemon
    // belongs to new sessions; this one embeds in-process instead. The inode
    // catches a replacement that kept both size and mtime (npm extracts every
    // file with one fixed mtime).
    let current: CliStamp;
    try {
      current = this.deps.statBuild(cliPath);
    } catch (error) {
      throw new DaemonUnavailableError(
        `cannot identify the CLI script at ${cliPath}: ${messageOf(error)}`,
      );
    }
    const { build } = this.deps;
    if (
      current.size !== build.size ||
      current.mtimeMs !== build.mtimeMs ||
      (current.ino !== undefined && build.ino !== undefined && current.ino !== build.ino)
    ) {
      throw new DaemonUnavailableError(
        `the CLI script at ${cliPath} changed since this session started (upgraded or rebuilt); ` +
          'restart the session to use the new version',
      );
    }
  }

  /** Start `<node> <cli.js> daemon` detached, its output appended to `daemon.log`. */
  private launch(): Launch {
    const { cliPath, execPath, paths } = this.deps;
    let failure: Error | undefined;
    let exited = false;
    try {
      // The state directory first: a fresh cache has no daemons/<key>/ to put the log in.
      this.deps.mkdirp(paths.stateDir);
      const log = this.deps.openLog(paths.logFile);
      try {
        const child = this.deps.spawn(execPath, [cliPath, 'daemon'], {
          detached: true,
          stdio: ['ignore', log, log],
          windowsHide: true,
          cwd: this.deps.cwd,
        });
        child.once('error', (error) => {
          failure = error;
        });
        child.once('exit', () => {
          exited = true;
        });
        child.unref();
      } finally {
        this.deps.closeFd(log);
      }
    } catch (error) {
      throw new DaemonUnavailableError(`could not start the daemon: ${messageOf(error)}`);
    }
    return { failure: () => failure, exited: () => exited };
  }

  /**
   * Poll until the socket answers. A started daemon that exits while nothing
   * listens is spawned again, at most `MAX_RESPAWNS` times within the budget:
   * a race loser exits too, but by then its winner usually listens, so the
   * connect below succeeds before a respawn is considered.
   */
  private async poll(first: Launch, signal: AbortSignal): Promise<Duplex> {
    const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const budget = this.deps.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    let current = first;
    let respawns = 0;
    for (let waited = 0; waited <= budget; waited += interval) {
      await this.sleep(interval, signal);
      const failed = current.failure();
      if (failed) {
        throw new DaemonUnavailableError(`could not start the daemon: ${failed.message}`);
      }
      try {
        return await this.connectOnce(signal);
      } catch (error) {
        if (signal.aborted) throw closedWhileConnecting();
        if (!isNotListening(error)) {
          throw error instanceof DaemonUnavailableError
            ? error
            : new DaemonUnavailableError(`cannot reach the daemon: ${messageOf(error)}`);
        }
      }
      if (current.exited() && respawns < MAX_RESPAWNS) {
        respawns += 1;
        this.checkSpawnable();
        current = this.launch();
      }
    }
    throw new DaemonUnavailableError(
      `the daemon did not answer within ${budget} ms (see ${this.deps.paths.logFile})`,
    );
  }

  /** One poll interval; an abort clears the timer and rejects at once. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.timers.clearTimeout(timer);
        reject(closedWhileConnecting());
      };
      const timer = this.timers.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private attach(socket: Duplex): void {
    this.socket = socket;
    this.connections += 1;
    this.refWhilePending(socket);
    const buffer = new ReadBuffer();
    socket.on('data', (data: Buffer) => {
      let chunk: Buffer | undefined = data;
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          // `append` throws once a line outgrows the SDK's buffer cap (>= 1.30).
          if (chunk) buffer.append(chunk);
          chunk = undefined;
          message = buffer.readMessage();
        } catch (error) {
          // Not our daemon's framing: nothing more on this socket can be trusted.
          drop(error);
          return;
        }
        if (!message) return;
        this.settle(socket, message);
      }
    });
    const drop = (cause?: unknown): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.dropSocket = undefined;
      const reason = cause instanceof Error ? `: ${cause.message}` : '';
      for (const [id, entry] of this.pending) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new DaemonConnectionError(`daemon connection closed during ${entry.method}${reason}`, {
            cause,
          }),
        );
      }
      socket.destroy();
    };
    this.dropSocket = () => drop();
    // The daemon ends a socket when it stops; a request written after that is
    // never answered, so the end of input already counts as the close.
    socket.on('end', () => drop());
    socket.on('close', () => drop());
    socket.on('error', (error: Error) => drop(error));
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
      const { code: wireCode, ...extra } = (message.error.data ?? {}) as { code?: unknown };
      const code = typeof wireCode === 'string' ? (wireCode as DaemonErrorCode) : 'INTERNAL';
      // Everything beside `code` (a `CORPUS_NOT_READY` carries the status) reaches the caller.
      const data = Object.keys(extra).length > 0 ? extra : undefined;
      entry.reject(new DaemonRpcError(code, message.error.message, data));
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
