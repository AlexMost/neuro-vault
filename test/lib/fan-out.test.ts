import { describe, expect, it } from 'vitest';

import { runFanOut, runSemanticFanOut } from '../../src/lib/fan-out.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import type { VaultEntry, VaultRegistry } from '../../src/lib/vault-registry.js';

function makeRegistry(entries: Partial<VaultEntry>[]): VaultRegistry {
  const list = entries.map((e) => ({ semanticAvailable: true, ...e }) as VaultEntry);
  return {
    get: (n) => list.find((e) => e.name === n),
    require: () => list[0],
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
    semanticAvailableEntries: () => list.filter((e) => e.semanticAvailable),
  };
}

describe('runFanOut', () => {
  it('invokes fn per entry and groups results', async () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
    const out = await runFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault).toEqual([
      { vault: 'a', count: 1 },
      { vault: 'b', count: 1 },
    ]);
    expect(out.skipped_vaults).toEqual([]);
  });

  it('does not skip vaults regardless of semantic availability', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: false, semanticUnavailableReason: 'no corpus' },
    ]);
    const out = await runFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault.map((g) => g.vault)).toEqual(['a', 'b']);
    expect(out.skipped_vaults).toEqual([]);
  });

  it('propagates errors from fn (does not swallow)', async () => {
    const reg = makeRegistry([{ name: 'a' }]);
    await expect(
      runFanOut(reg, async () => {
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'boom', { details: {} });
      }),
    ).rejects.toBeInstanceOf(ToolHandlerError);
  });
});

describe('runSemanticFanOut', () => {
  it('runs fn only on semantically-available entries', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: true },
    ]);
    const out = await runSemanticFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault.map((g) => g.vault)).toEqual(['a', 'b']);
    expect(out.skipped_vaults).toEqual([]);
  });

  it('skips vaults without a semantic index and lists them in skipped_vaults', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: false, semanticUnavailableReason: 'no .smart-env/' },
    ]);
    const out = await runSemanticFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault).toEqual([{ vault: 'a', count: 1 }]);
    expect(out.skipped_vaults).toEqual([{ vault: 'b', reason: 'SEMANTIC_INDEX_NOT_FOUND' }]);
  });

  it('returns empty results_by_vault and lists all when no vault has semantic', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: false },
      { name: 'b', semanticAvailable: false },
    ]);
    const out = await runSemanticFanOut(reg, async () => ({ count: 1 }));
    expect(out.results_by_vault).toEqual([]);
    expect(out.skipped_vaults).toEqual([
      { vault: 'a', reason: 'SEMANTIC_INDEX_NOT_FOUND' },
      { vault: 'b', reason: 'SEMANTIC_INDEX_NOT_FOUND' },
    ]);
  });

  it('propagates ToolHandlerError from fn (does not swallow)', async () => {
    const reg = makeRegistry([{ name: 'a', semanticAvailable: true }]);
    await expect(
      runSemanticFanOut(reg, async () => {
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'boom', { details: {} });
      }),
    ).rejects.toBeInstanceOf(ToolHandlerError);
  });
});
