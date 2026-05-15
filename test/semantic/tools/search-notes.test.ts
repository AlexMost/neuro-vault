import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import type { SearchEngine, SmartSource } from '../../../src/modules/semantic/types.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeGraph,
  makeSearchDeps,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
  makeTestRegistry,
  makeFakeCorpusIndex,
} from './_helpers.js';

// Lightweight helpers for mock-only tests (no real corpus needed)
function makeMockSource(p: string, embedding: number[] = [1, 0]): SmartSource {
  return {
    path: p,
    embedding,
    blocks: [],
  };
}

function makeMockSources(paths: string[]): Map<string, SmartSource> {
  return new Map(paths.map((p) => [p, makeMockSource(p)]));
}

function makeMockSearchEngine(
  overrides: Partial<{
    findNeighbors: SearchEngine['findNeighbors'];
    findBlockNeighbors: SearchEngine['findBlockNeighbors'];
    findDuplicates: SearchEngine['findDuplicates'];
  }> = {},
): SearchEngine {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

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
      // note-b is absent from disk
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
        absentPaths: new Set(['Folder/note-b.md']),
      });
      const tool = buildSearchNotesTool(deps);

      try {
        const result = (await tool.handler({
          query: 'semantic query',
          threshold: 0,
        })) as SearchNotesOutput;
        expect(result.results.map((r) => r.path)).toEqual(['Folder/note-a.md', 'Folder/note-c.md']);
        expect(result.blockResults?.map((b) => b.path) ?? []).not.toContain('Folder/note-b.md');
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);

      try {
        const result = (await tool.handler({
          query: '  semantic query  ',
          threshold: 0,
        })) as SearchNotesOutput;

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
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);

      try {
        await expect(tool.handler({ query: '   ' })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
        expect(embed).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);

      try {
        const searchPromise = tool.handler({ query: 'semantic query' });
        await expect(searchPromise).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
        await expect(searchPromise).rejects.toBeInstanceOf(ToolHandlerError);
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);

      try {
        await expect(
          tool.handler({ query: 'semantic query', threshold: -0.01 }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(
          tool.handler({ query: 'semantic query', threshold: 1.01 }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);

      try {
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
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty query array', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      try {
        await expect(tool.handler({ query: [] })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a query array longer than 8', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      try {
        await expect(
          tool.handler({ query: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      try {
        await tool.handler({ query: ['  alpha  ', 'alpha', 'beta'], threshold: 0 });
        expect(embed).toHaveBeenCalledTimes(2);
        expect(embed).toHaveBeenNthCalledWith(1, 'alpha');
        expect(embed).toHaveBeenNthCalledWith(2, 'beta');
      } finally {
        await cleanup();
      }
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
      const { deps, cleanup } = await makeSearchDeps({
        sources: corpus.sources,
        embeddingProvider: { initialize: vi.fn(), embed },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      try {
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
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a query array with an empty string element', async () => {
    const sources = makeMockSources(['note-a.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeMockSearchEngine(),
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      await expect(tool.handler({ query: [''] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects a query array with a whitespace-only string element', async () => {
    const sources = makeMockSources(['note-a.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeMockSearchEngine(),
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      await expect(tool.handler({ query: ['  '] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('query: array length 1 still carries matched_queries on results', async () => {
    const sources = makeMockSources(['note-a.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([{ path: 'note-a.md', similarity: 0.9 }]),
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: ['single'], threshold: 0 })) as {
        results: Array<{ path: string; matched_queries?: string[] }>;
        truncated: boolean;
      };

      expect(output.results).toHaveLength(1);
      expect(output.results[0]!.matched_queries).toEqual(['single']);
      expect(output.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('multi-query: matched_queries lists only queries that returned the path (above-threshold)', async () => {
    // Q1 returns note-a.md at 0.9; Q2 returns only note-b.md at 0.8.
    // note-a.md should have matched_queries = ['q1'] only.
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi
      .fn()
      .mockResolvedValueOnce([1, 0]) // q1
      .mockResolvedValueOnce([0, 1]); // q2
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }]) // q1
        .mockReturnValueOnce([{ path: 'note-b.md', similarity: 0.8 }]), // q2 — note-a not returned
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: ['q1', 'q2'], threshold: 0 })) as {
        results: Array<{ path: string; matched_queries?: string[] }>;
        truncated: boolean;
      };

      const byPath = new Map(output.results.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.matched_queries).toEqual(['q1']);
      expect(byPath.get('note-b.md')!.matched_queries).toEqual(['q2']);
    } finally {
      await cleanup();
    }
  });

  it('multi-query expansion: expanded results have via_expansion: true and no matched_queries', async () => {
    // Seeds: note-a.md (from query). Expansion: exp.md.
    const sources = makeMockSources(['note-a.md', 'exp.md']);
    // Give note-a.md a non-empty embedding so expansion runs
    sources.get('note-a.md')!.embedding = [1, 0];

    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }]) // query
        .mockReturnValueOnce([{ path: 'exp.md', similarity: 0.7 }]), // expansion
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: ['q1'], mode: 'deep', threshold: 0 })) as {
        results: Array<{ path: string; matched_queries?: string[]; via_expansion?: true }>;
        truncated: boolean;
      };

      const expanded = output.results.filter((r) => r.via_expansion);
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.every((r) => r.via_expansion === true)).toBe(true);
      expect(expanded.every((r) => r.matched_queries === undefined)).toBe(true);

      const seeds = output.results.filter((r) => !r.via_expansion);
      expect(seeds.every((r) => Array.isArray(r.matched_queries))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('quick mode multi-query never has via_expansion results', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }])
        .mockReturnValueOnce([{ path: 'note-b.md', similarity: 0.8 }]),
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({
        query: ['q1', 'q2'],
        mode: 'quick',
        threshold: 0,
      })) as {
        results: Array<{ path: string; via_expansion?: true }>;
      };

      expect(output.results.every((r) => !r.via_expansion)).toBe(true);
      // findNeighbors called exactly twice (once per query), no expansion calls
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
    }
  });

  it('query: string in deep mode emits via_expansion: true on expansion-derived results', async () => {
    const sources = makeMockSources(['note-a.md', 'exp.md']);
    sources.get('note-a.md')!.embedding = [1, 0];

    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }]) // initial query
        .mockReturnValueOnce([{ path: 'exp.md', similarity: 0.7 }]), // expansion
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: 'test query', mode: 'deep', threshold: 0 })) as {
        results: Array<{ path: string; via_expansion?: true }>;
      };

      const expanded = output.results.filter((r) => r.via_expansion);
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.every((r) => r.via_expansion === true)).toBe(true);

      const nonExpanded = output.results.filter((r) => !r.via_expansion);
      expect(nonExpanded.every((r) => r.via_expansion === undefined)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('enriches single-query results with backlink_count from the graph', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([
        { path: 'note-a.md', similarity: 0.9 },
        { path: 'note-b.md', similarity: 0.8 },
      ]),
    });
    const graph = makeFakeGraph({ 'note-a.md': 3, 'note-b.md': 0 });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
      graph,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: 'topic', threshold: 0 })) as {
        results: Array<{ path: string; backlink_count: number }>;
      };

      expect(graph.ensureFresh).toHaveBeenCalled();
      const byPath = new Map(output.results.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.backlink_count).toBe(3);
      expect(byPath.get('note-b.md')!.backlink_count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('enriches multi-query results with backlink_count from the graph', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }])
        .mockReturnValueOnce([{ path: 'note-b.md', similarity: 0.8 }]),
    });
    const graph = makeFakeGraph({ 'note-a.md': 5, 'note-b.md': 1 });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
      graph,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: ['q1', 'q2'], threshold: 0 })) as {
        results: Array<{ path: string; backlink_count: number }>;
      };

      expect(graph.ensureFresh).toHaveBeenCalled();
      const byPath = new Map(output.results.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.backlink_count).toBe(5);
      expect(byPath.get('note-b.md')!.backlink_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('multi-query final cap: limit=2 with 3 queries each returning 2 unique results → length ≤ 2', async () => {
    const sources = makeMockSources(['a-0.md', 'a-1.md', 'b-0.md', 'b-1.md', 'c-0.md', 'c-1.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([
          { path: 'a-0.md', similarity: 0.9 },
          { path: 'a-1.md', similarity: 0.8 },
        ])
        .mockReturnValueOnce([
          { path: 'b-0.md', similarity: 0.7 },
          { path: 'b-1.md', similarity: 0.6 },
        ])
        .mockReturnValueOnce([
          { path: 'c-0.md', similarity: 0.5 },
          { path: 'c-1.md', similarity: 0.4 },
        ]),
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({
        query: ['q1', 'q2', 'q3'],
        mode: 'quick',
        limit: 2,
        threshold: 0,
      })) as { results: unknown[]; truncated: boolean };

      expect(output.results.length).toBeLessThanOrEqual(2);
      expect(output.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('stamps vault name on every result item (single query)', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const searchEngine = makeMockSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([
        { path: 'note-a.md', similarity: 0.9 },
        { path: 'note-b.md', similarity: 0.8 },
      ]),
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine,
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    try {
      const output = (await tool.handler({ query: 'topic', threshold: 0 })) as SearchNotesOutput;
      expect(output.results.every((r) => r.vault === 'v')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('fans out across two semantically-available vaults when vault: is omitted in multi-vault mode', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const sources1 = new Map([
        ['note-a.md', { path: 'note-a.md', embedding: [1, 0], blocks: [] }],
      ]);
      const sources2 = new Map([
        ['note-b.md', { path: 'note-b.md', embedding: [0, 1], blocks: [] }],
      ]);
      const corpusIndex1 = makeFakeCorpusIndex(sources1);
      const corpusIndex2 = makeFakeCorpusIndex(sources2);

      // Create temp vault roots so pathExistsForEntry works
      const fs2 = await import('node:fs/promises');
      const os2 = await import('node:os');
      const path2 = await import('node:path');
      const vaultRoot1 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'fanout-v1-'));
      const vaultRoot2 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'fanout-v2-'));
      await fs2.mkdir(path2.join(vaultRoot1), { recursive: true });
      await fs2.mkdir(path2.join(vaultRoot2), { recursive: true });
      // Write the note files so pathExistsForEntry returns true
      await fs2.writeFile(path2.join(vaultRoot1, 'note-a.md'), '', 'utf8');
      await fs2.writeFile(path2.join(vaultRoot2, 'note-b.md'), '', 'utf8');

      try {
        const searchEngine = {
          findNeighbors: vi
            .fn()
            .mockReturnValueOnce([{ path: 'note-a.md', similarity: 0.9 }])
            .mockReturnValueOnce([{ path: 'note-b.md', similarity: 0.8 }]),
          findBlockNeighbors: vi.fn().mockReturnValue([]),
          findDuplicates: vi.fn().mockReturnValue([]),
        };
        const registry = makeTestRegistry([
          {
            name: 'v1',
            path: vaultRoot1,
            smartEnvPath,
            corpus: corpusIndex1,
            semanticAvailable: true,
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
          {
            name: 'v2',
            path: vaultRoot2,
            smartEnvPath,
            corpus: corpusIndex2,
            semanticAvailable: true,
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
        ]);
        const tool = buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
          searchEngine,
          modelKey: MODEL_KEY,
        });

        const result = (await tool.handler({ query: 'q', threshold: 0 })) as {
          results_by_vault: Array<{ vault: string; results: Array<{ path: string }> }>;
          skipped_vaults: Array<{ vault: string; reason: string }>;
        };

        expect(result.results_by_vault).toHaveLength(2);
        expect(result.skipped_vaults).toEqual([]);
        const byVault = new Map(result.results_by_vault.map((g) => [g.vault, g]));
        expect(byVault.has('v1')).toBe(true);
        expect(byVault.has('v2')).toBe(true);
        expect(byVault.get('v1')!.results[0]!.path).toBe('note-a.md');
        expect(byVault.get('v2')!.results[0]!.path).toBe('note-b.md');
      } finally {
        await fs2.rm(vaultRoot1, { recursive: true, force: true });
        await fs2.rm(vaultRoot2, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fan-out skips vaults without semantic index and surfaces them in skipped_vaults', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const sources1 = new Map([
        ['note-a.md', { path: 'note-a.md', embedding: [1, 0], blocks: [] }],
      ]);
      const corpusIndex1 = makeFakeCorpusIndex(sources1);

      const vaultRoot1 = await (
        await import('node:fs/promises')
      ).mkdtemp(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'fanout-skip-v1-'),
      );
      await (
        await import('node:fs/promises')
      ).writeFile((await import('node:path')).join(vaultRoot1, 'note-a.md'), '', 'utf8');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v1',
            path: vaultRoot1,
            smartEnvPath,
            corpus: corpusIndex1,
            semanticAvailable: true,
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
          {
            name: 'v2',
            path: tempRoot,
            smartEnvPath,
            corpus: undefined,
            semanticAvailable: false,
            semanticUnavailableReason: 'no index',
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
        ]);
        const tool = buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
          searchEngine: {
            findNeighbors: vi.fn().mockReturnValue([{ path: 'note-a.md', similarity: 0.9 }]),
            findBlockNeighbors: vi.fn().mockReturnValue([]),
            findDuplicates: vi.fn().mockReturnValue([]),
          },
          modelKey: MODEL_KEY,
        });

        const result = (await tool.handler({ query: 'q', threshold: 0 })) as {
          results_by_vault: Array<{ vault: string; results: Array<{ path: string }> }>;
          skipped_vaults: Array<{ vault: string; reason: string }>;
        };

        expect(result.results_by_vault).toHaveLength(1);
        expect(result.results_by_vault[0]!.vault).toBe('v1');
        expect(result.skipped_vaults).toEqual([
          { vault: 'v2', reason: 'SEMANTIC_INDEX_NOT_FOUND' },
        ]);
      } finally {
        await (await import('node:fs/promises')).rm(vaultRoot1, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws SEMANTIC_INDEX_NOT_FOUND when vault has semanticAvailable: false', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);
    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          smartEnvPath,
          corpus: undefined,
          semanticAvailable: false,
          semanticUnavailableReason: 'no corpus',
        },
      ]);
      const tool = buildSearchNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(tool.handler({ vault: 'v', query: 'q' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
