import { describe, expect, it, vi } from 'vitest';

import { createOperationsModule } from '../../src/modules/operations/index.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';
import type { IVaultRegistry, IRegisteredVault } from '../../src/lib/vault-registry.js';
import type { VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { makeVaultGraph } from '../_vault-graph.js';
import { createExistingPathFilter } from '../../src/lib/obsidian/existing-paths.js';
import { createVaultScope } from '../../src/lib/obsidian/vault-scope.js';

describe('createOperationsModule', () => {
  it('builds tools and resources from the first registry entry', () => {
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    } as unknown as VaultProvider;

    const fakeReader = {
      readNotes: vi.fn().mockResolvedValue([]),
      scan: vi.fn().mockResolvedValue([]),
    } as unknown as VaultReader;

    const fakeGraph = makeVaultGraph();

    const fakeEntry: IRegisteredVault = {
      name: 'MyVault',
      path: '/tmp/MyVault',
      scope: createVaultScope(),
      reader: fakeReader,
      provider: fakeProvider,
      graph: fakeGraph,
      listMatchingPaths: vi.fn(),
      readConventions: async () => null,
      filterExisting: createExistingPathFilter({ vaultRoot: '/tmp/MyVault' }),
      lexical: { search: vi.fn(), warm: vi.fn() },
    };

    const fakeRegistry: IVaultRegistry = {
      get: vi.fn(),
      require: vi.fn(),
      list: vi.fn(() => [fakeEntry]),
      isMulti: vi.fn(() => false),
      names: vi.fn(() => ['MyVault']),
    };

    const result = createOperationsModule(fakeRegistry);

    expect(result.tools.length).toBe(11);
    expect(result.resources.length).toBe(1);
  });
});
