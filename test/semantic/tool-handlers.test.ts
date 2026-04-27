import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { loadSmartConnectionsCorpus } from '../../src/modules/semantic/smart-connections-loader.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../src/modules/semantic/search-engine.js';
import { createToolHandlers, ToolHandlerError } from '../../src/modules/semantic/tool-handlers.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(testDir, 'fixtures/vault/.smart-env/multi');

async function makeVaultFixture(fileNames: string[]) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-handlers-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

  await fs.mkdir(smartEnvPath, { recursive: true });

  for (const fileName of fileNames) {
    await fs.copyFile(path.join(fixturesRoot, fileName), path.join(smartEnvPath, fileName));
  }

  return { tempRoot, smartEnvPath };
}

const MODEL_KEY = 'bge-micro-v2';

function createDuplicateCorpus(corpus: Awaited<ReturnType<typeof loadSmartConnectionsCorpus>>) {
  const sources = new Map(corpus.sources);

  sources.set('Folder/note-d.md', {
    path: 'Folder/note-d.md',
    embedding: [1, 0, 0],
    blocks: [
      {
        key: 'Folder/note-d.md#delta',
        heading: '#delta',
        lines: [1, 3] as [number, number],
        embedding: [],
      },
    ],
  });

  sources.set('Folder/note-e.md', {
    path: 'Folder/note-e.md',
    embedding: [1, 0, 0],
    blocks: [
      {
        key: 'Folder/note-e.md#echo',
        heading: '#echo',
        lines: [1, 3] as [number, number],
        embedding: [],
      },
    ],
  });

  return { sources };
}

describe('createToolHandlers', () => {
  it('filters out search results whose paths no longer exist on disk', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const pathExists = vi.fn(async (notePath: string) => notePath !== 'Folder/note-b.md');
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
        pathExists,
      });

      const result = await handlers.searchNotes({ query: 'semantic query', threshold: 0 });

      expect(result.results.map((r) => r.path)).toEqual(['Folder/note-a.md', 'Folder/note-c.md']);
      expect(result.blockResults?.map((b) => b.path) ?? []).not.toContain('Folder/note-b.md');
      expect(pathExists).toHaveBeenCalledWith('Folder/note-b.md');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('filters stale paths from get_similar_notes results', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const pathExists = vi.fn(async (notePath: string) => notePath !== 'Folder/note-b.md');
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
        pathExists,
      });

      const results = await handlers.getSimilarNotes({
        path: 'Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((r) => r.path)).toEqual(['Folder/note-c.md']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops duplicate pairs whose paths no longer exist on disk', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const pathExists = vi.fn(async (notePath: string) => notePath !== 'Folder/note-d.md');
      const handlers = createToolHandlers({
        loader: createDuplicateCorpus(corpus),
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
        pathExists,
      });

      const results = await handlers.findDuplicates({ threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
        ['Folder/note-a.md', 'Folder/note-e.md'],
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns ranked search results for a query', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed,
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const result = await handlers.searchNotes({
        query: '  semantic query  ',
        threshold: 0,
      });

      expect(embed).toHaveBeenCalledTimes(1);
      expect(embed).toHaveBeenCalledWith('semantic query');
      expect(result.results.map((r) => r.path)).toEqual([
        'Folder/note-a.md',
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
      expect(result.results[0]!.similarity).toBeGreaterThan(result.results[1]!.similarity);
      expect(result.results[1]!.similarity).toBeGreaterThan(result.results[2]!.similarity);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty query before embedding', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn();
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed,
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(handlers.searchNotes({ query: '   ' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(embed).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('surfaces embedding-provider failures as structured tool errors', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn().mockRejectedValue(new Error('model unavailable'));
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed,
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const searchPromise = handlers.searchNotes({ query: 'semantic query' });

      await expect(searchPromise).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
      await expect(searchPromise).rejects.toBeInstanceOf(ToolHandlerError);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unknown note path for similar-note lookup', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(
        handlers.getSimilarNotes({ path: 'Folder/missing.md' }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('excludes the source note from similar-note results', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await handlers.getSimilarNotes({
        path: 'Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((result) => result.path)).toEqual([
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
      expect(results.map((result) => result.path)).not.toContain('Folder/note-a.md');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes safe relative note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await handlers.getSimilarNotes({
        path: './Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((result) => result.path)).toEqual([
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects note path traversal attempts', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(
        handlers.getSimilarNotes({ path: '../Folder/note-a.md' }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Windows-style absolute note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(
        handlers.getSimilarNotes({ path: 'C:/vault/Folder/note-a.md' }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects thresholds below 0 and above 1', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(
        handlers.searchNotes({ query: 'semantic query', threshold: -0.01 }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });

      await expect(
        handlers.searchNotes({ query: 'semantic query', threshold: 1.01 }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns matching duplicate pairs', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: createDuplicateCorpus(corpus),
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await handlers.findDuplicates({ threshold: 0.95 });

      expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
        ['Folder/note-a.md', 'Folder/note-d.md'],
        ['Folder/note-a.md', 'Folder/note-e.md'],
        ['Folder/note-d.md', 'Folder/note-e.md'],
      ]);
      expect(results.every((result) => result.similarity >= 0.95)).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns corpus stats and the model key', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: {
          initialize: vi.fn(),
          embed: vi.fn(),
        },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(handlers.getStats()).resolves.toEqual({
        totalNotes: 3,
        totalBlocks: 3,
        embeddingDimension: 3,
        modelKey: 'bge-micro-v2',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts a query array and returns matched_queries on each result', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi
        .fn()
        .mockResolvedValueOnce([0.7, 0.2, 0.1])
        .mockResolvedValueOnce([0.1, 0.2, 0.7]);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      const output = (await handlers.searchNotes({
        query: ['alpha', 'beta'],
        threshold: 0,
      })) as { results: Array<{ path: string; matched_queries: string[] }>; truncated: boolean };

      expect(embed).toHaveBeenCalledTimes(2);
      expect(embed).toHaveBeenNthCalledWith(1, 'alpha');
      expect(embed).toHaveBeenNthCalledWith(2, 'beta');
      expect(output.truncated).toBe(false);
      for (const result of output.results) {
        expect(Array.isArray(result.matched_queries)).toBe(true);
        expect(result.matched_queries.length).toBeGreaterThan(0);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty query array', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(handlers.searchNotes({ query: [] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a query array longer than 8', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(
        handlers.searchNotes({
          query: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('dedupes duplicate queries before embedding', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await handlers.searchNotes({
        query: ['  alpha  ', 'alpha', 'beta'],
        threshold: 0,
      });

      expect(embed).toHaveBeenCalledTimes(2);
      expect(embed).toHaveBeenNthCalledWith(1, 'alpha');
      expect(embed).toHaveBeenNthCalledWith(2, 'beta');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps single-string output shape unchanged (no matched_queries, no truncated)', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const handlers = createToolHandlers({
        loader: corpus,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      const output = (await handlers.searchNotes({
        query: 'semantic query',
        threshold: 0,
      })) as unknown as Record<string, unknown>;

      expect(output).not.toHaveProperty('matched_queries');
      expect(output).not.toHaveProperty('truncated');
      for (const result of output.results as Array<Record<string, unknown>>) {
        expect(result).not.toHaveProperty('matched_queries');
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
