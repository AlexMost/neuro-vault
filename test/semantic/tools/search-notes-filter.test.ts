import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import type { SmartSource } from '../../../src/modules/semantic/types.js';
import { callTool } from '../../_gate.js';
import { makeFakeCorpusIndex, makeSearchDeps } from './_helpers.js';

function makeMockSource(
  p: string,
  embedding: number[] = [1, 0],
  blocks: SmartSource['blocks'] = [],
): SmartSource {
  return { path: p, embedding: Float32Array.from(embedding), blocks };
}

// Every note on the query's own vector unless `vectors` says otherwise, so a
// note the filter lets through ranks — and one it keeps out would.
function makeSources(
  paths: string[],
  vectors: Record<string, number[]> = {},
): Map<string, SmartSource> {
  return new Map(paths.map((p) => [p, makeMockSource(p, vectors[p])]));
}

describe('search_notes — filter', () => {
  it('ranks only allowed notes semantically when filter is set', async () => {
    // Inbox/c.md sits on the query vector too: only the filter keeps it out.
    const sources = makeSources(['Resources/a.md', 'Resources/b.md', 'Inbox/c.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: 'q',
        filter: { path_prefix: 'Resources/' },
      });

      // every match path starts with the filter prefix — proves the filter
      // scoped the merged list, not just the semantic leg
      expect(result.matches.every((m) => m.path.startsWith('Resources/'))).toBe(true);
      expect(result.matches.map((m) => m.path).sort()).toEqual([
        'Resources/a.md',
        'Resources/b.md',
      ]);
      expect(result.matches.every((m) => m.found_in.includes('semantic'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('returns empty results without embedding or reading the corpus when allowed set is empty', async () => {
    const embed = vi.fn();
    const sources = makeSources(['a.md', 'b.md']);
    const corpus = makeFakeCorpusIndex(sources);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      corpus,
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: 'q',
        filter: { tags: ['nonexistent'] },
      });

      expect(result.matches).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(embed).not.toHaveBeenCalled();
      expect(corpus.snapshot).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('returns an empty matches[] for deep mode with empty allowed set (no top-level blockResults)', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: 'q',
        effort: 'deep',
        filter: { tags: ['x'] },
      });

      expect(result.matches).toEqual([]);
      expect(result).not.toHaveProperty('blockResults');
    } finally {
      await cleanup();
    }
  });

  it('returns truncated: false for multi-query with empty allowed set', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        filter: { tags: ['x'] },
      });

      expect(result.matches).toEqual([]);
      expect(result.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('does NOT call listMatchingPaths when filter is absent (back-compat)', async () => {
    const listMatchingPaths = vi.fn();
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
      modelKey: 'm',
      listMatchingPaths,
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await callTool(reg, { query: 'q' });
      expect(listMatchingPaths).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('rejects empty filter object', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(callTool(reg, { query: 'q', filter: {} })).rejects.toMatchObject({
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
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths,
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(
        callTool(reg, { query: 'q', filter: { frontmatter: { $where: '...' } } }),
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
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths,
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(callTool(reg, { query: 'q', filter: { tags: ['x'] } })).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
    } finally {
      await cleanup();
    }
  });

  it('deep mode: block evidence comes only from seed notes (within the allowed set)', async () => {
    // Only Resources/a.md is a seed: Resources/b.md is allowed but points away
    // from the query, and Inbox/c.md is on the query vector but filtered out.
    // Each carries a block on the query vector; only the seed's may surface.
    const block = (p: string) => ({
      key: `${p}#h`,
      heading: '#h',
      lines: [1, 2] as [number, number],
      embedding: Float32Array.from([1, 0]),
    });
    const sources = new Map<string, SmartSource>([
      ['Resources/a.md', makeMockSource('Resources/a.md', [1, 0], [block('Resources/a.md')])],
      ['Resources/b.md', makeMockSource('Resources/b.md', [0, 1], [block('Resources/b.md')])],
      ['Inbox/c.md', makeMockSource('Inbox/c.md', [1, 0], [block('Inbox/c.md')])],
    ]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: 'q',
        effort: 'deep',
        filter: { path_prefix: 'Resources/' },
      });

      const withBlocks = result.matches.filter((m) => (m.blocks ?? []).length > 0);
      expect(withBlocks.map((m) => m.path)).toEqual(['Resources/a.md']);
      expect(result.matches.map((m) => m.path)).not.toContain('Inbox/c.md');
    } finally {
      await cleanup();
    }
  });

  it('multi-query merges within filtered subset', async () => {
    // q1 embeds onto a, q2 onto b; c sits on both and only the filter keeps it out.
    const sources = makeSources(['Resources/a.md', 'Resources/b.md', 'Inbox/c.md'], {
      'Resources/a.md': [1, 0],
      'Resources/b.md': [0, 1],
      'Inbox/c.md': [1, 1],
    });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: {
        initialize: vi.fn(),
        embedQuery: vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]),
      },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Resources/a.md', 'Resources/b.md']),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        filter: { path_prefix: 'Resources/' },
      });

      expect(result.matches.map((m) => m.path).sort()).toEqual([
        'Resources/a.md',
        'Resources/b.md',
      ]);
      const byPath = new Map(result.matches.map((m) => [m.path, m]));
      expect(byPath.get('Resources/a.md')?.matched_queries).toEqual(['q1']);
      expect(byPath.get('Resources/b.md')?.matched_queries).toEqual(['q2']);
    } finally {
      await cleanup();
    }
  });

  it('exclude_path_prefix alone is a valid filter', async () => {
    const sources = makeSources(['Live/a.md', 'Live/b.md', 'Archive/c.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(['Live/a.md', 'Live/b.md']),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      const result = await callTool<SearchNotesOutput>(reg, {
        query: 'q',
        filter: { exclude_path_prefix: 'Archive/' },
      });

      expect(result.matches.map((m) => m.path).sort()).toEqual(['Live/a.md', 'Live/b.md']);
    } finally {
      await cleanup();
    }
  });

  // `filter.path_prefix` is declared `.min(1)`, so the gate rejects an empty
  // array before the handler's empty-filter fallback can see it.
  it('rejects an empty path_prefix array at the gate', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(
        callTool(reg, { query: 'q', filter: { path_prefix: [] } }),
      ).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        details: { issues: [{ path: 'filter.path_prefix' }] },
      });
    } finally {
      await cleanup();
    }
  });

  // `filter.exclude_path_prefix` is declared `.min(1)`, so the gate rejects an empty
  // array before the handler's empty-filter fallback can see it.
  it('rejects an empty exclude_path_prefix array at the gate', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(
        callTool(reg, { query: 'q', filter: { exclude_path_prefix: [] } }),
      ).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        details: { issues: [{ path: 'filter.exclude_path_prefix' }] },
      });
    } finally {
      await cleanup();
    }
  });

  it('inputSchema (zod) rejects empty path_prefix array', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = tool.inputSchema.safeParse({ query: 'q', filter: { path_prefix: [] } });
      expect(result.success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('inputSchema (zod) rejects empty exclude_path_prefix array', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const tool = buildSearchNotesTool(deps);

    try {
      const result = tool.inputSchema.safeParse({
        query: 'q',
        filter: { exclude_path_prefix: [] },
      });
      expect(result.success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('handler treats empty path_prefix string as empty filter (INVALID_ARGUMENT)', async () => {
    const { deps, cleanup } = await makeSearchDeps({
      sources: makeSources(['a.md']),
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: 'm',
      listMatchingPaths: async () => new Set(),
    });
    const reg = registerTool(buildSearchNotesTool(deps));

    try {
      await expect(
        callTool(reg, { query: 'q', filter: { path_prefix: '' } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await cleanup();
    }
  });
});
