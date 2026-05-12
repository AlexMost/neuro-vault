import { describe, expect, it, vi } from 'vitest';

import { buildGetVaultOverviewTool } from '../../../src/modules/operations/tools/get-vault-overview.js';
import { makeGraph, makeReader } from './_helpers.js';

describe('operations.getVaultOverview tool', () => {
  it('declares the expected name, title, and empty input schema', () => {
    const tool = buildGetVaultOverviewTool({
      reader: makeReader(),
      graph: makeGraph(),
    });
    expect(tool.name).toBe('get_vault_overview');
    expect(tool.title).toBe('Get Vault Overview');
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });

  it('computes the overview through computeVaultOverview', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'Notes/a.md', frontmatter: { tags: ['x'] }, content: '' }]),
    });
    const graph = makeGraph();
    const tool = buildGetVaultOverviewTool({ reader, graph });

    const result = await tool.handler({});

    expect(result.total_notes).toBe(1);
    expect(result.top_tags).toEqual([{ name: 'x', count: 1 }]);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });
});
