import { describe, expect, it, vi } from 'vitest';

import { buildQueryNotesTool } from '../../../src/modules/operations/tools/query-notes.js';
import { makeGraph, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

describe('operations.queryNotes handler', () => {
  it('passes the query through runQueryNotes and adds vault to each result item', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md', 'Notes/b.md']),
      readNotes: vi.fn().mockResolvedValue([
        { path: 'Notes/a.md', frontmatter: { type: 'idea', created: '2026-05-12' }, content: '' },
        { path: 'Notes/b.md', frontmatter: { type: 'idea', created: '2026-05-13' }, content: '' },
      ]),
    });
    const graph = makeGraph();
    const registry = makeTestRegistry([{ name: 'v', reader, graph }]);
    const tool = buildQueryNotesTool({ registry });

    const result = await tool.handler({
      filter: { 'frontmatter.type': { $eq: 'idea' } },
    });

    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.results).toHaveLength(2);
    for (const item of result.results) {
      expect(item.vault).toBe('v');
      expect(item.path).toBeDefined();
    }
  });

  it('returns empty results when no notes match', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Notes/a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'Notes/a.md', frontmatter: { type: 'task' }, content: '' }]),
    });
    const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);
    const tool = buildQueryNotesTool({ registry });

    const result = await tool.handler({
      filter: { 'frontmatter.type': { $eq: 'nonexistent' } },
    });

    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});
