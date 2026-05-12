import { describe, expect, it, vi } from 'vitest';

import { buildReadDailyTool } from '../../../src/modules/operations/tools/read-daily.js';
import type { QueryNotesResult } from '../../../src/lib/obsidian/query/types.js';
import { makeGraph, makeProvider, makeReader } from './_helpers.js';

function makeRunQuery(result: QueryNotesResult) {
  return vi.fn().mockResolvedValue(result);
}

function emptyQueryResult(): QueryNotesResult {
  return { results: [], count: 0, truncated: false };
}

describe('operations.readDaily handler', () => {
  it('forwards to provider.readDaily and returns daily fields unchanged', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: 'today' }),
    });
    const reader = makeReader();
    const graph = makeGraph();
    const runQuery = makeRunQuery(emptyQueryResult());

    const tool = buildReadDailyTool({ provider, reader, graph, runQuery });
    const result = await tool.handler({});

    expect(provider.readDaily).toHaveBeenCalledTimes(1);
    expect(result.path).toBe('Daily/2026-05-12.md');
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe('today');
  });

  it('returns notes_today: [] when no notes were created today', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: '' }),
    });
    const runQuery = makeRunQuery(emptyQueryResult());

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    const result = await tool.handler({});

    expect(result.notes_today).toEqual([]);
  });

  it('builds a filter using the date from the daily-note basename and excludes type: daily', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: '' }),
    });
    const runQuery = makeRunQuery(emptyQueryResult());

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    await tool.handler({});

    expect(runQuery).toHaveBeenCalledTimes(1);
    const [input] = runQuery.mock.calls[0];
    expect(input).toMatchObject({
      filter: {
        'frontmatter.created': { $regex: '^2026-05-12' },
        'frontmatter.type': { $ne: 'daily' },
      },
      sort: { field: 'path', order: 'asc' },
      limit: 200,
    });
  });

  it('falls back to the local date when the basename is not YYYY-MM-DD', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/unusual-name.md', frontmatter: null, content: '' }),
    });
    const runQuery = makeRunQuery(emptyQueryResult());

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    await tool.handler({});

    const [input] = runQuery.mock.calls[0];
    const regex = (input.filter as { 'frontmatter.created': { $regex: string } })[
      'frontmatter.created'
    ].$regex;
    expect(regex).toMatch(/^\^\d{4}-\d{2}-\d{2}$/);
  });

  it('projects query results to { path, frontmatter, backlink_count } and drops tags/content', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: '' }),
    });
    const runQuery = makeRunQuery({
      results: [
        {
          path: 'Reflections/morning.md',
          frontmatter: { created: '2026-05-12', type: 'reflection' },
          backlink_count: 2,
          content: 'should be dropped',
        } as unknown as QueryNotesResult['results'][number],
        {
          path: 'Tasks/buy-milk.md',
          frontmatter: { created: '2026-05-12', type: 'task' },
          backlink_count: 0,
        },
      ],
      count: 2,
      truncated: false,
    });

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    const result = await tool.handler({});

    expect(result.notes_today).toEqual([
      {
        path: 'Reflections/morning.md',
        frontmatter: { created: '2026-05-12', type: 'reflection' },
        backlink_count: 2,
      },
      {
        path: 'Tasks/buy-milk.md',
        frontmatter: { created: '2026-05-12', type: 'task' },
        backlink_count: 0,
      },
    ]);
    for (const item of result.notes_today) {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('tags');
    }
  });

  it('passes through whatever order the query engine returned (sort handled by engine)', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: '' }),
    });
    const runQuery = makeRunQuery({
      results: [
        { path: 'A.md', frontmatter: { created: '2026-05-12' }, backlink_count: 0 },
        { path: 'B.md', frontmatter: { created: '2026-05-12' }, backlink_count: 0 },
        { path: 'C.md', frontmatter: { created: '2026-05-12' }, backlink_count: 0 },
      ],
      count: 3,
      truncated: false,
    });

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    const result = await tool.handler({});

    expect(result.notes_today.map((n) => n.path)).toEqual(['A.md', 'B.md', 'C.md']);
  });

  it('caps notes_today at 200 entries silently when the engine returns more', async () => {
    const provider = makeProvider({
      readDaily: vi
        .fn()
        .mockResolvedValue({ path: 'Daily/2026-05-12.md', frontmatter: null, content: '' }),
    });
    const oversized = Array.from({ length: 201 }, (_, i) => ({
      path: `Notes/${String(i).padStart(3, '0')}.md`,
      frontmatter: { created: '2026-05-12' },
      backlink_count: 0,
    }));
    const runQuery = makeRunQuery({
      results: oversized,
      count: oversized.length,
      truncated: true,
    });

    const tool = buildReadDailyTool({
      provider,
      reader: makeReader(),
      graph: makeGraph(),
      runQuery,
    });
    const result = await tool.handler({});

    expect(result.notes_today.length).toBe(200);
    expect(result.notes_today[0].path).toBe('Notes/000.md');
    expect(result.notes_today[199].path).toBe('Notes/199.md');
  });
});
