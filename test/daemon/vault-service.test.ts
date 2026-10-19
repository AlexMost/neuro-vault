import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { ServiceRegistry, type IConnectionContext } from '../../src/daemon/protocol.js';
import { createVaultService } from '../../src/daemon/services/vault.js';
import { VaultEntryError } from '../../src/lib/vault-entry/index.js';

/** The slice of `VaultEntries` the service touches. */
function fakeEntries() {
  return {
    attach: vi.fn(async (_id: number, vault: string, profiles: readonly string[]) => ({
      vault: `/real${vault}`,
      profiles: Object.fromEntries(
        profiles.map((p) => [p, { state: 'indexing' as const, indexed: 0, total: 0 }]),
      ),
    })),
    status: vi.fn((_id: number, _vault: string, _profile: string) => ({ state: 'ready' as const })),
    detach: vi.fn((_id: number) => undefined),
  };
}

/** A connection whose `onClose` callbacks are kept and run by `close()`, like the socket server's. */
function connection(id = 1) {
  const callbacks: Array<() => void> = [];
  const ctx: IConnectionContext = { id, onClose: (fn) => void callbacks.push(fn) };
  return { ctx, registered: () => callbacks.length, close: () => callbacks.forEach((fn) => fn()) };
}

function setup() {
  const entries = fakeEntries();
  const registry = new ServiceRegistry();
  registry.register('vault', createVaultService(entries));
  let next = 1;
  const call = (ctx: IConnectionContext, method: string, params?: unknown) => {
    const request: JSONRPCRequest = { jsonrpc: '2.0', id: next++, method, params: params as never };
    return registry.dispatch(request, ctx);
  };
  return { entries, call };
}

function errorOf(response: JSONRPCMessage): { code: string; message: string } {
  if (!isJSONRPCErrorResponse(response)) throw new Error('expected an error response');
  return { code: (response.error.data as { code: string }).code, message: response.error.message };
}

describe('vault service', () => {
  it('attach answers the entries result for the connection', async () => {
    const { entries, call } = setup();
    const conn = connection(7);
    const response = await call(conn.ctx, 'vault.attach', {
      vault: '/vaults/notes',
      profiles: ['harrier-270m'],
    });
    expect(entries.attach).toHaveBeenCalledWith(7, '/vaults/notes', ['harrier-270m']);
    expect(isJSONRPCResultResponse(response) && response.result).toEqual({
      vault: '/real/vaults/notes',
      profiles: { 'harrier-270m': { state: 'indexing', indexed: 0, total: 0 } },
    });
  });

  it('attach accepts an empty profile list', async () => {
    const { entries, call } = setup();
    await call(connection().ctx, 'vault.attach', { vault: '/v', profiles: [] });
    expect(entries.attach).toHaveBeenCalledWith(1, '/v', []);
  });

  it('status answers the profile state', async () => {
    const { entries, call } = setup();
    const response = await call(connection(3).ctx, 'vault.status', {
      vault: '/real/v',
      profile: 'harrier-270m',
    });
    expect(entries.status).toHaveBeenCalledWith(3, '/real/v', 'harrier-270m');
    expect(isJSONRPCResultResponse(response) && response.result).toEqual({ state: 'ready' });
  });

  it.each(['NOT_ATTACHED', 'VAULT_UNAVAILABLE', 'UNKNOWN_PROFILE'] as const)(
    'maps a VaultEntryError %s to the same wire code and message',
    async (code) => {
      const { entries, call } = setup();
      entries.attach.mockRejectedValueOnce(new VaultEntryError(code, `${code} because`));
      entries.status.mockImplementationOnce(() => {
        throw new VaultEntryError(code, `${code} because`);
      });
      const attach = await call(connection().ctx, 'vault.attach', { vault: '/v', profiles: [] });
      const status = await call(connection().ctx, 'vault.status', { vault: '/v', profile: 'p' });
      expect(errorOf(attach)).toEqual({ code, message: `${code} because` });
      expect(errorOf(status)).toEqual({ code, message: `${code} because` });
    },
  );

  it('lets any other failure through as INTERNAL', async () => {
    const { entries, call } = setup();
    entries.attach.mockRejectedValueOnce(new Error('vault entries: disposed'));
    const response = await call(connection().ctx, 'vault.attach', { vault: '/v', profiles: [] });
    expect(errorOf(response)).toEqual({ code: 'INTERNAL', message: 'vault entries: disposed' });
  });

  it('offers no vault.detach', async () => {
    const { call } = setup();
    const response = await call(connection().ctx, 'vault.detach', { vault: '/v' });
    expect(errorOf(response).code).toBe('UNKNOWN_METHOD');
  });

  it('closing the connection detaches it', async () => {
    const { entries, call } = setup();
    const conn = connection(9);
    await call(conn.ctx, 'vault.attach', { vault: '/v', profiles: ['p'] });
    expect(entries.detach).not.toHaveBeenCalled();
    conn.close();
    expect(entries.detach).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('registers one close callback per connection, however often it attaches', async () => {
    const { entries, call } = setup();
    const conn = connection(4);
    await call(conn.ctx, 'vault.attach', { vault: '/a', profiles: ['p'] });
    await call(conn.ctx, 'vault.attach', { vault: '/b', profiles: [] });
    expect(conn.registered()).toBe(1);
    conn.close();
    expect(entries.detach).toHaveBeenCalledTimes(1);
  });

  it('registers again for a connection id that closed and came back', async () => {
    const { entries, call } = setup();
    const first = connection(5);
    await call(first.ctx, 'vault.attach', { vault: '/a', profiles: [] });
    first.close();
    const second = connection(5);
    await call(second.ctx, 'vault.attach', { vault: '/a', profiles: [] });
    expect(second.registered()).toBe(1);
    second.close();
    expect(entries.detach).toHaveBeenCalledTimes(2);
  });

  it('detaches a connection that closed while its attach was still pending', async () => {
    const { entries, call } = setup();
    const conn = connection(8);
    let resolveAttach!: (value: { vault: string; profiles: Record<string, never> }) => void;
    entries.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve;
        }) as never,
    );
    const pending = call(conn.ctx, 'vault.attach', { vault: '/v', profiles: [] });
    await Promise.resolve();
    conn.close();
    expect(entries.detach).toHaveBeenCalledExactlyOnceWith(8);
    resolveAttach({ vault: '/v', profiles: {} });
    await pending;
    // The entries' own in-flight bookkeeping handles the late join; nothing re-hooks the closed connection.
    expect(entries.detach).toHaveBeenCalledTimes(1);
  });

  it('registers the close callback even when the attach fails', async () => {
    // A failed attach can still have joined nothing, but a retry must not leak a second callback.
    const { entries, call } = setup();
    const conn = connection(6);
    entries.attach.mockRejectedValueOnce(new VaultEntryError('VAULT_UNAVAILABLE', 'gone'));
    await call(conn.ctx, 'vault.attach', { vault: '/a', profiles: [] });
    await call(conn.ctx, 'vault.attach', { vault: '/a', profiles: [] });
    expect(conn.registered()).toBe(1);
  });

  it('does not register a close callback for a rejected params attach', async () => {
    const { call } = setup();
    const conn = connection();
    await call(conn.ctx, 'vault.attach', { profiles: [] });
    expect(conn.registered()).toBe(0);
  });
});
