import { describe, expect, it } from 'vitest';

import { runFanOut } from '../../src/lib/fan-out.js';
import { FATAL_TOOL_ERROR_CODES, ToolHandlerError } from '../../src/lib/tool-response.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';

function makeRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map((e) => ({ semanticAvailable: true, ...e }) as IVaultEntry);
  return {
    get: (n) => list.find((e) => e.name === n),
    require: () => list[0],
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
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

describe('fatal-code re-throw', () => {
  // Codes that mean "the whole tool call should fail, not one vault" — same
  // outcome on every vault. Fan-out re-throws them as a single fatal error
  // rather than reporting N identical failed_vaults entries. The set is owned
  // by tool-response.ts (FATAL_TOOL_ERROR_CODES); iterating it here keeps the
  // tests automatically in sync.
  const fatalCodes = Array.from(FATAL_TOOL_ERROR_CODES);

  for (const code of fatalCodes) {
    it(`runFanOut: re-throws ToolHandlerError when code is "${code}" instead of capturing`, async () => {
      const reg = makeRegistry([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      await expect(
        runFanOut(reg, async () => {
          throw new ToolHandlerError(code, `bad ${code} payload`);
        }),
      ).rejects.toMatchObject({
        code,
        message: `bad ${code} payload`,
      });
    });
  }

  it('runFanOut: fatal re-throw wins even when other vaults have runtime failures', async () => {
    // vault a throws CLI_NOT_FOUND (runtime — would be captured)
    // vault b throws INVALID_FILTER (fatal — must be re-thrown)
    // Result: fatal INVALID_FILTER, not a partial response.
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
    await expect(
      runFanOut(reg, async (entry) => {
        if (entry.name === 'a') {
          throw new ToolHandlerError('CLI_NOT_FOUND', 'no obsidian');
        }
        throw new ToolHandlerError('INVALID_FILTER', 'bad operator $foo');
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('runFanOut: fatal re-throw preserves details', async () => {
    const reg = makeRegistry([{ name: 'a' }]);
    await expect(
      runFanOut(reg, async () => {
        throw new ToolHandlerError('INVALID_FILTER', 'forbidden operator', {
          details: { operator: '$where' },
        });
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_FILTER',
      message: 'forbidden operator',
      details: { operator: '$where' },
    });
  });
});
