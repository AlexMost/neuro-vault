import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
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
      failed_vaults: [],
    });
    expect(providerA.listProperties).toHaveBeenCalledTimes(1);
    expect(providerB.listProperties).toHaveBeenCalledTimes(1);
  });

  it('returns failed_vaults when one vault provider rejects', async () => {
    const providerA = makeProvider({
      listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 10 }]),
    });
    const providerB = makeProvider({
      listProperties: vi
        .fn()
        .mockRejectedValue(new ToolHandlerError('CLI_NOT_FOUND', 'obsidian not on PATH')),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListPropertiesTool({ registry });

    const result = (await tool.handler({})) as {
      results_by_vault: Array<{ vault: string; results: Array<{ name: string; count: number }> }>;
      failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    };

    expect(result.results_by_vault).toEqual([
      { vault: 'a', results: [{ name: 'status', count: 10 }] },
    ]);
    expect(result.failed_vaults).toEqual([
      {
        vault: 'b',
        error: { code: 'CLI_NOT_FOUND', message: 'obsidian not on PATH' },
      },
    ]);
    expect(result.skipped_vaults).toEqual([]);
  });
});
