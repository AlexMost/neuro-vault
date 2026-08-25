import { describe, expect, it, vi } from 'vitest';

import { buildSemanticTools } from '../../../src/modules/semantic/tools/index.js';
import type { EmbeddingProvider, SearchEngine } from '../../../src/modules/semantic/types.js';
import type { IVaultRegistry } from '../../../src/lib/vault-registry.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import { makeFakeGraph } from './_helpers.js';

const embeddingProvider: EmbeddingProvider = { initialize: vi.fn(), embed: vi.fn() };
const searchEngine: SearchEngine = {
  findNeighbors: vi.fn().mockReturnValue([]),
  findBlockNeighbors: vi.fn().mockReturnValue([]),
  findDuplicates: vi.fn().mockReturnValue([]),
};

function registryOf(...names: string[]): IVaultRegistry {
  return makeTestRegistry(
    names.map((name) => ({
      name,
      path: `/vaults/${name}`,
      graph: makeFakeGraph(),
      listMatchingPaths: async () => new Set<string>(),
    })),
  );
}

function toolsFor(...names: string[]) {
  return buildSemanticTools({
    registry: registryOf(...names),
    embeddingProvider,
    searchEngine,
    modelKey: 'bge-micro-v2',
  });
}

describe('buildSemanticTools', () => {
  it('returns 3 registrations with the expected names', () => {
    expect(toolsFor('v').map((t) => t.name)).toEqual([
      'search_notes',
      'get_similar_notes',
      'find_duplicates',
    ]);
  });

  // Mirrors the operations-side guard. Both of these resolve through
  // resolveSemanticVault and cannot fan out, so the contract has to live on the
  // description — the server `instructions` string no longer carries it.
  it('states the VAULT_REQUIRED contract on the semantic tools that cannot fan out', () => {
    const tools = toolsFor('a', 'b');
    for (const name of ['get_similar_notes', 'find_duplicates']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.spec.description, name).toMatch(/VAULT_REQUIRED/);
    }
  });

  it('does not claim VAULT_REQUIRED on search_notes, which fans out instead', () => {
    const searchNotes = toolsFor('a', 'b').find((t) => t.name === 'search_notes')!;
    expect(searchNotes.spec.description).not.toMatch(/VAULT_REQUIRED/);
    expect(searchNotes.spec.description).toMatch(/fan out across all registered vaults/);
  });

  it('enumerates the registered vault names in every multi-vault description', () => {
    for (const tool of toolsFor('a', 'b')) {
      expect(tool.spec.description, tool.name).toMatch(/Registered vaults: "a", "b"\./);
    }
  });

  it('leaks no vault-name enumeration in single-vault mode', () => {
    for (const tool of toolsFor('v')) {
      expect(tool.spec.description, tool.name).not.toMatch(/Registered vaults:/);
    }
  });
});
