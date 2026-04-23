import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../src/config.js';
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
      return {} as ReturnType<
        import('@modelcontextprotocol/sdk/server/mcp.js').McpServer['registerTool']
      >;
    }),
    connect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Neuro Vault MCP server bootstrap', () => {
  it('parses --vault, creates the startup dependencies, and registers four tools in-process', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

    await fs.mkdir(smartEnvPath, { recursive: true });

    const server = createFakeServer();
    const initialize = vi.fn().mockResolvedValue(undefined);
    const loadCorpus = vi.fn().mockResolvedValue({
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
    });
    const embeddingServiceFactory = vi.fn().mockReturnValue({
      initialize,
      embed: vi.fn(),
    });
    const toolHandlersFactory = vi.fn().mockReturnValue({
      searchNotes: vi.fn().mockResolvedValue({ results: [] }),
      getSimilarNotes: vi.fn().mockResolvedValue([]),
      findDuplicates: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({
        totalNotes: 1,
        totalBlocks: 1,
        embeddingDimension: 3,
        modelKey: 'bge-micro-v2',
      }),
    });

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        loadCorpus,
        embeddingServiceFactory,
        toolHandlersFactory,
        serverFactory: () => server,
        transportFactory: vi.fn().mockReturnValue({}),
      });

      await expect(parseConfig(['node', 'cli.js', '--vault', vaultPath])).resolves.toEqual({
        vaultPath,
        smartEnvPath,
        modelKey: 'bge-micro-v2',
        modelId: 'TaylorAI/bge-micro-v2',
      });
      expect(loadCorpus).toHaveBeenCalledWith(smartEnvPath, 'bge-micro-v2');
      expect(embeddingServiceFactory).toHaveBeenCalledWith('TaylorAI/bge-micro-v2');
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
      expect(toolHandlersFactory).toHaveBeenCalledTimes(1);
      expect(server.registerTool).toHaveBeenCalledTimes(4);
      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'get_stats',
      ]);
      expect(server.connect).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when the Smart Connections directory is missing', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');

    await fs.mkdir(vaultPath, { recursive: true });

    try {
      await expect(main(['node', 'cli.js', '--vault', vaultPath])).rejects.toThrow(
        /Smart Connections/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when startup receives an empty corpus', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

    await fs.mkdir(smartEnvPath, { recursive: true });

    const initialize = vi.fn();

    try {
      await expect(
        startNeuroVaultServer(
          {
            vaultPath,
            smartEnvPath,
            modelKey: 'bge-micro-v2',
            modelId: 'TaylorAI/bge-micro-v2',
          },
          {
            loadCorpus: vi.fn().mockResolvedValue({ sources: new Map() }),
            embeddingServiceFactory: vi.fn().mockReturnValue({
              initialize,
              embed: vi.fn(),
            }),
            toolHandlersFactory: vi.fn(),
            serverFactory: vi.fn(),
            transportFactory: vi.fn(),
          },
        ),
      ).rejects.toThrow('Loaded Smart Connections corpus is empty');

      expect(initialize).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
