import { describe, expect, it, vi } from 'vitest';

import { buildGetVaultOverviewTool } from '../../../src/modules/operations/tools/get-vault-overview.js';
import { makeGraph, makeProvider, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.getVaultOverview tool', () => {
  it('declares the expected name, title, and empty input schema', () => {
    const registry = makeTestRegistry([
      { name: 'v', reader: makeReader(), provider: makeProvider(), graph: makeGraph() },
    ]);
    const tool = buildGetVaultOverviewTool({ registry });
    expect(tool.name).toBe('get_vault_overview');
    expect(tool.title).toBe('Get Vault Overview');
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });

  it('computes the overview through computeVaultOverview and includes vault field', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
    });
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'x', count: 1 }]),
    });
    const graph = makeGraph();
    const registry = makeTestRegistry([{ name: 'v', reader, provider, graph }]);
    const tool = buildGetVaultOverviewTool({ registry });

    const result = await tool.handler({});

    expect(result.vault).toBe('v');
    expect(result.total_notes).toBe(1);
    expect(result.top_tags).toEqual([{ name: 'x', count: 1 }]);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });
});
