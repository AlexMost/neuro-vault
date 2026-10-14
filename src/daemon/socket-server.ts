import net from 'node:net';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { Timers } from './probe.js';
import { errorResponse, type ServiceRegistry } from './protocol.js';

export interface DaemonServerOptions {
  socketPath: string;
  registry: ServiceRegistry;
  /** 0 = never idle out. */
  idleTimeoutMs: number;
  onIdle: () => void;
  timers?: Timers;
  /** A server-level error after listening; the default drops it rather than crash the process. */
  onError?: (error: Error) => void;
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
 * The idle timer is armed once listening succeeds (no connection yet counts
 * as idle), disarmed by each new connection, and re-armed when the last one
 * closes.
 */
export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const connections = new Set<net.Socket>();
  const inFlight = new Set<InFlight>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let closing: Promise<void> | undefined;

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
    idleTimer = timers.setTimeout(() => opts.onIdle(), opts.idleTimeoutMs);
  };

  const server = net.createServer((socket) => {
    disarmIdle();
    connections.add(socket);
    const buffer = new ReadBuffer();
    socket.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
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
        const entry: InFlight = { socket, id: message.id, answered: false };
        inFlight.add(entry);
        void opts.registry.dispatch(message).then((response) => {
          inFlight.delete(entry);
          if (!entry.answered) write(socket, response);
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      if (connections.size === 0) armIdle();
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
    clients: () => connections.size,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        shuttingDown = true;
        disarmIdle();
        for (const entry of inFlight) {
          entry.answered = true;
          write(entry.socket, errorResponse(entry.id, 'SHUTTING_DOWN', 'daemon is stopping'));
        }
        // `server.close` stops accepting at once and unlinks the socket file
        // once every connection is gone. Each socket is ended (flushing the
        // answer above) and destroyed only after its write side has finished.
        server.close(() => resolve());
        for (const socket of connections) {
          if (socket.destroyed) continue;
          socket.end(() => socket.destroy());
        }
      });
      return closing;
    },
  };
}
