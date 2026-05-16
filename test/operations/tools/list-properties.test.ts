import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.listProperties handler', () => {
  it('forwards to provider and wraps result with vault', async () => {
    const provider = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 5 }]),
    });
    const registry = makeTestRegistry([{ name: 'v', provider }]);
    const tool = buildListPropertiesTool({ registry });
    expect(await tool.handler({})).toEqual({
      vault: 'v',
      results: [{ name: 'status', count: 5 }],
    });
    expect(provider.listProperties).toHaveBeenCalled();
  });

  it('routes to the named vault in multi-vault mode when vault is provided', async () => {
    const providerA = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'pA', count: 1 }]),
    });
    const providerB = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'pB', count: 2 }]),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListPropertiesTool({ registry });

    expect(await tool.handler({ vault: 'a' })).toEqual({
      vault: 'a',
      results: [{ name: 'pA', count: 1 }],
    });
    expect(providerA.listProperties).toHaveBeenCalledTimes(1);
    expect(providerB.listProperties).not.toHaveBeenCalled();
  });

  it('fans out across all registered vaults when vault is omitted in multi-vault mode', async () => {
    const providerA = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'pA', count: 1 }]),
    });
    const providerB = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'pB', count: 2 }]),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListPropertiesTool({ registry });

    const result = await tool.handler({});
    expect(result).toEqual({
      results_by_vault: [
        { vault: 'a', results: [{ name: 'pA', count: 1 }] },
        { vault: 'b', results: [{ name: 'pB', count: 2 }] },
      ],
      skipped_vaults: [],
    });
    expect(providerA.listProperties).toHaveBeenCalledTimes(1);
    expect(providerB.listProperties).toHaveBeenCalledTimes(1);
  });
});
