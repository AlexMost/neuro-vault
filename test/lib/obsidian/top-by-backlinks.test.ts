import { describe, expect, it, vi } from 'vitest';

import { topByBacklinks } from '../../../src/lib/obsidian/top-by-backlinks.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

function makeGraph(overrides: Partial<WikilinkGraphIndex> = {}): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
    ...overrides,
  } as unknown as WikilinkGraphIndex;
}

describe('topByBacklinks', () => {
  it('returns [] for empty paths', () => {
    const graph = makeGraph();
    expect(topByBacklinks({ paths: [], graph, limit: 10 })).toEqual([]);
  });

  it('ranks by backlink count descending, ties broken by path asc', () => {
    const backlinks: Record<string, number> = {
      'Projects/Alpha.md': 5,
      'Projects/Beta.md': 5,
      'Notes/Gamma.md': 1,
      'Notes/Delta.md': 8,
    };
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => backlinks[p] ?? 0),
    });

    const result = topByBacklinks({
      paths: ['Projects/Alpha.md', 'Projects/Beta.md', 'Notes/Gamma.md', 'Notes/Delta.md'],
      graph,
      limit: 10,
    });

    expect(result).toEqual([
      { path: 'Notes/Delta.md', title: 'Delta', backlink_count: 8 },
      { path: 'Projects/Alpha.md', title: 'Alpha', backlink_count: 5 },
      { path: 'Projects/Beta.md', title: 'Beta', backlink_count: 5 },
      { path: 'Notes/Gamma.md', title: 'Gamma', backlink_count: 1 },
    ]);
  });

  it('extracts title from nested path basename without .md extension', () => {
    const graph = makeGraph();
    const result = topByBacklinks({
      paths: ['Folder/Nested/My Note.md'],
      graph,
      limit: 10,
    });
    expect(result[0].title).toBe('My Note');
  });

  it('keeps non-.md paths verbatim as title (basename only)', () => {
    const graph = makeGraph();
    const result = topByBacklinks({
      paths: ['Folder/file.txt'],
      graph,
      limit: 10,
    });
    expect(result[0].title).toBe('file.txt');
  });

  it('slices to limit', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `n${i}.md`);
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => Number(p.replace(/[^0-9]/g, ''))),
    });

    const result = topByBacklinks({ paths, graph, limit: 5 });

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ path: 'n14.md', backlink_count: 14 });
  });

  it('returns [] when limit is 0', () => {
    const graph = makeGraph({
      getBacklinkCount: vi.fn(() => 5),
    });
    const result = topByBacklinks({ paths: ['a.md', 'b.md'], graph, limit: 0 });
    expect(result).toEqual([]);
  });
});
