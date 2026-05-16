import { describe, expect, it } from 'vitest';

import { runFanOut, runSemanticFanOut } from '../../src/lib/fan-out.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';

function makeRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map((e) => ({ semanticAvailable: true, ...e }) as IVaultEntry);
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
    expect(out.failed_vaults).toEqual([]);
  });

  it('does not skip vaults regardless of semantic availability', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: false, semanticUnavailableReason: 'no corpus' },
    ]);
    const out = await runFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault.map((g) => g.vault)).toEqual(['a', 'b']);
    expect(out.skipped_vaults).toEqual([]);
    expect(out.failed_vaults).toEqual([]);
  });

  it('captures fn rejections into failed_vaults instead of throwing', async () => {
    const reg = makeRegistry([{ name: 'a' }]);
    const out = await runFanOut(reg, async () => {
      throw new ToolHandlerError('DEPENDENCY_ERROR', 'boom', { details: { vault: 'a' } });
    });
    expect(out.results_by_vault).toEqual([]);
    expect(out.failed_vaults).toEqual([
      { vault: 'a', error: { code: 'DEPENDENCY_ERROR', message: 'boom', details: { vault: 'a' } } },
    ]);
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
    expect(out.failed_vaults).toEqual([]);
  });

  it('skips vaults without a semantic index and lists them in skipped_vaults', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: false, semanticUnavailableReason: 'no .smart-env/' },
    ]);
    const out = await runSemanticFanOut(reg, async (entry) => ({ count: entry.name.length }));
    expect(out.results_by_vault).toEqual([{ vault: 'a', count: 1 }]);
    expect(out.skipped_vaults).toEqual([{ vault: 'b', reason: 'SEMANTIC_INDEX_NOT_FOUND' }]);
    expect(out.failed_vaults).toEqual([]);
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
    expect(out.failed_vaults).toEqual([]);
  });

  it('captures fn rejections into failed_vaults instead of throwing', async () => {
    const reg = makeRegistry([{ name: 'a', semanticAvailable: true }]);
    const out = await runSemanticFanOut(reg, async () => {
      throw new ToolHandlerError('DEPENDENCY_ERROR', 'boom', { details: {} });
    });
    expect(out.results_by_vault).toEqual([]);
    expect(out.failed_vaults).toEqual([
      { vault: 'a', error: { code: 'DEPENDENCY_ERROR', message: 'boom', details: {} } },
    ]);
  });
});

describe('partial failure', () => {
  it('runFanOut: one of N vaults throws ToolHandlerError → N-1 successes + 1 failed_vaults', async () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const out = await runFanOut(reg, async (entry) => {
      if (entry.name === 'b') {
        throw new ToolHandlerError('CLI_NOT_FOUND', 'no obsidian in PATH');
      }
      return { count: entry.name.length };
    });
    expect(out.results_by_vault).toEqual([
      { vault: 'a', count: 1 },
      { vault: 'c', count: 1 },
    ]);
    expect(out.failed_vaults).toEqual([
      { vault: 'b', error: { code: 'CLI_NOT_FOUND', message: 'no obsidian in PATH' } },
    ]);
    expect(out.skipped_vaults).toEqual([]);
  });

  it('runFanOut: one vault throws plain Error → INTERNAL_ERROR with the error message', async () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
    const out = await runFanOut(reg, async (entry) => {
      if (entry.name === 'b') {
        throw new Error('unexpected boom');
      }
      return { count: 1 };
    });
    expect(out.results_by_vault).toEqual([{ vault: 'a', count: 1 }]);
    expect(out.failed_vaults).toEqual([
      { vault: 'b', error: { code: 'INTERNAL_ERROR', message: 'unexpected boom' } },
    ]);
  });

  it('runFanOut: all vaults throw → results_by_vault is empty, failed_vaults has them all, helper does not throw', async () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
    const out = await runFanOut(reg, async (entry) => {
      throw new ToolHandlerError('DEPENDENCY_ERROR', `boom in ${entry.name}`);
    });
    expect(out.results_by_vault).toEqual([]);
    expect(out.failed_vaults).toEqual([
      { vault: 'a', error: { code: 'DEPENDENCY_ERROR', message: 'boom in a' } },
      { vault: 'b', error: { code: 'DEPENDENCY_ERROR', message: 'boom in b' } },
    ]);
  });

  it('runFanOut: preserves registry order across mixed success/failure', async () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]);
    const out = await runFanOut(reg, async (entry) => {
      if (entry.name === 'b' || entry.name === 'd') {
        throw new ToolHandlerError('CLI_NOT_FOUND', 'x');
      }
      return { v: entry.name };
    });
    expect(out.results_by_vault.map((r) => r.vault)).toEqual(['a', 'c']);
    expect(out.failed_vaults.map((f) => f.vault)).toEqual(['b', 'd']);
  });

  it('runSemanticFanOut: skipped + failed co-exist on the same response', async () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: false, semanticUnavailableReason: 'no corpus' },
      { name: 'c', semanticAvailable: true },
    ]);
    const out = await runSemanticFanOut(reg, async (entry) => {
      if (entry.name === 'c') {
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'oom');
      }
      return { v: entry.name };
    });
    expect(out.results_by_vault).toEqual([{ vault: 'a', v: 'a' }]);
    expect(out.skipped_vaults).toEqual([{ vault: 'b', reason: 'SEMANTIC_INDEX_NOT_FOUND' }]);
    expect(out.failed_vaults).toEqual([
      { vault: 'c', error: { code: 'DEPENDENCY_ERROR', message: 'oom' } },
    ]);
  });

  it('ToolHandlerError details are preserved verbatim in failed_vaults', async () => {
    const reg = makeRegistry([{ name: 'a' }]);
    const out = await runFanOut(reg, async () => {
      throw new ToolHandlerError('NOT_FOUND', 'gone', {
        details: { path: 'Notes/missing.md', searched: 3 },
      });
    });
    expect(out.failed_vaults[0]).toEqual({
      vault: 'a',
      error: {
        code: 'NOT_FOUND',
        message: 'gone',
        details: { path: 'Notes/missing.md', searched: 3 },
      },
    });
  });
});
