import { describe, expect, it, vi } from 'vitest';

import {
  computeVaultOverview,
  TOP_TAGS_LIMIT,
  TOP_PROPERTIES_LIMIT,
} from '../../../src/lib/obsidian/vault-overview.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { VaultProvider } from '../../../src/lib/obsidian/vault-provider.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

function makeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  return {
    readNotes: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    readDaily: vi.fn().mockResolvedValue({ path: '', frontmatter: null, content: '' }),
    setProperty: vi.fn().mockResolvedValue(undefined),
    readProperty: vi.fn().mockResolvedValue({ value: '' }),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    listProperties: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
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
    const provider = makeProvider();
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, provider, graph });

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
    });
    const provider = makeProvider();
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, provider, graph });

    expect(result.total_notes).toBe(4);
    expect(result.folders).toEqual([
      { path: 'Projects', count: 2 },
      { path: '/', count: 1 },
      { path: 'Notes', count: 1 },
    ]);
  });

  it('passes top_tags through from provider.listTags()', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['a.md', 'b.md']) });
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue([
        { name: 'ai', count: 5 },
        { name: 'mcp', count: 3 },
      ]),
    });

    const result = await computeVaultOverview({ reader, provider, graph: makeGraph() });

    expect(result.top_tags).toEqual([
      { name: 'ai', count: 5 },
      { name: 'mcp', count: 3 },
    ]);
  });

  it('passes properties through from provider.listProperties()', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['a.md']) });
    const provider = makeProvider({
      listProperties: vi.fn().mockResolvedValue([
        { name: 'status', count: 10 },
        { name: 'type', count: 7 },
      ]),
    });

    const result = await computeVaultOverview({ reader, provider, graph: makeGraph() });

    expect(result.properties).toEqual([
      { name: 'status', count: 10 },
      { name: 'type', count: 7 },
    ]);
  });

  it('ranks top-by-backlinks and emits title from basename', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Projects/Alpha.md', 'Projects/Beta.md', 'Notes/Gamma.md']),
    });
    const backlinks: Record<string, number> = {
      'Projects/Alpha.md': 5,
      'Projects/Beta.md': 5,
      'Notes/Gamma.md': 1,
    };
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => backlinks[p] ?? 0),
    });

    const result = await computeVaultOverview({ reader, provider: makeProvider(), graph });

    expect(result.top_by_backlinks).toEqual([
      { path: 'Projects/Alpha.md', title: 'Alpha', backlink_count: 5 },
      { path: 'Projects/Beta.md', title: 'Beta', backlink_count: 5 },
      { path: 'Notes/Gamma.md', title: 'Gamma', backlink_count: 1 },
    ]);
  });

  it('caps top_by_backlinks at TOP_BACKLINKS_LIMIT', async () => {
    const paths = Array.from({ length: 15 }, (_, i) => `n${i}.md`);
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(paths),
    });
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => Number(p.replace(/[^0-9]/g, ''))),
    });

    const result = await computeVaultOverview({ reader, provider: makeProvider(), graph });

    expect(result.top_by_backlinks).toHaveLength(10);
    expect(result.top_by_backlinks[0]).toMatchObject({
      path: 'n14.md',
      backlink_count: 14,
    });
  });

  it('caps top_tags at TOP_TAGS_LIMIT', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['a.md']) });
    const manyTags = Array.from({ length: 35 }, (_, i) => ({ name: `tag${i}`, count: 35 - i }));
    const provider = makeProvider({
      listTags: vi.fn().mockResolvedValue(manyTags),
    });

    const result = await computeVaultOverview({ reader, provider, graph: makeGraph() });

    expect(result.top_tags).toHaveLength(TOP_TAGS_LIMIT);
  });

  it('caps properties at TOP_PROPERTIES_LIMIT', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['a.md']) });
    const manyProps = Array.from({ length: 35 }, (_, i) => ({
      name: `prop${i}`,
      count: 35 - i,
    }));
    const provider = makeProvider({
      listProperties: vi.fn().mockResolvedValue(manyProps),
    });

    const result = await computeVaultOverview({ reader, provider, graph: makeGraph() });

    expect(result.properties).toHaveLength(TOP_PROPERTIES_LIMIT);
  });
});
