import { describe, expect, it, vi } from 'vitest';

import { buildListTagsTool } from '../../../src/modules/operations/tools/list-tags.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.listTags handler', () => {
  it('forwards to provider and wraps result with vault', async () => {
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 3 }]),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildListTagsTool({ registry });
    expect(await tool.handler({})).toEqual({
      vault: 'v',
      results: [{ name: 'mcp', count: 3 }],
    });
    expect(provider.listTags).toHaveBeenCalled();
  });

  it('routes to the named vault in multi-vault mode when vault is provided', async () => {
    const providerA = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromA', count: 1 }]),
    });
    const providerB = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromB', count: 2 }]),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListTagsTool({ registry });

    expect(await tool.handler({ vault: 'b' })).toEqual({
      vault: 'b',
      results: [{ name: 'fromB', count: 2 }],
    });
    expect(providerA.listTags).not.toHaveBeenCalled();
    expect(providerB.listTags).toHaveBeenCalledTimes(1);
  });

  it('fans out across all registered vaults when vault is omitted in multi-vault mode', async () => {
    const providerA = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromA', count: 1 }]),
    });
    const providerB = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'fromB', count: 2 }]),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListTagsTool({ registry });

    const result = await tool.handler({});
    expect(result).toEqual({
      results_by_vault: [
        { vault: 'a', results: [{ name: 'fromA', count: 1 }] },
        { vault: 'b', results: [{ name: 'fromB', count: 2 }] },
      ],
      skipped_vaults: [],
      failed_vaults: [],
    });
    expect(providerA.listTags).toHaveBeenCalledTimes(1);
    expect(providerB.listTags).toHaveBeenCalledTimes(1);
  });
});
