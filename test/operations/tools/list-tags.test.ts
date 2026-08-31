import { describe, expect, it, vi } from 'vitest';

import { buildListTagsTool } from '../../../src/modules/operations/tools/list-tags.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { FAN_OUT_SUFFIX } from '../../../src/lib/vault-param.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import type { IVaultRegistry } from '../../../src/lib/vault-registry.js';
import { makeReader, readerOver } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function regOf(registry: IVaultRegistry) {
  return registerTool(buildListTagsTool({ registry }));
}

function registryOf(...names: string[]): IVaultRegistry {
  return makeTestRegistry(
    names.map((name) => ({
      name,
      reader: readerOver({ 'n.md': { frontmatter: { tags: ['x'] } } }),
    })),
  );
}

describe('operations.listTags handler', () => {
  it('derives tag counts from the vault reader and wraps result with vault', async () => {
    const tagged = { frontmatter: { tags: ['mcp'] } };
    const reader = readerOver({ 'a.md': tagged, 'b.md': tagged, 'c.md': tagged });
    const registry = makeTestRegistry([{ name: 'v', reader }]);
    expect(await callTool(regOf(registry), {})).toEqual({
      vault: 'v',
      results: [{ name: 'mcp', count: 3 }],
    });
    expect(reader.readNotes).toHaveBeenCalled();
  });

  it('routes to the named vault in multi-vault mode when vault is provided', async () => {
    const readerA = readerOver({ 'a.md': { frontmatter: { tags: ['fromA'] } } });
    const bTagged = { frontmatter: { tags: ['fromB'] } };
    const readerB = readerOver({ 'b1.md': bTagged, 'b2.md': bTagged });
    const registry = makeTestRegistry([
      { name: 'a', reader: readerA },
      { name: 'b', reader: readerB },
    ]);

    expect(await callTool(regOf(registry), { vault: 'b' })).toEqual({
      vault: 'b',
      results: [{ name: 'fromB', count: 2 }],
    });
    expect(readerA.readNotes).not.toHaveBeenCalled();
    expect(readerB.readNotes).toHaveBeenCalledTimes(1);
  });

  it('fans out across all registered vaults when vault is omitted in multi-vault mode', async () => {
    const readerA = readerOver({ 'a.md': { frontmatter: { tags: ['fromA'] } } });
    const bTagged = { frontmatter: { tags: ['fromB'] } };
    const readerB = readerOver({ 'b1.md': bTagged, 'b2.md': bTagged });
    const registry = makeTestRegistry([
      { name: 'a', reader: readerA },
      { name: 'b', reader: readerB },
    ]);

    const result = await callTool(regOf(registry), {});
    expect(result).toEqual({
      results_by_vault: [
        { vault: 'a', results: [{ name: 'fromA', count: 1 }] },
        { vault: 'b', results: [{ name: 'fromB', count: 2 }] },
      ],
      skipped_vaults: [],
      failed_vaults: [],
    });
    expect(readerA.readNotes).toHaveBeenCalledTimes(1);
    expect(readerB.readNotes).toHaveBeenCalledTimes(1);
  });

  it('returns failed_vaults when one vault reader rejects', async () => {
    const tagged = { frontmatter: { tags: ['mcp'] } };
    const readerA = readerOver({
      'a1.md': tagged,
      'a2.md': tagged,
      'a3.md': tagged,
      'a4.md': tagged,
      'a5.md': tagged,
    });
    const readerB = makeReader({
      scan: vi.fn().mockResolvedValue(['b.md']),
      readNotes: vi
        .fn()
        .mockRejectedValue(new ToolHandlerError('CLI_NOT_FOUND', 'obsidian not on PATH')),
    });
    const registry = makeTestRegistry([
      { name: 'a', reader: readerA },
      { name: 'b', reader: readerB },
    ]);

    const result = await callTool<{
      results_by_vault: Array<{ vault: string; results: Array<{ name: string; count: number }> }>;
      failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
      skipped_vaults: Array<{ vault: string; reason: string }>;
    }>(regOf(registry), {});

    expect(result.results_by_vault).toEqual([{ vault: 'a', results: [{ name: 'mcp', count: 5 }] }]);
    expect(result.failed_vaults).toEqual([
      {
        vault: 'b',
        error: { code: 'CLI_NOT_FOUND', message: 'obsidian not on PATH' },
      },
    ]);
    expect(result.skipped_vaults).toEqual([]);
  });

  it('returns { vault, results } for a single vault and never a top-level fan-out envelope', async () => {
    const out = await callTool(regOf(registryOf('only')), {});
    expect(out).toEqual({ vault: 'only', results: [{ name: 'x', count: 1 }] });
  });

  it('carries the shared fan-out prose and never mentions skipped_vaults', () => {
    const tool = buildListTagsTool({ registry: registryOf('a', 'b') });
    expect(tool.description).toContain(FAN_OUT_SUFFIX);
    expect(tool.description).not.toContain('skipped_vaults');
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(regOf(registryOf('only')), { vault: 'only' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('rejects an unknown key', async () => {
    await expect(callTool(regOf(registryOf('only')), { prefix: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('prefix') }] },
    });
  });
});
