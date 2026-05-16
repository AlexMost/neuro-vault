import { describe, expect, it, vi } from 'vitest';

import { buildListTagsTool } from '../../../src/modules/operations/tools/list-tags.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
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

  it('returns failed_vaults when one vault provider rejects', async () => {
    const providerA = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'mcp', count: 5 }]),
    });
    const providerB = makeProvider({
      listTags: vi
        .fn()
        .mockRejectedValue(new ToolHandlerError('CLI_NOT_FOUND', 'obsidian not on PATH')),
    });
    const registry = makeTestRegistry([
      { name: 'a', provider: providerA },
      { name: 'b', provider: providerB },
    ]);
    const tool = buildListTagsTool({ registry });

    const result = (await tool.handler({})) as {
      results_by_vault: Array<{ vault: string; results: Array<{ name: string; count: number }> }>;
      failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    };

    expect(result.results_by_vault).toEqual([{ vault: 'a', results: [{ name: 'mcp', count: 5 }] }]);
    expect(result.failed_vaults).toEqual([
      {
        vault: 'b',
        error: { code: 'CLI_NOT_FOUND', message: 'obsidian not on PATH' },
      },
    ]);
    expect(result.skipped_vaults).toEqual([]);
  });
});
