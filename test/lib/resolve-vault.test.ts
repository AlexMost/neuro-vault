import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { resolveVault, resolveSemanticVault } from '../../src/lib/resolve-vault.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';
import type { SmartConnectionsCorpusIndex } from '../../src/lib/obsidian/smart-connections-corpus-index.js';

function makeRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map((e) => ({ ...e }) as IVaultEntry);
  const byName = new Map(list.map((e) => [e.name!, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name!),
    isMulti: () => list.length > 1,
    semanticAvailableEntries: () => list.filter((e) => e.semanticAvailable),
  };
}

describe('resolveVault', () => {
  it('single-vault registry returns the sole entry when vault: omitted', () => {
    const reg = makeRegistry([{ name: 'only', semanticAvailable: true }]);
    expect(resolveVault({}, reg, { tool: 'create_note' }).name).toBe('only');
  });

  it('single-vault registry returns the sole entry when vault: matches', () => {
    const reg = makeRegistry([{ name: 'only', semanticAvailable: true }]);
    expect(resolveVault({ vault: 'only' }, reg, { tool: 'create_note' }).name).toBe('only');
  });

  it('single-vault registry throws VAULT_NOT_FOUND when vault: differs', () => {
    const reg = makeRegistry([{ name: 'only', semanticAvailable: true }]);
    try {
      resolveVault({ vault: 'other' }, reg, { tool: 'create_note' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('VAULT_NOT_FOUND');
    }
  });

  it('multi-vault registry returns the named entry', () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: true },
    ]);
    expect(resolveVault({ vault: 'b' }, reg, { tool: 'create_note' }).name).toBe('b');
  });

  it('multi-vault registry without vault: throws VAULT_REQUIRED', () => {
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: true },
      { name: 'b', semanticAvailable: true },
    ]);
    try {
      resolveVault({}, reg, { tool: 'create_note' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('VAULT_REQUIRED');
      expect((err as ToolHandlerError).details).toEqual({
        tool: 'create_note',
        registered_vaults: ['a', 'b'],
      });
    }
  });
});

describe('resolveSemanticVault', () => {
  it('single-vault, semantic available → returns entry with corpus defined (no !)', () => {
    const fakeCorpus = { snapshot: async () => ({}) } as unknown as SmartConnectionsCorpusIndex;
    const reg = makeRegistry([{ name: 'only', semanticAvailable: true, corpus: fakeCorpus }]);
    const entry = resolveSemanticVault({}, reg, { tool: 'search_notes' });
    expect(entry.name).toBe('only');
    expect(entry.corpus).toBe(fakeCorpus);
  });

  it('single-vault, no semantic index → throws SEMANTIC_INDEX_NOT_FOUND', () => {
    const reg = makeRegistry([
      {
        name: 'only',
        semanticAvailable: false,
        semanticUnavailableReason: 'no .smart-env/',
      },
    ]);
    try {
      resolveSemanticVault({}, reg, { tool: 'search_notes' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('SEMANTIC_INDEX_NOT_FOUND');
      expect((err as ToolHandlerError).details).toMatchObject({ vault: 'only' });
    }
  });

  it('multi-vault, vault: "b" selects vault b (semantic available) over vault a (no semantic)', () => {
    const fakeCorpus = { snapshot: async () => ({}) } as unknown as SmartConnectionsCorpusIndex;
    const reg = makeRegistry([
      { name: 'a', semanticAvailable: false },
      { name: 'b', semanticAvailable: true, corpus: fakeCorpus },
    ]);
    const entry = resolveSemanticVault({ vault: 'b' }, reg, { tool: 'search_notes' });
    expect(entry.name).toBe('b');
    expect(entry.corpus).toBe(fakeCorpus);
  });
});
