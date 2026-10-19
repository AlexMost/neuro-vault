import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { ServiceRegistry } from '../../src/daemon/protocol.js';
import {
  createVaultEntryServices,
  type VaultEntriesPorts,
} from '../../src/daemon/services/vault-entry-services.js';
import { testCtx } from './_ctx.js';

function fakeEntries() {
  return {
    attach: vi.fn(async (_id: number, vault: string, profiles: readonly string[]) => ({
      vault,
      profiles: Object.fromEntries(
        profiles.map((p) => [p, { state: 'indexing' as const, indexed: 0, total: 0 }]),
      ),
    })),
    status: vi.fn(() => ({ state: 'ready' as const })),
    detach: vi.fn(),
    reader: vi.fn(),
    lexical: vi.fn(),
    graph: vi.fn(),
  } as unknown as VaultEntriesPorts & { attach: ReturnType<typeof vi.fn> };
}

describe('createVaultEntryServices', () => {
  it('builds the vault, corpus, lexical and graph services', () => {
    expect(Object.keys(createVaultEntryServices(fakeEntries()))).toEqual([
      'vault',
      'corpus',
      'lexical',
      'graph',
    ]);
  });

  it('a ServiceRegistry built from the map reaches the entries', async () => {
    const entries = fakeEntries();
    const registry = new ServiceRegistry();
    for (const [name, handlers] of Object.entries(createVaultEntryServices(entries))) {
      registry.register(name, handlers);
    }
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'vault.attach',
      params: { vault: '/v', profiles: [] },
    };
    const response = await registry.dispatch(request, testCtx(7));
    expect(entries.attach).toHaveBeenCalledWith(7, '/v', []);
    expect(isJSONRPCResultResponse(response)).toBe(true);
  });
});
