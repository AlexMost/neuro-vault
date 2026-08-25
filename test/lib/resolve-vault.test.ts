import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { resolveVault, resolveSemanticVault } from '../../src/lib/resolve-vault.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';
import type { SemanticBackend } from '../../src/lib/obsidian/semantic-backend.js';

function makeRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map((e) => ({ readConventions: async () => null, ...e }) as IVaultEntry);
  const byName = new Map(list.map((e) => [e.name, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
  };
}

function readyBackend(): SemanticBackend {
  return {
    snapshot: async () => ({ sources: new Map(), basenameIndex: new Map() }) as never,
    status: () => ({ state: 'ready' }),
    dispose: async () => {},
  };
}

function unavailableBackend(reason: string): SemanticBackend {
  return {
    snapshot: async () => ({ sources: new Map(), basenameIndex: new Map() }) as never,
    status: () => ({ state: 'unavailable', reason }),
    dispose: async () => {},
  };
}

function registryWithBackend(
  status:
    | { state: 'indexing'; indexed: number; total: number }
    | { state: 'disabled' }
    | { state: 'unavailable'; reason: string },
): IVaultRegistry {
  const backend: SemanticBackend = {
    snapshot: async () => ({ sources: new Map(), basenameIndex: new Map() }) as never,
    status: () => status,
    dispose: async () => {},
  };
  return makeRegistry([{ name: 'v', backend }]);
}

function catchError(fn: () => unknown): ToolHandlerError {
  try {
    fn();
    throw new Error('expected throw');
  } catch (err) {
    if (err instanceof ToolHandlerError) return err;
    throw err;
  }
}

describe('resolveVault', () => {
  it('single-vault registry returns the sole entry when vault: omitted', () => {
    const reg = makeRegistry([{ name: 'only' }]);
    expect(resolveVault({}, reg, { tool: 'create_note' }).name).toBe('only');
  });

  it('single-vault registry returns the sole entry when vault: matches', () => {
    const reg = makeRegistry([{ name: 'only' }]);
    expect(resolveVault({ vault: 'only' }, reg, { tool: 'create_note' }).name).toBe('only');
  });

  it('single-vault registry throws VAULT_NOT_FOUND when vault: differs', () => {
    const reg = makeRegistry([{ name: 'only' }]);
    try {
      resolveVault({ vault: 'other' }, reg, { tool: 'create_note' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('VAULT_NOT_FOUND');
    }
  });

  it('multi-vault registry returns the named entry', () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
    expect(resolveVault({ vault: 'b' }, reg, { tool: 'create_note' }).name).toBe('b');
  });

  it('multi-vault registry without vault: throws VAULT_REQUIRED', () => {
    const reg = makeRegistry([{ name: 'a' }, { name: 'b' }]);
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
  it('single-vault, backend ready → returns entry with backend defined (no !)', () => {
    const backend = readyBackend();
    const reg = makeRegistry([{ name: 'only', backend }]);
    const entry = resolveSemanticVault({}, reg, { tool: 'search_notes' });
    expect(entry.name).toBe('only');
    expect(entry.backend).toBe(backend);
  });

  it('single-vault, no backend → throws SEMANTIC_INDEX_NOT_FOUND', () => {
    const reg = makeRegistry([{ name: 'only' }]);
    try {
      resolveSemanticVault({}, reg, { tool: 'search_notes' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('SEMANTIC_INDEX_NOT_FOUND');
      expect((err as ToolHandlerError).details).toMatchObject({ vault: 'only' });
    }
  });

  it('single-vault, backend unavailable → throws SEMANTIC_INDEX_NOT_FOUND with the backend reason', () => {
    const reg = makeRegistry([{ name: 'only', backend: unavailableBackend('no corpus') }]);
    try {
      resolveSemanticVault({}, reg, { tool: 'search_notes' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('SEMANTIC_INDEX_NOT_FOUND');
      expect((err as ToolHandlerError).message).toMatch(/no corpus/);
    }
  });

  it('multi-vault, vault: "b" selects vault b (backend ready) over vault a (no backend)', () => {
    const backend = readyBackend();
    const reg = makeRegistry([{ name: 'a' }, { name: 'b', backend }]);
    const entry = resolveSemanticVault({ vault: 'b' }, reg, { tool: 'search_notes' });
    expect(entry.name).toBe('b');
    expect(entry.backend).toBe(backend);
  });

  it('reports a building index with its progress', () => {
    const registry = registryWithBackend({ state: 'indexing', indexed: 12, total: 840 });
    try {
      resolveSemanticVault({}, registry, { tool: 'find_duplicates' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolHandlerError);
      const e = error as ToolHandlerError;
      expect(e.code).toBe('SEMANTIC_INDEX_BUILDING');
      expect(e.details).toMatchObject({ vault: 'v', indexed: 12, total: 840 });
    }
  });

  it('names the config key for a disabled vault', () => {
    const registry = registryWithBackend({ state: 'disabled' });
    const error = catchError(() =>
      resolveSemanticVault({}, registry, { tool: 'get_similar_notes' }),
    );
    expect(error.code).toBe('SEMANTIC_DISABLED');
    expect(`${error.message} ${JSON.stringify(error.details)}`).toContain(
      '.neuro-vault/config.json',
    );
  });

  it('points an unavailable corpus at the index command and never at a plugin', () => {
    const registry = registryWithBackend({ state: 'unavailable', reason: 'EACCES' });
    const error = catchError(() => resolveSemanticVault({}, registry, { tool: 'find_duplicates' }));
    expect(error.code).toBe('SEMANTIC_INDEX_NOT_FOUND');
    const text = `${error.message} ${JSON.stringify(error.details)}`;
    expect(text).toContain('EACCES');
    expect(text).toContain('index');
    expect(text).not.toMatch(/Obsidian|plugin/i);
  });

  // The spec scenario is literal: "the reason is present in the details".
  // A reason interpolated into the message only is not machine-readable —
  // a client parsing `details` cannot recover it from prose.
  it('carries the unavailable reason in details, not only in the message', () => {
    const registry = registryWithBackend({
      state: 'unavailable',
      reason: 'corpus shard notes/a.json is not valid JSON',
    });
    const error = catchError(() => resolveSemanticVault({}, registry, { tool: 'find_duplicates' }));
    expect(error.code).toBe('SEMANTIC_INDEX_NOT_FOUND');
    expect(error.details).toMatchObject({
      vault: 'v',
      reason: 'corpus shard notes/a.json is not valid JSON',
    });
  });

  it('carries a reason in details when the semantic module is off server-wide', () => {
    const reg = makeRegistry([{ name: 'only' }]);
    const error = catchError(() => resolveSemanticVault({}, reg, { tool: 'find_duplicates' }));
    expect(error.code).toBe('SEMANTIC_INDEX_NOT_FOUND');
    expect(error.details).toMatchObject({
      vault: 'only',
      reason: expect.stringContaining('semantic module is disabled'),
    });
  });
});
