import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildBasenameIndex } from '../src/lib/obsidian/index.js';
import type { SmartConnectionsCorpusIndex } from '../src/lib/obsidian/smart-connections-corpus-index.js';
import { main } from '../src/cli.js';
import { startNeuroVaultServer } from '../src/server.js';

function createTempVaultPath() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-server-'));
}

function createFakeServer() {
  const registeredToolNames: string[] = [];
  const registeredResourceUris: string[] = [];
  return {
    registeredToolNames,
    registeredResourceUris,
    registerTool: vi.fn((name: string) => {
      registeredToolNames.push(name);
      return {} as never;
    }),
    registerResource: vi.fn((_name: string, uri: string) => {
      registeredResourceUris.push(uri);
      return {} as never;
    }) as never,
    connect: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeSources = new Map([
  [
    'Folder/note-a.md',
    {
      path: 'Folder/note-a.md',
      embedding: [1, 0, 0],
      blocks: [
        {
          key: 'Folder/note-a.md#alpha',
          heading: '#alpha',
          lines: [1, 3] as [number, number],
          embedding: [],
        },
      ],
    },
  ],
]);

function makeFakeCorpusIndex(
  sources: typeof fakeSources = fakeSources,
): SmartConnectionsCorpusIndex {
  const basenameIndex = buildBasenameIndex(sources.keys());
  return {
    snapshot: vi.fn().mockResolvedValue({ sources, basenameIndex }),
  };
}

describe('Neuro Vault MCP server bootstrap', () => {
  it('registers four semantic tools when only --semantic is enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();
    const initialize = vi.fn().mockResolvedValue(undefined);
    const corpusFactory = vi.fn().mockResolvedValue(makeFakeCorpusIndex());

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-operations'], {
        semantic: {
          corpusFactory,
          embeddingServiceFactory: () => ({ initialize, embed: vi.fn() }),
        },
        serverFactory: (_instructions: string) => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'get_stats',
      ]);
      expect(server.connect).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when the Smart Connections directory is missing', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    try {
      await expect(
        main(['node', 'cli.js', '--vault', vaultPath, '--no-operations']),
      ).rejects.toThrow(/Smart Connections/i);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when startup receives an empty corpus', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    try {
      await expect(
        startNeuroVaultServer(
          {
            vaultPath,
            semantic: {
              enabled: true,
              smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
              modelKey: 'bge-micro-v2',
              modelId: 'TaylorAI/bge-micro-v2',
            },
            operations: { enabled: false },
          },
          {
            semantic: {
              corpusFactory: vi.fn().mockResolvedValue(makeFakeCorpusIndex(new Map())),
              embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
            },
            serverFactory: (_instructions: string) => createFakeServer(),
            transportFactory: () => ({}) as never,
          },
        ),
      ).rejects.toThrow('Loaded Smart Connections corpus is empty');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers twelve operations tools when only --operations is enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      readProperty: vi.fn().mockResolvedValue({ value: '' }),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
        operations: {
          vaultProviderFactory: () => fakeProvider,
          vaultReaderFactory: () => ({
            readNotes: vi.fn().mockResolvedValue([]),
            scan: vi.fn().mockResolvedValue([]),
          }),
        },
        serverFactory: (_instructions: string) => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'read_notes',
        'query_notes',
        'create_note',
        'edit_note',
        'read_daily',
        'set_property',
        'read_property',
        'remove_property',
        'list_properties',
        'list_tags',
        'get_note_links',
        'get_vault_overview',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers sixteen tools (4 semantic + 12 operations) when both modules are enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      readProperty: vi.fn().mockResolvedValue({ value: '' }),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        semantic: {
          corpusFactory: vi.fn().mockResolvedValue(makeFakeCorpusIndex()),
          embeddingServiceFactory: () => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            embed: vi.fn(),
          }),
        },
        operations: {
          vaultProviderFactory: () => fakeProvider,
          vaultReaderFactory: () => ({
            readNotes: vi.fn().mockResolvedValue([]),
            scan: vi.fn().mockResolvedValue([]),
          }),
        },
        serverFactory: (_instructions: string) => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'get_stats',
        'read_notes',
        'query_notes',
        'create_note',
        'edit_note',
        'read_daily',
        'set_property',
        'read_property',
        'remove_property',
        'list_properties',
        'list_tags',
        'get_note_links',
        'get_vault_overview',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects startup when both modules are disabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    try {
      await expect(
        main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic', '--no-operations']),
      ).rejects.toThrow(/at least one module/i);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
