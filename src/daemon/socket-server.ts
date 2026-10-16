import net from 'node:net';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { Timers } from './probe.js';
import { errorResponse, type ConnectionContext, type ServiceRegistry } from './protocol.js';

export interface DaemonServerOptions {
  socketPath: string;
  registry: ServiceRegistry;
  /** 0 = never idle out. */
  idleTimeoutMs: number;
  onIdle: () => void;
  timers?: Timers;
  /** A server-level error after listening; the default drops it rather than crash the process. */
  onError?: (error: Error) => void;
  /** One diagnostic line, without a newline (a throwing `onClose` callback); default: dropped. */
  log?: (line: string) => void;
  /**
   * Runs `fn` one I/O turn later (default `setImmediate`). `close()` ends its
   * connections through it, so lines already received are still answered.
   */
  defer?: (fn: () => void) => void;
}

export interface DaemonServerHandle {
  clients(): number;
  close(): Promise<void>;
}

interface InFlight {
  socket: net.Socket;
  id: Parameters<typeof errorResponse>[0];
  answered: boolean;
}

/**
 * One `ReadBuffer` per connection, one response per request, in whatever
 * order the handlers finish. A connection that sends a line the SDK cannot
 * parse as JSON-RPC is destroyed — its problem, nobody else's. Notifications
 * and responses a client sends are ignored: the daemon only serves requests.
 *
 * A connection becomes a *client* with its first request outside the
 * `daemon.` namespace; `clients()` counts clients only, so `daemon status`
 * and `daemon stop` are not clients of the daemon they inspect. The idle timer
 * is armed once listening succeeds (no client yet counts as idle), disarmed
 * when the first client arrives, and re-armed when the last one closes. A
 * connection that never becomes a client never touches it.
 */
export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const defer = opts.defer ?? ((fn: () => void): void => void setImmediate(fn));
  const log = opts.log ?? (() => undefined);
  let nextConnectionId = 1;
  const connections = new Set<net.Socket>();
  const clients = new Set<net.Socket>();
  const inFlight = new Set<InFlight>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let closing: Promise<void> | undefined;
  // Resolves once every connection's `close` handler (and its `onClose` callbacks) has run;
  // `server.close` alone can report drained a turn earlier.
  let allGone!: () => void;
  const drained = new Promise<void>((resolve) => {
    allGone = resolve;
  });

  const write = (socket: net.Socket, message: JSONRPCMessage): void => {
    if (!socket.destroyed) socket.write(serializeMessage(message));
  };

  const disarmIdle = (): void => {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = (): void => {
    disarmIdle();
    if (opts.idleTimeoutMs <= 0 || shuttingDown) return;
    idleTimer = timers.setTimeout(() => {
      // A client that arrived in the same loop turn as the timer wins the race.
      if (clients.size === 0) opts.onIdle();
    }, opts.idleTimeoutMs);
  };

  const promote = (socket: net.Socket): void => {
    if (clients.has(socket)) return;
    clients.add(socket);
    if (clients.size === 1) disarmIdle();
  };

  const server = net.createServer((socket) => {
    connections.add(socket);
    let socketClosed = false;
    const closeCallbacks: Array<() => void> = [];
    // One throwing callback must not skip the rest, so each is guarded.
    const runGuarded = (fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        log(`onClose callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const ctx: ConnectionContext = {
      id: nextConnectionId++,
      onClose: (fn) => {
        if (socketClosed) runGuarded(fn);
        else closeCallbacks.push(fn);
      },
    };
    const buffer = new ReadBuffer();
    socket.on('data', (data: Buffer) => {
      let chunk: Buffer | undefined = data;
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          // `append` throws once a line outgrows the SDK's buffer cap (>= 1.30),
          // which is as unusable as a malformed line.
          if (chunk) buffer.append(chunk);
          chunk = undefined;
          message = buffer.readMessage();
        } catch {
          socket.destroy();
          return;
        }
        if (!message) return;
        if (!isJSONRPCRequest(message)) continue;
        if (shuttingDown) {
          write(socket, errorResponse(message.id, 'SHUTTING_DOWN', 'daemon is stopping'));
          continue;
        }
        if (!message.method.startsWith('daemon.')) promote(socket);
        const entry: InFlight = { socket, id: message.id, answered: false };
        inFlight.add(entry);
        void opts.registry.dispatch(message, ctx).then((response) => {
          inFlight.delete(entry);
          if (!entry.answered) write(socket, response);
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      if (clients.delete(socket) && clients.size === 0) armIdle();
      socketClosed = true;
      for (const fn of closeCallbacks.splice(0)) runGuarded(fn);
      if (shuttingDown && connections.size === 0) allGone();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => opts.onError?.(error));
  armIdle();

  return {
    clients: () => clients.size,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        shuttingDown = true;
        disarmIdle();
        // `server.close` stops accepting at once and unlinks the socket file
        // once every connection is gone.
        server.close(() => void drained.then(resolve));
        if (connections.size === 0) allGone();
        for (const entry of inFlight) {
          entry.answered = true;
          write(entry.socket, errorResponse(entry.id, 'SHUTTING_DOWN', 'daemon is stopping'));
        }
        // Ending is deferred one I/O turn: a request already received on a
        // connection is answered SHUTTING_DOWN (not dropped on an ended
        // socket) first. Each socket is destroyed only after its write side
        // has finished, so those answers are flushed.
        defer(() => {
          for (const socket of connections) {
            if (!socket.destroyed) socket.end(() => socket.destroy());
          }
        });
      });
      return closing;
    },
  };
}
