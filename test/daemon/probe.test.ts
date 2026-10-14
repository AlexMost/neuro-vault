import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanStaleSocket, defaultConnect, probeSocket } from '../../src/daemon/probe.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('probeSocket', () => {
  it('reports listening when connect succeeds and closes the socket', async () => {
    const sock = new PassThrough();
    const destroy = vi.spyOn(sock, 'destroy');
    await expect(probeSocket('/s.sock', { connect: async () => sock })).resolves.toBe('listening');
    expect(destroy).toHaveBeenCalled();
  });

  it('maps ECONNREFUSED to refused and ENOENT to absent', async () => {
    await expect(
      probeSocket('/s.sock', {
        connect: async () => {
          throw errno('ECONNREFUSED');
        },
      }),
    ).resolves.toBe('refused');
    await expect(
      probeSocket('/s.sock', {
        connect: async () => {
          throw errno('ENOENT');
        },
      }),
    ).resolves.toBe('absent');
  });

  it('treats a hang as listening — never delete on ambiguity', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeSocket('/s.sock', {
        connect: () => new Promise(() => {}),
        timeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toBe('listening');
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a socket that connects after the probe already answered listening', async () => {
    const late = new PassThrough();
    const destroy = vi.spyOn(late, 'destroy');
    const hold: { resolve?: (s: Duplex) => void } = {};
    const connect = () =>
      new Promise<Duplex>((resolve) => {
        hold.resolve = resolve;
      });

    await expect(probeSocket('/s.sock', { connect, timeoutMs: 1 })).resolves.toBe('listening');
    expect(destroy).not.toHaveBeenCalled();

    hold.resolve?.(late);
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroy).toHaveBeenCalled();
  });
});

describe('cleanStaleSocket', () => {
  it('unlinks a refused socket file', async () => {
    const unlink = vi.fn();
    await expect(
      cleanStaleSocket('/s.sock', {
        connect: async () => {
          throw errno('ECONNREFUSED');
        },
        unlink,
        platform: 'darwin',
      }),
    ).resolves.toBe('cleaned');
    expect(unlink).toHaveBeenCalledWith('/s.sock');
  });

  it('leaves a listening socket alone', async () => {
    const unlink = vi.fn();
    await expect(
      cleanStaleSocket('/s.sock', {
        connect: async () => new PassThrough(),
        unlink,
        platform: 'linux',
      }),
    ).resolves.toBe('listening');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('does nothing on Windows (pipes leave no file)', async () => {
    const connect = vi.fn();
    await expect(
      cleanStaleSocket('\\\\.\\pipe\\x', { connect, unlink: vi.fn(), platform: 'win32' }),
    ).resolves.toBe('nothing');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('defaultConnect against a real unix socket', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reports listening for a live server and absent once closed and unlinked', async () => {
    dir = fs.mkdtempSync('/tmp/nv-probe-');
    const sockPath = path.join(dir, 's.sock');
    const server = net.createServer();
    try {
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));
      await expect(probeSocket(sockPath, { connect: defaultConnect })).resolves.toBe('listening');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(sockPath, { force: true });
    await expect(probeSocket(sockPath, { connect: defaultConnect })).resolves.toBe('absent');
  });
});
