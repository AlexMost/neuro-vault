import { describe, expect, it, vi } from 'vitest';

import { createOperationsModule } from '../../src/modules/operations/index.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';
import type { IVaultRegistry, IVaultEntry } from '../../src/lib/vault-registry.js';
import type { VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../src/lib/obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';

describe('createOperationsModule', () => {
  it('builds tools and resources from the first registry entry', () => {
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
      listProperties: vi.fn(),
      listTags: vi.fn(),
    } as unknown as VaultProvider;

    const fakeReader = {
      readNotes: vi.fn().mockResolvedValue([]),
      scan: vi.fn().mockResolvedValue([]),
    } as unknown as VaultReader;

    const fakeWriter = {
      replaceInNote: vi.fn(),
      replaceFullBody: vi.fn(),
    } as unknown as VaultWriter;

    const fakeGraph = {
      ensureFresh: vi.fn().mockResolvedValue(undefined),
      getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
      getBacklinkCount: vi.fn(() => 0),
    } as unknown as WikilinkGraphIndex;

    const fakeEntry: IVaultEntry = {
      name: 'MyVault',
      path: '/tmp/MyVault',
      smartEnvPath: '/tmp/MyVault/.smart-env/multi',
      reader: fakeReader,
      writer: fakeWriter,
      provider: fakeProvider,
      graph: fakeGraph,
      listMatchingPaths: vi.fn(),
      semanticAvailable: false,
    };

    const fakeRegistry: IVaultRegistry = {
      get: vi.fn(),
      require: vi.fn(),
      list: vi.fn(() => [fakeEntry]),
      isMulti: vi.fn(() => false),
      names: vi.fn(() => ['MyVault']),
      semanticAvailableEntries: vi.fn(() => []),
    };

    const result = createOperationsModule(fakeRegistry, { binaryPath: '/usr/bin/obsidian' });

    expect(result.tools.length).toBe(10);
    expect(result.resources.length).toBe(1);
  });
});
