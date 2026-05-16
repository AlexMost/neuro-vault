import { describe, expect, it, vi } from 'vitest';

import { buildGetVaultOverviewTool } from '../../../src/modules/operations/tools/get-vault-overview.js';
import type { VaultOverview } from '../../../src/lib/obsidian/vault-overview.js';
import { makeGraph, makeProvider, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

type SingleOverview = { vault: string } & VaultOverview;

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

    const result = (await tool.handler({})) as SingleOverview;

    expect(result.vault).toBe('v');
    expect(result.total_notes).toBe(1);
    expect(result.top_tags).toEqual([{ name: 'x', count: 1 }]);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('fans out across two vaults when vault: is omitted in multi-vault mode', async () => {
    const readerA = makeReader({ scan: vi.fn().mockResolvedValue(['a.md']) });
    const readerB = makeReader({ scan: vi.fn().mockResolvedValue(['b.md', 'c.md']) });
    const providerA = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'alpha', count: 1 }]),
    });
    const providerB = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'beta', count: 2 }]),
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, provider: providerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, provider: providerB, graph: makeGraph() },
    ]);
    const tool = buildGetVaultOverviewTool({ registry });

    const result = (await tool.handler({})) as {
      results_by_vault: Array<SingleOverview>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    };

    expect(result.results_by_vault).toHaveLength(2);
    expect(result.skipped_vaults).toEqual([]);
    const byVault = new Map(result.results_by_vault.map((g) => [g.vault, g]));
    expect(byVault.has('vault-a')).toBe(true);
    expect(byVault.has('vault-b')).toBe(true);
    // Each group has overview fields
    expect(byVault.get('vault-a')!.total_notes).toBe(1);
    expect(byVault.get('vault-b')!.total_notes).toBe(2);
    expect(byVault.get('vault-a')!.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
    expect(byVault.get('vault-b')!.top_tags).toEqual([{ name: 'beta', count: 2 }]);
    // vault field is present and unique — no double-vault duplication
    expect(byVault.get('vault-a')!.vault).toBe('vault-a');
    expect(byVault.get('vault-b')!.vault).toBe('vault-b');
  });

  it('single-vault path still returns { vault, ...overview } flat shape (regression)', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['x.md', 'y.md']) });
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([{ name: 'tag1', count: 3 }]),
    });
    const registry = makeTestRegistry([{ name: 'solo', reader, provider, graph: makeGraph() }]);
    const tool = buildGetVaultOverviewTool({ registry });

    const result = (await tool.handler({})) as SingleOverview;

    // Must be flat shape (single vault => isMulti() === false)
    expect(result.vault).toBe('solo');
    expect(result.total_notes).toBe(2);
    expect((result as unknown as Record<string, unknown>).results_by_vault).toBeUndefined();
  });
});
