import { describe, expect, it, vi } from 'vitest';

import { ToolHandlerError } from '../../../../src/lib/tool-response.js';
import { createListMatchingPaths } from '../../../../src/lib/obsidian/query/list-matching-paths.js';
import type { VaultReader } from '../../../../src/lib/obsidian/vault-reader.js';

function makeReader(notes: Record<string, { frontmatter?: Record<string, unknown> }>): VaultReader {
  const allPaths = Object.keys(notes).sort();
  return {
    scan: vi.fn(async ({ pathPrefix }: { pathPrefix?: string }) => {
      const prefix = pathPrefix ?? '';
      return allPaths.filter((p) => p.startsWith(prefix));
    }),
    readNotes: vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((p) => ({ path: p, frontmatter: notes[p]?.frontmatter ?? {} })),
    ),
  } as unknown as VaultReader;
}

describe('listMatchingPaths', () => {
  it('returns set of paths matching path_prefix only (fast-path: no readNotes calls)', async () => {
    const reader = makeReader({
      'Resources/a.md': {},
      'Resources/b.md': {},
      'Inbox/c.md': {},
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({ path_prefix: 'Resources/' });

    expect([...result].sort()).toEqual(['Resources/a.md', 'Resources/b.md']);
    expect(reader.readNotes).not.toHaveBeenCalled();
  });

  it('matches by tags (ANY-of)', async () => {
    const reader = makeReader({
      'a.md': { frontmatter: { tags: ['trading', 'log'] } },
      'b.md': { frontmatter: { tags: ['journal'] } },
      'c.md': { frontmatter: { tags: ['trading'] } },
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({ tags: ['trading'] });

    expect([...result].sort()).toEqual(['a.md', 'c.md']);
  });

  it('matches by frontmatter sift filter', async () => {
    const reader = makeReader({
      'a.md': { frontmatter: { type: 'reflection' } },
      'b.md': { frontmatter: { type: 'task' } },
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({ frontmatter: { type: 'reflection' } });

    expect([...result]).toEqual(['a.md']);
  });

  it('AND-composes path_prefix + tags + frontmatter', async () => {
    const reader = makeReader({
      'Resources/a.md': { frontmatter: { tags: ['trading'], status: 'active' } },
      'Resources/b.md': { frontmatter: { tags: ['trading'], status: 'archived' } },
      'Inbox/c.md': { frontmatter: { tags: ['trading'], status: 'active' } },
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({
      path_prefix: 'Resources/',
      tags: ['trading'],
      frontmatter: { status: 'active' },
    });

    expect([...result]).toEqual(['Resources/a.md']);
  });

  it('returns empty set when nothing matches', async () => {
    const reader = makeReader({ 'a.md': { frontmatter: { tags: ['x'] } } });
    const list = createListMatchingPaths({ reader });

    const result = await list({ tags: ['nonexistent'] });

    expect(result.size).toBe(0);
  });

  it('rejects empty filter (all fields undefined)', async () => {
    const reader = makeReader({});
    const list = createListMatchingPaths({ reader });

    await expect(list({})).rejects.toThrow(ToolHandlerError);
    await expect(list({})).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('rejects banned operator in frontmatter', async () => {
    const reader = makeReader({});
    const list = createListMatchingPaths({ reader });

    await expect(
      list({ frontmatter: { $where: 'function() { return true; }' } }),
    ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('does not apply runQueryNotes 1000-cap (returns full match set)', async () => {
    const notes: Record<string, { frontmatter: Record<string, unknown> }> = {};
    for (let i = 0; i < 1500; i++) {
      const idx = String(i).padStart(4, '0');
      notes[`Notes/${idx}.md`] = { frontmatter: { tags: ['x'] } };
    }
    const reader = makeReader(notes);
    const list = createListMatchingPaths({ reader });

    const result = await list({ path_prefix: 'Notes/', tags: ['x'] });

    expect(result.size).toBe(1500);
  });

  it('union of multiple include prefixes (fast-path)', async () => {
    const reader = makeReader({
      'Tasks/a.md': {},
      'Reflections/b.md': {},
      'Notes/c.md': {},
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({ path_prefix: ['Tasks/', 'Reflections/'] });

    expect([...result].sort()).toEqual(['Reflections/b.md', 'Tasks/a.md']);
  });

  it('exclude_path_prefix alone is valid and removes the named subtree', async () => {
    const reader = makeReader({
      'Resources/a.md': {},
      'Tasks/b.md': {},
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({ exclude_path_prefix: 'Resources/' });

    expect([...result]).toEqual(['Tasks/b.md']);
  });

  it('include + exclude — exclude wins on overlap', async () => {
    const reader = makeReader({
      'Tasks/active.md': {},
      'Tasks/done/old.md': {},
      'Tasks/done/older.md': {},
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({
      path_prefix: 'Tasks/',
      exclude_path_prefix: 'Tasks/done/',
    });

    expect([...result]).toEqual(['Tasks/active.md']);
  });

  it('general path: multi-prefix include + tags + exclude', async () => {
    const reader = makeReader({
      'A/match.md': { frontmatter: { tags: ['x'] } },
      'A/skip.md': { frontmatter: { tags: ['y'] } },
      'B/match.md': { frontmatter: { tags: ['x'] } },
      'B/excluded/match.md': { frontmatter: { tags: ['x'] } },
      'C/match.md': { frontmatter: { tags: ['x'] } },
    });
    const list = createListMatchingPaths({ reader });

    const result = await list({
      path_prefix: ['A/', 'B/'],
      exclude_path_prefix: ['B/excluded/'],
      tags: ['x'],
    });

    expect([...result].sort()).toEqual(['A/match.md', 'B/match.md']);
  });

  it('rejects empty path_prefix array', async () => {
    const reader = makeReader({});
    const list = createListMatchingPaths({ reader });

    await expect(list({ path_prefix: [] })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('rejects empty exclude_path_prefix array', async () => {
    const reader = makeReader({});
    const list = createListMatchingPaths({ reader });

    await expect(list({ exclude_path_prefix: [] })).rejects.toMatchObject({
      code: 'INVALID_FILTER',
    });
  });
});
