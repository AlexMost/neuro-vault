import { describe, expect, it, vi } from 'vitest';

import { buildQueryNotesTool } from '../../../src/modules/operations/tools/query-notes.js';
import type { QueryNotesResultWithVault } from '../../../src/modules/operations/tools/query-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { FAN_OUT_SUFFIX } from '../../../src/lib/vault-param.js';
import type { IVaultRegistry } from '../../../src/lib/vault-registry.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { makeGraph, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function registryOf(...names: string[]): IVaultRegistry {
  return makeTestRegistry(
    names.map((name) => ({
      name,
      reader: makeReader({
        scan: vi.fn().mockResolvedValue(['a.md']),
        readNotes: vi.fn().mockResolvedValue([{ path: 'a.md', frontmatter: {}, content: '' }]),
      }),
      graph: makeGraph(),
    })),
  );
}

function regOf(registry: IVaultRegistry) {
  return registerTool(buildQueryNotesTool({ registry }));
}

describe('operations.queryNotes handler', () => {
  it('passes the query through runQueryNotes and adds vault to each result item', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md', 'Notes/b.md']),
      readNotes: vi.fn().mockResolvedValue([
        { path: 'Notes/a.md', frontmatter: { type: 'idea', created: '2026-05-12' }, content: '' },
        { path: 'Notes/b.md', frontmatter: { type: 'idea', created: '2026-05-13' }, content: '' },
      ]),
    });
    const graph = makeGraph();
    const registry = makeTestRegistry([{ name: 'v', reader, graph }]);

    const result = await callTool<QueryNotesResultWithVault>(regOf(registry), {
      filter: { 'frontmatter.type': { $eq: 'idea' } },
    });

    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.results).toHaveLength(2);
    for (const item of result.results) {
      expect(item.vault).toBe('v');
      expect(item.path).toBeDefined();
    }
  });

  it('returns empty results when no notes match', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'Notes/a.md', frontmatter: { type: 'task' }, content: '' }]),
    });
    const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);

    const result = await callTool<QueryNotesResultWithVault>(regOf(registry), {
      filter: { 'frontmatter.type': { $eq: 'nonexistent' } },
    });

    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('fans out across two vaults when vault: is omitted in multi-vault mode', async () => {
    const readerA = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { type: 'idea' }, content: '' }]),
    });
    const readerB = makeReader({
      scan: vi.fn().mockResolvedValue(['b.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'b.md', frontmatter: { type: 'idea' }, content: '' }]),
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, graph: makeGraph() },
    ]);

    const result = await callTool<{
      results_by_vault: Array<{
        vault: string;
        results: QueryNotesResultWithVault['results'];
        count: number;
        truncated: boolean;
      }>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    }>(regOf(registry), { filter: { 'frontmatter.type': { $eq: 'idea' } } });

    expect(result.results_by_vault).toHaveLength(2);
    expect(result.skipped_vaults).toEqual([]);
    const byVault = new Map(result.results_by_vault.map((g) => [g.vault, g]));
    expect(byVault.has('vault-a')).toBe(true);
    expect(byVault.has('vault-b')).toBe(true);
    expect(byVault.get('vault-a')!.results[0].path).toBe('a.md');
    expect(byVault.get('vault-a')!.results[0].vault).toBe('vault-a');
    expect(byVault.get('vault-b')!.results[0].path).toBe('b.md');
    expect(byVault.get('vault-b')!.results[0].vault).toBe('vault-b');
    expect(byVault.get('vault-a')!.count).toBe(1);
    expect(byVault.get('vault-b')!.count).toBe(1);
    expect(byVault.get('vault-a')!.truncated).toBe(false);
    expect(byVault.get('vault-b')!.truncated).toBe(false);
  });

  it('returns failed_vaults when one vault reader rejects', async () => {
    const readerA = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { type: 'idea' }, content: '' }]),
    });
    const readerB = makeReader({
      scan: vi.fn().mockRejectedValue(new ToolHandlerError('DEPENDENCY_ERROR', 'fs read failed')),
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, graph: makeGraph() },
    ]);

    const result = await callTool<{
      results_by_vault: Array<{
        vault: string;
        results: QueryNotesResultWithVault['results'];
        count: number;
        truncated: boolean;
      }>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
      failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
    }>(regOf(registry), { filter: {} });

    expect(result.skipped_vaults).toEqual([]);
    expect(result.failed_vaults).toEqual([
      {
        vault: 'vault-b',
        error: { code: 'DEPENDENCY_ERROR', message: 'fs read failed' },
      },
    ]);
    expect(result.results_by_vault).toHaveLength(1);
    const vaultA = result.results_by_vault[0];
    expect(vaultA.vault).toBe('vault-a');
    expect(vaultA.results[0].path).toBe('a.md');
    expect(vaultA.results[0].vault).toBe('vault-a');
    expect(vaultA.count).toBe(1);
    expect(vaultA.truncated).toBe(false);
  });

  it('explicit vault: returns flat { results, count, truncated } shape (regression)', async () => {
    const readerA = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { type: 'idea' }, content: '' }]),
    });
    const readerB = makeReader({
      scan: vi.fn().mockResolvedValue(['b.md']),
      readNotes: vi.fn().mockResolvedValue([]),
    });
    const registry = makeTestRegistry([
      { name: 'vault-a', reader: readerA, graph: makeGraph() },
      { name: 'vault-b', reader: readerB, graph: makeGraph() },
    ]);

    const result = await callTool<QueryNotesResultWithVault>(regOf(registry), {
      vault: 'vault-a',
      filter: { 'frontmatter.type': { $eq: 'idea' } },
    });

    // Must be flat shape, not results_by_vault
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('truncated');
    expect((result as unknown as Record<string, unknown>).results_by_vault).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].vault).toBe('vault-a');
  });

  it('returns the payload unchanged for a single vault — vault rides on each item', async () => {
    const out = await callTool<{
      results: Array<{ vault: string }>;
      count: number;
      truncated: boolean;
    }>(regOf(registryOf('only')), { filter: {} });
    expect(Object.keys(out).sort()).toEqual(['count', 'results', 'truncated']);
    expect(out).not.toHaveProperty('vault');
    for (const item of out.results) expect(item.vault).toBe('only');
  });

  it('drops the skipped_vaults sentence from its description', () => {
    const tool = buildQueryNotesTool({ registry: registryOf('a', 'b') });
    expect(tool.description).not.toContain('skipped_vaults');
    expect(tool.description).toContain(FAN_OUT_SUFFIX);
  });

  it('parses filter, limit and include_content from their string forms', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { type: 'idea' }, content: 'body' }]),
    });
    const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);

    const result = await callTool<QueryNotesResultWithVault>(regOf(registry), {
      filter: '{"frontmatter.type":{"$eq":"idea"}}',
      limit: '5',
      include_content: 'true',
    });

    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('body');
  });

  it('parses path_prefix supplied as a JSON string array', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Tasks/a.md', 'Other/b.md']),
      readNotes: vi.fn().mockResolvedValue([{ path: 'Tasks/a.md', frontmatter: {}, content: '' }]),
    });
    const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);

    const result = await callTool<QueryNotesResultWithVault>(regOf(registry), {
      filter: {},
      path_prefix: '["Tasks/"]',
    });

    expect(result.results.map((r) => r.path)).toEqual(['Tasks/a.md']);
  });

  it('rejects an unknown key', async () => {
    await expect(
      callTool(regOf(registryOf('v')), { filter: {}, order: 'asc' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('order') }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(
      callTool(regOf(registryOf('v')), { filter: {}, vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
});
