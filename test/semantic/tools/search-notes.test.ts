import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeHandlerDeps,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
} from './_helpers.js';

describe('searchNotes', () => {
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
          pathExists,
        }),
      );

      const result = await tool.handler({ query: 'semantic query', threshold: 0 });

      expect(result.results.map((r) => r.path)).toEqual(['Folder/note-a.md', 'Folder/note-c.md']);
      expect(result.blockResults?.map((b) => b.path) ?? []).not.toContain('Folder/note-b.md');
      expect(pathExists).toHaveBeenCalledWith('Folder/note-b.md');
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed,
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      const result = await tool.handler({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed,
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      await expect(tool.handler({ query: '   ' })).rejects.toMatchObject({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed,
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      const searchPromise = tool.handler({ query: 'semantic query' });

      await expect(searchPromise).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
      await expect(searchPromise).rejects.toBeInstanceOf(ToolHandlerError);
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed: vi.fn(),
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      await expect(
        tool.handler({ query: 'semantic query', threshold: -0.01 }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });

      await expect(
        tool.handler({ query: 'semantic query', threshold: 1.01 }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: MODEL_KEY,
        }),
      );

      const output = (await tool.handler({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: MODEL_KEY,
        }),
      );

      await expect(tool.handler({ query: [] })).rejects.toMatchObject({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: MODEL_KEY,
        }),
      );

      await expect(
        tool.handler({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: MODEL_KEY,
        }),
      );

      await tool.handler({
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
      const tool = buildSearchNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: MODEL_KEY,
        }),
      );

      const output = (await tool.handler({
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
