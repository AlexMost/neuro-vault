import { describe, expect, it, vi } from 'vitest';

import { daemonPaths } from '../../src/daemon/paths.js';
import { DaemonEmbeddingProvider } from '../../src/modules/semantic/daemon-embedding-provider.js';
import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';
import type { LocalModelLoader } from '../../src/modules/semantic/local-model-loader.js';
import {
  DEFAULT_MODEL_KEY,
  identityOf,
  resolveModelProfile,
} from '../../src/modules/semantic/model-profiles.js';
import { createEmbeddingProvider } from '../../src/modules/semantic/provider-factory.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('createEmbeddingProvider', () => {
  const profile = resolveModelProfile(DEFAULT_MODEL_KEY);

  it('returns the in-process provider when not shared', () => {
    // Construction loads nothing: the default loader is only a closure until initialize().
    const provider = createEmbeddingProvider({ profile, shared: false });
    expect(provider).toBeInstanceOf(EmbeddingService);
    expect(provider.identity.model_key).toBe(profile.key);
  });

  it('passes an injected loader through to the in-process provider', async () => {
    const loadFailure = new Error('fake loader reached');
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(loadFailure);
    const provider = createEmbeddingProvider({ profile, shared: false, loader });

    await expect(provider.initialize()).rejects.toBe(loadFailure);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(profile);
  });

  it('returns the daemon facade when shared, with the in-process identity, touching nothing yet', () => {
    const build = vi.fn(() => ({ size: 10, mtimeMs: 20 }));
    const io = { connect: vi.fn(), spawn: vi.fn(), ensureSocketDir: vi.fn() };
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      build,
      io,
    });
    expect(provider).toBeInstanceOf(DaemonEmbeddingProvider);
    expect(provider.identity).toEqual(identityOf(profile));
    expect(build).toHaveBeenCalledWith('/opt/nv/dist/cli.js');
    expect(io.connect).not.toHaveBeenCalled();
    expect(io.ensureSocketDir).not.toHaveBeenCalled();
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it('wires the build-keyed paths, the uid and the CLI into the connection', async () => {
    const lines: string[] = [];
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(new Error('local load reached'));
    const io = {
      execPath: '/usr/bin/node',
      ensureSocketDir: vi.fn(),
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      spawn: vi.fn(() => ({ unref: vi.fn(), once: vi.fn() })),
      openLog: vi.fn(() => 9),
      closeFd: vi.fn(),
      mkdirp: vi.fn(),
      pollIntervalMs: 1,
      pollTimeoutMs: 3,
    };
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      version: '18.0.0',
      env: { XDG_CACHE_HOME: '/xdg' },
      home: '/home/u',
      uid: 501,
      platform: 'darwin',
      stderr: { write: (s) => (lines.push(s), true) },
      loader,
      build: () => ({ size: 10, mtimeMs: 20 }),
      io,
    });
    const expected = daemonPaths({
      version: '18.0.0',
      build: { size: 10, mtimeMs: 20 },
      uid: 501,
      platform: 'darwin',
      cacheBase: '/xdg/neuro-vault',
    });

    // The poll runs out, so the call lands on the in-process provider (the loader).
    await expect(provider.initialize()).rejects.toThrow('local load reached');
    expect(io.ensureSocketDir).toHaveBeenCalledWith('/tmp/neuro-vault-501');
    expect(io.connect).toHaveBeenCalledWith(expected.socketPath);
    expect(io.mkdirp).toHaveBeenCalledWith(expected.stateDir);
    expect(io.openLog).toHaveBeenCalledWith(expected.logFile);
    expect(io.spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/opt/nv/dist/cli.js', 'daemon'],
      expect.objectContaining({ detached: true, stdio: ['ignore', 9, 9] }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(expected.logFile);
    expect(loader).toHaveBeenCalledWith(profile);
  });

  it('falls back with one line when the socket directory is not ours', async () => {
    const lines: string[] = [];
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(new Error('local load reached'));
    const io = {
      ensureSocketDir: vi.fn(() => {
        throw new Error('socket directory /tmp/neuro-vault-501 is owned by uid 0, not 501');
      }),
      connect: vi.fn(),
      spawn: vi.fn(),
    };
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      uid: 501,
      platform: 'linux',
      stderr: { write: (s) => (lines.push(s), true) },
      loader,
      build: () => ({ size: 10, mtimeMs: 20 }),
      io,
    });
    await expect(provider.initialize()).rejects.toThrow('local load reached');
    expect(io.connect).not.toHaveBeenCalled();
    expect(io.spawn).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/owned by uid 0/);
  });

  it('falls back, never throwing the log error, when daemon.log cannot be opened', async () => {
    const lines: string[] = [];
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(new Error('local load reached'));
    const io = {
      ensureSocketDir: vi.fn(),
      connect: vi.fn(async () => {
        throw errno('ENOENT');
      }),
      spawn: vi.fn(),
      openLog: vi.fn(() => {
        throw errno('EROFS');
      }),
      mkdirp: vi.fn(),
    };
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      platform: 'linux',
      stderr: { write: (s) => (lines.push(s), true) },
      loader,
      build: () => ({ size: 10, mtimeMs: 20 }),
      io,
    });
    // The query reaches the in-process provider (its loader), not the EROFS.
    await expect(provider.embedQuery('x')).rejects.toThrow('local load reached');
    expect(io.spawn).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/could not start the daemon: EROFS/);
  });

  it('falls back with one line when the CLI script cannot be identified', async () => {
    const lines: string[] = [];
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(new Error('local load reached'));
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      cliPath: '/gone/cli.js',
      stderr: { write: (s) => (lines.push(s), true) },
      loader,
      build: () => {
        throw errno('ENOENT');
      },
    });
    await expect(provider.initialize()).rejects.toThrow('local load reached');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/cannot identify the CLI script at \/gone\/cli\.js/);
  });

  it('falls back with one line when there is no CLI path at all', async () => {
    const lines: string[] = [];
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(new Error('local load reached'));
    const provider = createEmbeddingProvider({
      profile,
      shared: true,
      stderr: { write: (s) => (lines.push(s), true) },
      loader,
    });
    await expect(provider.initialize()).rejects.toThrow('local load reached');
    expect(lines).toHaveLength(1);
  });
});
