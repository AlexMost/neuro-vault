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
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

/**
 * Is something listening? A connect that neither succeeds nor fails within
 * the timeout counts as listening: an ambiguous answer must never lead to a
 * live socket being unlinked (the SvelteKit size-0 bug, in our terms).
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
  const attempt = deps.connect(path).then(
    (socket) => {
      socket.destroy();
      return 'listening' as const;
    },
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? ('absent' as const) : ('refused' as const);
    },
  );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

/** Only ever unlinks after a `refused`/`absent` probe; the caller holds the lock. */
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
  deps.unlink(path);
  return 'cleaned';
}
