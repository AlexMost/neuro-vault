import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { daemonPaths } from '../../src/daemon/paths.js';
import { DaemonConnectionError } from '../../src/modules/semantic/daemon-connection.js';
import {
  createSharedServices,
  SharedServicesClosedError,
} from '../../src/modules/semantic/shared-services.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function socket(): Duplex {
  return new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
}

const baseOptions = {
  shared: true,
  cliPath: '/opt/nv/dist/cli.js',
  version: '18.0.0',
  env: { XDG_CACHE_HOME: '/xdg' },
  home: '/home/u',
  uid: 501,
  platform: 'linux' as const,
  build: () => ({ size: 10, mtimeMs: 20 }),
};

const expectedLog = daemonPaths({
  version: '18.0.0',
  build: { size: 10, mtimeMs: 20 },
  uid: 501,
  platform: 'linux',
  cacheBase: '/xdg/neuro-vault',
}).logFile;

describe('createSharedServices', () => {
  it('writes one stderr line when two facades both find the daemon unavailable', async () => {
    const lines: string[] = [];
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      spawn: vi.fn(() => {
        throw new Error('spawn denied');
      }),
      openLog: vi.fn(() => 9),
      closeFd: vi.fn(),
      mkdirp: vi.fn(),
    };
    const services = createSharedServices({
      ...baseOptions,
      stderr: { write: (s) => (lines.push(s), true) },
      io,
    });
    expect(services.mode).toBe('pending');

    const answers = await Promise.all([services.ensure(), services.ensure()]);
    expect(answers).toEqual(['local', 'local']);
    expect(services.mode).toBe('local');
    await expect(services.ensure()).resolves.toBe('local');

    expect(lines).toEqual([
      'neuro-vault-mcp: shared daemon unavailable (could not start the daemon: spawn denied); ' +
        `running in-process for this session — see ${expectedLog}\n`,
    ]);
    // The switch is one-way: the daemon is never touched again.
    expect(io.connect).toHaveBeenCalledTimes(1);
  });

  it('names no log when the CLI script path is unknown', async () => {
    const lines: string[] = [];
    const services = createSharedServices({
      shared: true,
      stderr: { write: (s) => (lines.push(s), true) },
    });
    await expect(services.ensure()).resolves.toBe('local');
    expect(lines).toEqual([
      'neuro-vault-mcp: shared daemon unavailable (no CLI script path to key it by); ' +
        'running in-process for this session\n',
    ]);
  });

  it('stays on the daemon after a connection error and reconnects on the next ensure', async () => {
    const lines: string[] = [];
    const first = socket();
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(socket()),
      spawn: vi.fn(),
    };
    const services = createSharedServices({
      ...baseOptions,
      stderr: { write: (s) => (lines.push(s), true) },
      io,
    });
    await expect(services.ensure()).resolves.toBe('daemon');
    expect(services.mode).toBe('daemon');

    const request = services.connection.request('embed.query', {}, 1000);
    first.destroy();
    await expect(request).rejects.toBeInstanceOf(DaemonConnectionError);

    await expect(services.ensure()).resolves.toBe('daemon');
    expect(services.mode).toBe('daemon');
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([]);
  });

  it('closes a connection that lands after another caller flipped the switch', async () => {
    const landed = socket();
    const io = {
      ensureSocketDir: vi.fn(),
      // The first establish finds no daemon and cannot start one; the second connects.
      connect: vi.fn().mockRejectedValueOnce(errno('ENOENT')).mockResolvedValue(landed),
      spawn: vi.fn(() => {
        throw new Error('spawn denied');
      }),
      openLog: vi.fn(() => 9),
      closeFd: vi.fn(),
      mkdirp: vi.fn(),
    };
    const services = createSharedServices({
      ...baseOptions,
      stderr: { write: () => true },
      io,
    });

    // This caller shares the first establish and, registered ahead of `ensure()`'s own
    // continuation, starts the second one before the first caller has flipped the switch.
    let second: Promise<'daemon' | 'local'> | undefined;
    const watcher = services.connection.ensure().catch(() => {
      second = services.ensure();
    });
    const first = services.ensure();

    await expect(first).resolves.toBe('local');
    await watcher;
    await expect(second).resolves.toBe('local');
    expect(services.mode).toBe('local');
    expect(io.connect).toHaveBeenCalledTimes(2);
    expect(landed.destroyed).toBe(true);
  });

  it('is local from the start, with no line and no connection, when not shared', async () => {
    const lines: string[] = [];
    const io = { connect: vi.fn(), spawn: vi.fn(), ensureSocketDir: vi.fn() };
    const services = createSharedServices({
      shared: false,
      cliPath: '/opt/nv/dist/cli.js',
      stderr: { write: (s) => (lines.push(s), true) },
      io,
    });
    expect(services.mode).toBe('local');
    await expect(services.ensure()).resolves.toBe('local');
    expect(lines).toEqual([]);
    expect(io.connect).not.toHaveBeenCalled();
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it('close() drops the connection', async () => {
    const s = socket();
    const services = createSharedServices({
      ...baseOptions,
      io: { ensureSocketDir: vi.fn(), connect: vi.fn(async () => s), spawn: vi.fn() },
    });
    await services.ensure();
    services.close();
    expect(s.destroyed).toBe(true);
  });

  it('ensure() after close() never connects again', async () => {
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn(async () => socket()),
      spawn: vi.fn(),
    };
    const services = createSharedServices({ ...baseOptions, io });
    await services.ensure();
    services.close();

    await expect(services.ensure()).rejects.toBeInstanceOf(SharedServicesClosedError);
    expect(io.connect).toHaveBeenCalledTimes(1);
  });

  it('a connect that lands after close() is dropped, not used', async () => {
    const s = socket();
    let land: (value: Duplex) => void = () => {};
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn(() => new Promise<Duplex>((resolve) => (land = resolve))),
      spawn: vi.fn(),
    };
    const services = createSharedServices({ ...baseOptions, io });
    const pending = services.ensure();
    await vi.waitFor(() => expect(io.connect).toHaveBeenCalled());

    services.close();
    land(s);

    await expect(pending).rejects.toBeInstanceOf(SharedServicesClosedError);
    expect(s.destroyed).toBe(true);
  });

  it('a daemon that cannot be started after close() writes no fallback line', async () => {
    const lines: string[] = [];
    let fail: (error: Error) => void = () => {};
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn(() => new Promise<Duplex>((_resolve, reject) => (fail = reject))),
      spawn: vi.fn(() => {
        throw new Error('spawn denied');
      }),
      openLog: vi.fn(() => 9),
      closeFd: vi.fn(),
      mkdirp: vi.fn(),
    };
    const services = createSharedServices({
      ...baseOptions,
      stderr: { write: (s) => (lines.push(s), true) },
      io,
    });
    const pending = services.ensure();
    await vi.waitFor(() => expect(io.connect).toHaveBeenCalled());

    services.close();
    fail(errno('ENOENT'));

    await expect(pending).rejects.toBeInstanceOf(SharedServicesClosedError);
    expect(services.mode).not.toBe('local');
    expect(lines).toEqual([]);
  });
});
