import { describe, expect, it, vi } from 'vitest';

import {
  computeVaultOverview,
  TOP_TAGS_LIMIT,
  TOP_PROPERTIES_LIMIT,
} from '../../../src/lib/obsidian/vault-overview.js';
import { CONVENTIONS_CHAR_CAP } from '../../../src/lib/obsidian/vault-conventions.js';
import type { ReadNotesItem, VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

const noConventions = async (): Promise<string | null> => null;

function makeReader(overrides: Partial<VaultReader> = {}): VaultReader {
  return {
    readNotes: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/**
 * A reader over an in-memory note map. Tags and properties are derived from
 * what the reader yields, so a snapshot's `top_tags` / `properties` are set up
 * by seeding notes rather than by stubbing an aggregate method.
 */
function readerOver(
  notes: Record<string, { frontmatter?: Record<string, unknown>; content?: string }>,
): VaultReader {
  return {
    scan: vi.fn().mockResolvedValue(Object.keys(notes)),
    readNotes: vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map(
        (p): ReadNotesItem => ({
          path: p,
          frontmatter: notes[p]?.frontmatter ?? {},
          content: notes[p]?.content ?? '',
        }),
      ),
    ),
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

    const result = await computeVaultOverview({ reader, graph, readConventions: noConventions });

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
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, graph, readConventions: noConventions });

    expect(result.total_notes).toBe(4);
    expect(result.folders).toEqual([
      { path: 'Projects', count: 2 },
      { path: '/', count: 1 },
      { path: 'Notes', count: 1 },
    ]);
  });

  it('derives top_tags from the reader', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['ai', 'mcp'] } },
      'b.md': { frontmatter: { tags: ['ai'] }, content: 'body #ai' },
      'c.md': { content: 'body #ai' },
      'd.md': { frontmatter: { tags: ['ai'] } },
      'e.md': { frontmatter: { tags: ['ai', 'mcp'] } },
      'f.md': { content: '#mcp' },
    });

    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.top_tags).toEqual([
      { name: 'ai', count: 5 },
      { name: 'mcp', count: 3 },
    ]);
  });

  it('derives properties from the reader', async () => {
    const notes: Record<string, { frontmatter: Record<string, unknown> }> = {};
    for (let i = 0; i < 10; i += 1) notes[`s${i}.md`] = { frontmatter: { status: 'open' } };
    for (let i = 0; i < 7; i += 1) {
      notes[`t${i}.md`] = { frontmatter: { type: 'note' } };
    }

    const result = await computeVaultOverview({
      reader: readerOver(notes),
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.properties).toEqual([
      { name: 'status', count: 10 },
      { name: 'type', count: 7 },
    ]);
  });

  it('reports tags and properties from the same note together', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['alpha'], status: 'open' }, content: '' },
    });

    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
    // `tags` is itself a frontmatter key, so it counts as a property too.
    expect(result.properties).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
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

    const result = await computeVaultOverview({ reader, graph, readConventions: noConventions });

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

    const result = await computeVaultOverview({ reader, graph, readConventions: noConventions });

    expect(result.top_by_backlinks).toHaveLength(10);
    expect(result.top_by_backlinks[0]).toMatchObject({
      path: 'n14.md',
      backlink_count: 14,
    });
  });

  it('caps top_tags at TOP_TAGS_LIMIT', async () => {
    const manyTags = Array.from({ length: 35 }, (_, i) => `tag${i}`);
    const reader = readerOver({ 'a.md': { frontmatter: { tags: manyTags } } });

    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.top_tags).toHaveLength(TOP_TAGS_LIMIT);
  });

  it('caps properties at TOP_PROPERTIES_LIMIT', async () => {
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 35; i += 1) frontmatter[`prop${i}`] = i;
    const reader = readerOver({ 'a.md': { frontmatter } });

    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.properties).toHaveLength(TOP_PROPERTIES_LIMIT);
  });
});

describe('computeVaultOverview conventions', () => {
  it('carries the conventions file content when present', async () => {
    const result = await computeVaultOverview({
      reader: makeReader(),
      graph: makeGraph(),
      readConventions: async () => '# Conventions\n- No writes to Resources/',
    });
    expect(result.conventions).toBe('# Conventions\n- No writes to Resources/');
    expect(result).not.toHaveProperty('conventions_truncated');
  });

  it('omits the key entirely when there are no conventions', async () => {
    const result = await computeVaultOverview({
      reader: makeReader(),
      graph: makeGraph(),
      readConventions: async () => null,
    });
    expect(result).not.toHaveProperty('conventions');
    expect(result).not.toHaveProperty('conventions_truncated');
  });

  it('trims oversized conventions and flags the trim', async () => {
    const huge = 'x '.repeat(CONVENTIONS_CHAR_CAP);
    const result = await computeVaultOverview({
      reader: makeReader(),
      graph: makeGraph(),
      readConventions: async () => huge,
    });
    expect(result.conventions_truncated).toBe(true);
    expect(result.conventions!.length).toBeLessThanOrEqual(CONVENTIONS_CHAR_CAP + 1);
  });

  it('never fails the snapshot when the conventions read rejects', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['Notes/a.md']) });
    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: async () => {
        throw new Error('EACCES');
      },
    });
    expect(result.total_notes).toBe(1);
    expect(result).not.toHaveProperty('conventions');
  });

  it('re-reads on every call so edits need no restart', async () => {
    let current = 'first';
    const deps = {
      reader: makeReader(),
      graph: makeGraph(),
      readConventions: async () => current,
    };
    expect((await computeVaultOverview(deps)).conventions).toBe('first');
    current = 'second';
    expect((await computeVaultOverview(deps)).conventions).toBe('second');
  });
});
