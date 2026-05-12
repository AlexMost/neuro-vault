import { describe, expect, it, vi } from 'vitest';

import { computeVaultOverview } from '../../../src/lib/obsidian/vault-overview.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

function makeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  return {
    readNotes: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeGraph(overrides: Partial<WikilinkGraphIndex> = {}): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
    ...overrides,
  } as unknown as WikilinkGraphIndex;
}

describe('computeVaultOverview', () => {
  it('returns zeroed snapshot for an empty vault', async () => {
    const reader = makeReader();
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, graph });

    expect(result).toEqual({
      total_notes: 0,
      folders: [],
      top_tags: [],
      properties: [],
      top_by_backlinks: [],
    });
    expect(graph.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('aggregates folders by top-level segment (root → "/")', async () => {
    const reader = makeReader({
      scan: vi
        .fn()
        .mockResolvedValue(['Projects/a.md', 'Projects/sub/b.md', 'Notes/c.md', 'root.md']),
      readNotes: vi.fn().mockResolvedValue([
        { path: 'Projects/a.md', frontmatter: {}, content: '' },
        { path: 'Projects/sub/b.md', frontmatter: {}, content: '' },
        { path: 'Notes/c.md', frontmatter: {}, content: '' },
        { path: 'root.md', frontmatter: {}, content: '' },
      ]),
    });
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, graph });

    expect(result.total_notes).toBe(4);
    expect(result.folders).toEqual([
      { path: 'Projects', count: 2 },
      { path: '/', count: 1 },
      { path: 'Notes', count: 1 },
    ]);
  });

  it('counts frontmatter tags (array and single-string forms)', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md', 'b.md', 'c.md']),
      readNotes: vi.fn().mockResolvedValue([
        { path: 'a.md', frontmatter: { tags: ['ai', 'mcp'] }, content: '' },
        { path: 'b.md', frontmatter: { tags: 'ai' }, content: '' },
        { path: 'c.md', frontmatter: { tags: ['#mcp', null] }, content: '' },
      ]),
    });

    const result = await computeVaultOverview({ reader, graph: makeGraph() });

    expect(result.top_tags).toEqual([
      { name: 'ai', count: 2 },
      { name: 'mcp', count: 2 },
    ]);
  });

  it('infers property types across notes', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md', 'b.md', 'c.md']),
      readNotes: vi.fn().mockResolvedValue([
        {
          path: 'a.md',
          frontmatter: {
            status: 'todo',
            priority: 3,
            created: '2026-05-12',
            due: new Date('2026-06-01'),
            tags: ['ai'],
            extras: null,
          },
          content: '',
        },
        {
          path: 'b.md',
          frontmatter: { status: 'done', priority: 1, mixed: 42 },
          content: '',
        },
        { path: 'c.md', frontmatter: { mixed: 'hello' }, content: '' },
      ]),
    });

    const result = await computeVaultOverview({ reader, graph: makeGraph() });

    const byName = new Map(result.properties.map((p) => [p.name, p]));
    expect(byName.get('status')).toEqual({ name: 'status', count: 2, types: ['string'] });
    expect(byName.get('priority')).toEqual({ name: 'priority', count: 2, types: ['number'] });
    expect(byName.get('created')).toEqual({ name: 'created', count: 1, types: ['date'] });
    expect(byName.get('due')).toEqual({ name: 'due', count: 1, types: ['date'] });
    expect(byName.get('tags')).toEqual({ name: 'tags', count: 1, types: ['list'] });
    expect(byName.get('extras')).toEqual({ name: 'extras', count: 1, types: ['null'] });
    expect(byName.get('mixed')).toEqual({ name: 'mixed', count: 2, types: ['number', 'string'] });
  });

  it('ranks top-by-backlinks and emits title from basename + optional type', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Projects/Alpha.md', 'Projects/Beta.md', 'Notes/Gamma.md']),
      readNotes: vi.fn().mockResolvedValue([
        {
          path: 'Projects/Alpha.md',
          frontmatter: { type: 'project' },
          content: '',
        },
        { path: 'Projects/Beta.md', frontmatter: {}, content: '' },
        { path: 'Notes/Gamma.md', frontmatter: { type: 42 }, content: '' },
      ]),
    });
    const backlinks: Record<string, number> = {
      'Projects/Alpha.md': 5,
      'Projects/Beta.md': 5,
      'Notes/Gamma.md': 1,
    };
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => backlinks[p] ?? 0),
    });

    const result = await computeVaultOverview({ reader, graph });

    expect(result.top_by_backlinks).toEqual([
      {
        path: 'Projects/Alpha.md',
        title: 'Alpha',
        backlink_count: 5,
        type: 'project',
      },
      { path: 'Projects/Beta.md', title: 'Beta', backlink_count: 5 },
      { path: 'Notes/Gamma.md', title: 'Gamma', backlink_count: 1 },
    ]);
  });

  it('skips notes that fail to read', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['ok.md', 'bad.md']),
      readNotes: vi.fn().mockResolvedValue([
        { path: 'ok.md', frontmatter: { tags: ['x'] }, content: '' },
        {
          path: 'bad.md',
          error: { code: 'READ_FAILED', message: 'boom' },
        },
      ]),
    });

    const result = await computeVaultOverview({ reader, graph: makeGraph() });

    expect(result.total_notes).toBe(1);
    expect(result.top_tags).toEqual([{ name: 'x', count: 1 }]);
  });

  it('caps top_by_backlinks at TOP_BACKLINKS_LIMIT', async () => {
    const paths = Array.from({ length: 15 }, (_, i) => `n${i}.md`);
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(paths),
      readNotes: vi
        .fn()
        .mockResolvedValue(paths.map((p) => ({ path: p, frontmatter: {}, content: '' }))),
    });
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => Number(p.replace(/[^0-9]/g, ''))),
    });

    const result = await computeVaultOverview({ reader, graph });

    expect(result.top_by_backlinks).toHaveLength(10);
    expect(result.top_by_backlinks[0]).toMatchObject({
      path: 'n14.md',
      backlink_count: 14,
    });
  });
});
