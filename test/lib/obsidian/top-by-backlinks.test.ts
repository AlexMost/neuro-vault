import { describe, expect, it } from 'vitest';

import { topByBacklinks } from '../../../src/lib/obsidian/top-by-backlinks.js';

describe('topByBacklinks', () => {
  it('returns [] for empty paths', () => {
    expect(topByBacklinks({ paths: [], counts: [], limit: 10 })).toEqual([]);
  });

  it('ranks by backlink count descending, ties broken by path asc', () => {
    const result = topByBacklinks({
      paths: ['Projects/Alpha.md', 'Projects/Beta.md', 'Notes/Gamma.md', 'Notes/Delta.md'],
      counts: [5, 5, 1, 8],
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
    const result = topByBacklinks({ paths: ['Folder/Nested/My Note.md'], counts: [0], limit: 10 });
    expect(result[0].title).toBe('My Note');
  });

  it('keeps non-.md paths verbatim as title (basename only)', () => {
    const result = topByBacklinks({ paths: ['Folder/file.txt'], counts: [0], limit: 10 });
    expect(result[0].title).toBe('file.txt');
  });

  it('slices to limit', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `n${i}.md`);
    const result = topByBacklinks({ paths, counts: paths.map((_, i) => i), limit: 5 });

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ path: 'n14.md', backlink_count: 14 });
  });

  it('returns [] when limit is 0', () => {
    const result = topByBacklinks({ paths: ['a.md', 'b.md'], counts: [5, 5], limit: 0 });
    expect(result).toEqual([]);
  });
});
