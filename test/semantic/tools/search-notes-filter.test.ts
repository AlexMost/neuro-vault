import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import type { SearchEngine, SmartSource } from '../../../src/modules/semantic/types.js';
import { makeSearchDeps } from './_helpers.js';

function makeMockSource(p: string, embedding: number[] = [1, 0]): SmartSource {
  return { path: p, embedding, blocks: [] };
}

function makeSources(paths: string[]): Map<string, SmartSource> {
  return new Map(paths.map((p) => [p, makeMockSource(p)]));
}

function makeEngine(
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

describe('search_notes — filter', () => {
  it('passes only allowed sources to findNeighbors when filter is set', async () => {
    const sources = makeSources(['Resources/a.md', 'Resources/b.md', 'Inbox/c.md']);
    const findNeighbors = vi.fn().mockReturnValue([
      { path: 'Resources/a.md', similarity: 0.9 },
      { path: 'Resources/b.md', similarity: 0.7 },
    ]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeEngine({ findNeighbors }),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: 'q',
        filter: { path_prefix: 'Resources/' },
      })) as SearchNotesOutput;

      expect(result.results.map((r) => r.path)).toEqual(['Resources/a.md', 'Resources/b.md']);
      const passedSources = [...findNeighbors.mock.calls[0]![0].sources];
      expect(passedSources.map((s) => s.path).sort()).toEqual(['Resources/a.md', 'Resources/b.md']);
    } finally {
      await cleanup();
    }
  });

  it('returns empty results without calling embed/searchEngine when allowed set is empty', async () => {
    const embed = vi.fn();
    const findNeighbors = vi.fn();
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md', 'b.md']),
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine: makeEngine({ findNeighbors }),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: 'q',
        filter: { tags: ['nonexistent'] },
      })) as SearchNotesOutput;

      expect(result.results).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      expect(findNeighbors).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('returns blockResults: [] for deep mode with empty allowed set', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: 'q',
        mode: 'deep',
        filter: { tags: ['x'] },
      })) as SearchNotesOutput;

      expect(result.results).toEqual([]);
      expect((result as { blockResults?: unknown[] }).blockResults).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('returns truncated: false for multi-query with empty allowed set', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: ['q1', 'q2'],
        filter: { tags: ['x'] },
      })) as SearchNotesOutput;

      expect(result.results).toEqual([]);
      expect((result as { truncated?: boolean }).truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('does NOT call listMatchingPaths when filter is absent (back-compat)', async () => {
    const listMatchingPaths = vi.fn();
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeEngine({ findNeighbors: vi.fn().mockReturnValue([]) }),
      modelKey: 'm',
      listMatchingPaths,
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await tool.handler({ query: 'q' });
      expect(listMatchingPaths).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('rejects empty filter object', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await expect(tool.handler({ query: 'q', filter: {} })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('maps INVALID_FILTER from listMatchingPaths to INVALID_ARGUMENT', async () => {
    const listMatchingPaths = vi.fn(async () => {
      throw new ToolHandlerError('INVALID_FILTER', 'banned op $where');
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths,
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await expect(
        tool.handler({ query: 'q', filter: { frontmatter: { $where: '...' } } }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('banned op'),
      });
    } finally {
      await cleanup();
    }
  });

  it('wraps other listMatchingPaths errors as DEPENDENCY_ERROR', async () => {
    const listMatchingPaths = vi.fn(async () => {
      throw new Error('disk read failed');
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths,
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await expect(tool.handler({ query: 'q', filter: { tags: ['x'] } })).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
    } finally {
      await cleanup();
    }
  });

  it('deep mode: findBlockNeighbors receives only allowed sources', async () => {
    const sources = makeSources(['Resources/a.md', 'Resources/b.md', 'Inbox/c.md']);
    const findNeighbors = vi.fn().mockReturnValue([{ path: 'Resources/a.md', similarity: 0.9 }]);
    const findBlockNeighbors = vi.fn().mockReturnValue([]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeEngine({ findNeighbors, findBlockNeighbors }),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await tool.handler({
        query: 'q',
        mode: 'deep',
        filter: { path_prefix: 'Resources/' },
      });

      expect(findBlockNeighbors).toHaveBeenCalled();
      const passedToBlock = [...findBlockNeighbors.mock.calls[0]![0].sources];
      expect(passedToBlock.map((s) => s.path).sort()).toEqual(['Resources/a.md', 'Resources/b.md']);
    } finally {
      await cleanup();
    }
  });

  it('multi-query merges within filtered subset', async () => {
    const sources = makeSources(['Resources/a.md', 'Resources/b.md', 'Inbox/c.md']);
    const findNeighbors = vi
      .fn()
      .mockReturnValueOnce([{ path: 'Resources/a.md', similarity: 0.9 }])
      .mockReturnValueOnce([{ path: 'Resources/b.md', similarity: 0.85 }]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: {
        initialize: vi.fn(),
        embed: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
      },
      searchEngine: makeEngine({ findNeighbors }),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: ['q1', 'q2'],
        filter: { path_prefix: 'Resources/' },
      })) as SearchNotesOutput;

      expect(result.results.map((r) => r.path).sort()).toEqual([
        'Resources/a.md',
        'Resources/b.md',
      ]);
      for (const call of findNeighbors.mock.calls) {
        const passed = [...call[0].sources].map((s: SmartSource) => s.path).sort();
        expect(passed).toEqual(['Resources/a.md', 'Resources/b.md']);
      }
    } finally {
      await cleanup();
    }
  });

  it('exclude_path_prefix alone is a valid filter', async () => {
    const sources = makeSources(['Live/a.md', 'Live/b.md', 'Archive/c.md']);
    const findNeighbors = vi.fn().mockReturnValue([
      { path: 'Live/a.md', similarity: 0.9 },
      { path: 'Live/b.md', similarity: 0.8 },
    ]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeEngine({ findNeighbors }),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Live/a.md', 'Live/b.md']),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = (await tool.handler({
        query: 'q',
        filter: { exclude_path_prefix: 'Archive/' },
      })) as SearchNotesOutput;

      expect(result.results.map((r) => r.path).sort()).toEqual(['Live/a.md', 'Live/b.md']);
    } finally {
      await cleanup();
    }
  });

  it('rejects empty path_prefix array with INVALID_ARGUMENT', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await expect(tool.handler({ query: 'q', filter: { path_prefix: [] } })).rejects.toMatchObject(
        { code: 'INVALID_ARGUMENT' },
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects empty exclude_path_prefix array with INVALID_ARGUMENT', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: makeEngine(),
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      await expect(
        tool.handler({ query: 'q', filter: { exclude_path_prefix: [] } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await cleanup();
    }
  });
});
