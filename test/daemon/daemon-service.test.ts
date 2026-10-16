import { describe, expect, it, vi } from 'vitest';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import type { IVaultInfo } from '../../src/lib/vault-entry/index.js';
import { testCtx } from './_ctx.js';

// A factory, not a shared object: `requestShutdown` call counts must not leak between tests.
function makeDeps() {
  return {
    name: 'neuro-vault-mcp',
    version: '18.0.0',
    pid: 42,
    startedAt: '2026-10-14T10:00:00.000Z',
    idleTimeoutMin: 30,
    clients: vi.fn(() => 2),
    embedLoaded: vi.fn((): string[] => ['granite-97m']),
    vaultInfo: vi.fn((): IVaultInfo[] => []),
    requestShutdown: vi.fn(),
  };
}

describe('daemon service', () => {
  it('info reports identity, clients and services', async () => {
    const deps = makeDeps();
    const handlers = createDaemonService(deps);
    await expect(handlers.info(undefined, testCtx())).resolves.toEqual({
      name: 'neuro-vault-mcp',
      version: '18.0.0',
      pid: 42,
      started_at: deps.startedAt,
      idle_timeout_min: 30,
      clients: 2,
      services: { embed: { loaded: ['granite-97m'] }, vault: [] },
    });
  });

  it('info reads clients() and embedLoaded() at call time, not at construction', async () => {
    const deps = makeDeps();
    const handlers = createDaemonService(deps);

    deps.clients.mockReturnValue(1);
    deps.embedLoaded.mockReturnValue([]);
    await expect(handlers.info(undefined, testCtx())).resolves.toMatchObject({
      clients: 1,
      services: { embed: { loaded: [] } },
    });

    deps.clients.mockReturnValue(3);
    deps.embedLoaded.mockReturnValue(['granite-97m', 'harrier-270m']);
    await expect(handlers.info(undefined, testCtx())).resolves.toMatchObject({
      clients: 3,
      services: { embed: { loaded: ['granite-97m', 'harrier-270m'] } },
    });
    expect(deps.clients).toHaveBeenCalledTimes(2);
    expect(deps.embedLoaded).toHaveBeenCalledTimes(2);
  });

  it('info lists vault entries, read at call time', async () => {
    const deps = makeDeps();
    const handlers = createDaemonService(deps);
    const notes: IVaultInfo = {
      vault: '/vaults/notes',
      clients: 2,
      profiles: [{ profile: 'harrier-270m', state: 'ready', notes: 955 }],
    };
    deps.vaultInfo.mockReturnValue([notes]);
    await expect(handlers.info(undefined, testCtx())).resolves.toMatchObject({
      services: { vault: [notes] },
    });
    deps.vaultInfo.mockReturnValue([]);
    await expect(handlers.info(undefined, testCtx())).resolves.toMatchObject({
      services: { vault: [] },
    });
    expect(deps.vaultInfo).toHaveBeenCalledTimes(2);
  });

  it('shutdown answers then asks the server to stop', async () => {
    const deps = makeDeps();
    const handlers = createDaemonService(deps);
    await expect(handlers.shutdown(undefined, testCtx())).resolves.toEqual({});
    expect(deps.requestShutdown).toHaveBeenCalledTimes(1);
  });
});
