import { describe, expect, it, vi } from 'vitest';

import { buildGetVaultOverviewTool } from '../../../src/modules/operations/tools/get-vault-overview.js';
import type { VaultOverview } from '../../../src/lib/obsidian/vault-overview.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { FAN_OUT_SUFFIX } from '../../../src/lib/vault-param.js';
import type { IVaultRegistry } from '../../../src/lib/vault-registry.js';
import { makeGraph, makeReader, readerOver } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

type SingleOverview = { vault: string } & VaultOverview;

function registryOf(...names: string[]): IVaultRegistry {
  return makeTestRegistry(
    names.map((name) => ({
      name,
      reader: makeReader(),
      graph: makeGraph(),
    })),
  );
}

describe('operations.getVaultOverview tool', () => {
  it('declares the expected name, title, and empty input schema', () => {
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), graph: makeGraph() }]);
    const tool = buildGetVaultOverviewTool({ registry });
    expect(tool.name).toBe('get_vault_overview');
    expect(tool.title).toBe('Get Vault Overview');
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });

  it('computes the overview through computeVaultOverview and includes vault field', async () => {
    const reader = readerOver({ 'Notes/a.md': { frontmatter: { tags: ['x'] } } });
    const graph = makeGraph();
    const registry = makeTestRegistry([{ name: 'v', reader, graph }]);
    const result = await callTool<SingleOverview>(
      registerTool(buildGetVaultOverviewTool({ registry })),
      {},
    );

    expect(result.vault).toBe('v');
    expect(result.total_notes).toBe(1);
    expect(result.top_tags).toEqual([{ name: 'x', count: 1 }]);
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('fans out across two vaults when vault: is omitted in multi-vault mode', async () => {
    const readerA = readerOver({ 'a.md': { frontmatter: { tags: ['alpha'] } } });
    const readerB = readerOver({
      'b.md': { frontmatter: { tags: ['beta'] } },
      'c.md': { frontmatter: { tags: ['beta'] } },
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, graph: makeGraph() },
    ]);
    const result = await callTool<{
      results_by_vault: Array<SingleOverview>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    }>(registerTool(buildGetVaultOverviewTool({ registry })), {});

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

  it('returns failed_vaults when one vault overview computation rejects', async () => {
    const readerA = readerOver({ 'a.md': { frontmatter: { tags: ['alpha'] } } });
    const readerB = makeReader({
      scan: vi.fn().mockResolvedValue(['b.md']),
      readNotes: vi
        .fn()
        .mockRejectedValue(new ToolHandlerError('CLI_UNAVAILABLE', 'obsidian not running')),
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, graph: makeGraph() },
    ]);
    const result = await callTool<{
      results_by_vault: Array<SingleOverview>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
      failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
    }>(registerTool(buildGetVaultOverviewTool({ registry })), {});

    expect(result.skipped_vaults).toEqual([]);
    expect(result.failed_vaults).toEqual([
      {
        vault: 'vault-b',
        error: { code: 'CLI_UNAVAILABLE', message: 'obsidian not running' },
      },
    ]);
    expect(result.results_by_vault).toHaveLength(1);
    const vaultA = result.results_by_vault[0];
    expect(vaultA.vault).toBe('vault-a');
    expect(vaultA.total_notes).toBe(1);
    expect(vaultA.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('single-vault path still returns { vault, ...overview } flat shape (regression)', async () => {
    const reader = readerOver({
      'x.md': { frontmatter: { tags: ['tag1'] } },
      'y.md': { frontmatter: { tags: ['tag1'] } },
    });
    const registry = makeTestRegistry([{ name: 'solo', reader, graph: makeGraph() }]);
    const result = await callTool<SingleOverview>(
      registerTool(buildGetVaultOverviewTool({ registry })),
      {},
    );

    // Must be flat shape (single vault => isMulti() === false)
    expect(result.vault).toBe('solo');
    expect(result.total_notes).toBe(2);
    expect((result as unknown as Record<string, unknown>).results_by_vault).toBeUndefined();
  });

  it('carries the vault conventions in single-vault mode', async () => {
    const registry = makeTestRegistry([
      {
        name: 'v',
        reader: makeReader(),
        graph: makeGraph(),
        readConventions: async () => '# House rules',
      },
    ]);
    const result = await callTool<SingleOverview>(
      registerTool(buildGetVaultOverviewTool({ registry })),
      {},
    );
    expect(result.conventions).toBe('# House rules');
  });

  it('gives each fanned-out vault its own conventions', async () => {
    const registry = makeTestRegistry([
      {
        name: 'vault-a',
        reader: makeReader(),
        graph: makeGraph(),
        readConventions: async () => 'rules A',
      },
      {
        name: 'vault-b',
        reader: makeReader(),
        graph: makeGraph(),
        readConventions: async () => null,
      },
    ]);

    const result = await callTool<{
      results_by_vault: SingleOverview[];
      failed_vaults: Array<{ vault: string }>;
    }>(registerTool(buildGetVaultOverviewTool({ registry })), {});

    const byName = new Map(result.results_by_vault.map((r) => [r.vault, r]));
    expect(byName.get('vault-a')!.conventions).toBe('rules A');
    expect(byName.get('vault-b')!).not.toHaveProperty('conventions');
    expect(result.failed_vaults).toEqual([]);
  });

  it('advertises the conventions field in its description', () => {
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), graph: makeGraph() }]);
    const description = registerTool(buildGetVaultOverviewTool({ registry })).spec.description;
    expect(description).toMatch(
      /the response carries them in `conventions`.*Follow them when reading, writing, or organising notes here/,
    );
  });

  it('keeps the conventions sentence and drops the skipped_vaults sentence', () => {
    const tool = buildGetVaultOverviewTool({ registry: registryOf('a', 'b') });
    expect(tool.description).toContain(
      "the response carries them in `conventions` — the vault owner's rules for how this vault is organised.",
    );
    expect(tool.description).not.toContain('skipped_vaults');
    expect(tool.description).toContain(FAN_OUT_SUFFIX);
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), graph: makeGraph() }]);

    await expect(
      callTool(registerTool(buildGetVaultOverviewTool({ registry })), { vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
});
