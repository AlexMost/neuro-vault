import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { startNeuroVaultServer } from '../src/server.js';

function createTempVaultPath() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-server-'));
}

function createFakeServer() {
  const registeredToolNames: string[] = [];
  return {
    registeredToolNames,
    registerTool: vi.fn((name: string) => {
      registeredToolNames.push(name);
      return {} as never;
    }),
    connect: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeCorpus = {
  sources: new Map([
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
  ]),
};

describe('Neuro Vault MCP server bootstrap', () => {
  it('registers four semantic tools when only --semantic is enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();
    const initialize = vi.fn().mockResolvedValue(undefined);
    const loadCorpus = vi.fn().mockResolvedValue(fakeCorpus);

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-operations'], {
        semantic: {
          loadCorpus,
          embeddingServiceFactory: () => ({ initialize, embed: vi.fn() }),
        },
        serverFactory: () => server,
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
              loadCorpus: vi.fn().mockResolvedValue({ sources: new Map() }),
              embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
            },
            serverFactory: () => createFakeServer(),
            transportFactory: () => ({}) as never,
          },
        ),
      ).rejects.toThrow('Loaded Smart Connections corpus is empty');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers five operations tools when only --operations is enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      readNote: vi.fn(),
      createNote: vi.fn(),
      editNote: vi.fn(),
      readDaily: vi.fn(),
      appendDaily: vi.fn(),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
        operations: { vaultProviderFactory: () => fakeProvider },
        serverFactory: () => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'read_note',
        'create_note',
        'edit_note',
        'read_daily',
        'append_daily',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers nine tools (4 semantic + 5 operations) when both modules are enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      readNote: vi.fn(),
      createNote: vi.fn(),
      editNote: vi.fn(),
      readDaily: vi.fn(),
      appendDaily: vi.fn(),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        semantic: {
          loadCorpus: vi.fn().mockResolvedValue(fakeCorpus),
          embeddingServiceFactory: () => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            embed: vi.fn(),
          }),
        },
        operations: { vaultProviderFactory: () => fakeProvider },
        serverFactory: () => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'get_stats',
        'read_note',
        'create_note',
        'edit_note',
        'read_daily',
        'append_daily',
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
