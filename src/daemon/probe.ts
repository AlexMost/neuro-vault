import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export type ProbeResult = 'listening' | 'refused' | 'absent';
export type SocketConnect = (path: string) => Promise<Duplex>;

export const defaultConnect: SocketConnect = (path) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      // Callers attach their own error handling once connected.
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });

/** Only a refused connect proves no one is listening; everything else is ambiguous. */
function classify(error: unknown): ProbeResult {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOENT') return 'absent';
  return 'listening';
}

/**
 * Is something listening? Only ECONNREFUSED (`refused`) and ENOENT (`absent`)
 * are definite. Every other failure, a missing error code, a null rejection,
 * a synchronous throw, and a connect that neither succeeds nor fails within
 * the timeout all count as listening: an ambiguous answer must never lead to
 * a live socket being unlinked (the SvelteKit size-0 bug, in our terms).
 *
 * A connect that settles after the timeout is still destroyed on success, so
 * a late socket never leaks.
 */
export async function probeSocket(
  path: string,
  deps: { connect: SocketConnect; timeoutMs?: number; timers?: Timers },
): Promise<ProbeResult> {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const timeoutMs = deps.timeoutMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = timers.setTimeout(() => resolve('listening'), timeoutMs);
  });
  // Starting the attempt inside a promise chain turns a synchronous throw from
  // `connect` into a rejection, so it is classified like any other failure.
  const attempt = Promise.resolve()
    .then(() => deps.connect(path))
    .then(
      (socket) => {
        socket.destroy();
        return 'listening' as const;
      },
      (error: unknown) => classify(error),
    );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

/**
 * Unlinks only after a `refused` probe: the socket file exists and nothing
 * answers. `absent` has no file to remove, and `listening` (including any
 * ambiguous failure) must never be unlinked. The caller holds the lock.
 */
export async function cleanStaleSocket(
  path: string,
  deps: {
    connect: SocketConnect;
    unlink: (p: string) => void;
    platform: NodeJS.Platform;
    timers?: Timers;
  },
): Promise<'cleaned' | 'listening' | 'nothing'> {
  if (deps.platform === 'win32') return 'nothing';
  const result = await probeSocket(path, { connect: deps.connect, timers: deps.timers });
  if (result === 'listening') return 'listening';
  if (result === 'absent') return 'nothing';
  deps.unlink(path);
  return 'cleaned';
}
