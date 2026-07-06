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
  const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    registeredToolNames,
    registeredResourceUris,
    toolHandlers,
    registerTool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1] as (a: unknown) => Promise<unknown>;
      registeredToolNames.push(name);
      toolHandlers.set(name, handler);
      return {} as never;
    }) as never,
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
  it('returns SEMANTIC_INDEX_NOT_FOUND when Smart Connections directory is missing (startup tolerant)', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
    const server = createFakeServer();

    try {
      // Startup should NOT throw — missing corpus is tolerated at module init time.
      await startNeuroVaultServer(
        {
          vaults: [
            {
              name: path.basename(vaultPath),
              path: vaultPath,
              smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
            },
          ],
          semantic: {
            enabled: true,
            modelKey: 'bge-micro-v2',
            modelId: 'TaylorAI/bge-micro-v2',
          },
        },
        {
          semantic: {
            embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
          },
          serverFactory: (_instructions: string) => server,
          transportFactory: () => ({}) as never,
        },
      );

      // The tool is registered, but calling it on the missing-corpus vault
      // returns a structured error (not a thrown exception — MCP wraps ToolHandlerError).
      const findDuplicates = server.toolHandlers.get('find_duplicates');
      expect(findDuplicates).toBeDefined();
      const result = await findDuplicates!({});
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: 'SEMANTIC_INDEX_NOT_FOUND' },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns SEMANTIC_INDEX_NOT_FOUND when corpus is empty (startup tolerant)', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();

    try {
      // Startup should NOT throw — empty corpus is tolerated at module init time.
      await startNeuroVaultServer(
        {
          vaults: [
            {
              name: path.basename(vaultPath),
              path: vaultPath,
              smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
            },
          ],
          semantic: {
            enabled: true,
            modelKey: 'bge-micro-v2',
            modelId: 'TaylorAI/bge-micro-v2',
          },
        },
        {
          vaultEntryDeps: {
            corpusFactory: () => Promise.resolve(makeFakeCorpusIndex(new Map())),
          },
          semantic: {
            embeddingServiceFactory: () => ({ initialize: vi.fn(), embed: vi.fn() }),
          },
          serverFactory: (_instructions: string) => server,
          transportFactory: () => ({}) as never,
        },
      );

      // The tool is registered, but calling it on the empty-corpus vault
      // returns a structured error (not a thrown exception — MCP wraps ToolHandlerError).
      const findDuplicates = server.toolHandlers.get('find_duplicates');
      expect(findDuplicates).toBeDefined();
      const result = await findDuplicates!({});
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: 'SEMANTIC_INDEX_NOT_FOUND' },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers eleven operations tools when --no-semantic is passed', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath, '--no-semantic'], {
        vaultEntryDeps: {
          providerFactory: () => fakeProvider as never,
          readerFactory: () =>
            ({
              readNotes: vi.fn().mockResolvedValue([]),
              scan: vi.fn().mockResolvedValue([]),
            }) as never,
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
        'remove_property',
        'list_tags',
        'list_properties',
        'get_note_links',
        'get_vault_overview',
      ]);
      // Removed tools are absent; the unique low-use tools we keep are present.
      expect(server.registeredToolNames).not.toContain('read_property');
      expect(server.registeredToolNames).toContain('list_properties');
      expect(server.registeredToolNames).toContain('remove_property');
      expect(server.registeredToolNames).toContain('get_note_links');
      expect(server.registeredResourceUris).toEqual(['vault://overview']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('registers fourteen tools (3 semantic + 11 operations) when both modules are enabled', async () => {
    const tempRoot = await createTempVaultPath();
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.smart-env', 'multi'), { recursive: true });

    const server = createFakeServer();
    const fakeProvider = {
      createNote: vi.fn(),
      readDaily: vi.fn(),
      setProperty: vi.fn().mockResolvedValue(undefined),
      removeProperty: vi.fn().mockResolvedValue(undefined),
      listProperties: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    };

    try {
      await main(['node', 'cli.js', '--vault', vaultPath], {
        vaultEntryDeps: {
          corpusFactory: () => Promise.resolve(makeFakeCorpusIndex()),
          providerFactory: () => fakeProvider as never,
          readerFactory: () =>
            ({
              readNotes: vi.fn().mockResolvedValue([]),
              scan: vi.fn().mockResolvedValue([]),
            }) as never,
        },
        semantic: {
          embeddingServiceFactory: () => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            embed: vi.fn(),
          }),
        },
        serverFactory: (_instructions: string) => server,
        transportFactory: () => ({}) as never,
      });

      expect(server.registeredToolNames).toEqual([
        'search_notes',
        'get_similar_notes',
        'find_duplicates',
        'read_notes',
        'query_notes',
        'create_note',
        'edit_note',
        'read_daily',
        'set_property',
        'remove_property',
        'list_tags',
        'list_properties',
        'get_note_links',
        'get_vault_overview',
      ]);
      // The two removed tools must be gone from the combined surface;
      // list_properties is back (full property inventory for consistency audits).
      expect(server.registeredToolNames).not.toContain('read_property');
      expect(server.registeredToolNames).not.toContain('get_stats');
      expect(server.registeredToolNames).toContain('list_properties');
      // The unique low-use tools we keep stay registered.
      expect(server.registeredToolNames).toContain('find_duplicates');
      expect(server.registeredToolNames).toContain('get_note_links');
      expect(server.registeredToolNames).toContain('remove_property');
      expect(server.registeredResourceUris).toEqual(['vault://overview']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
