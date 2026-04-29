import { describe, expect, it } from 'vitest';

import { extractWikilinksFromFrontmatter } from '../../../src/lib/obsidian/frontmatter-links.js';

describe('extractWikilinksFromFrontmatter', () => {
  it('returns empty array for empty object', () => {
    expect(extractWikilinksFromFrontmatter({})).toEqual([]);
  });

  it('extracts from a top-level string', () => {
    expect(extractWikilinksFromFrontmatter({ source: '[[X]]' })).toEqual(['X']);
  });

  it('extracts from an array of strings', () => {
    expect(extractWikilinksFromFrontmatter({ related: ['[[A]]', '[[B]]'] })).toEqual(['A', 'B']);
  });

  it('extracts from a nested object', () => {
    expect(extractWikilinksFromFrontmatter({ meta: { parent: '[[P]]' } })).toEqual(['P']);
  });

  it('mixes link and non-link strings', () => {
    expect(extractWikilinksFromFrontmatter({ note: 'no links here', related: '[[A]]' })).toEqual([
      'A',
    ]);
  });

  it('ignores non-string leaves', () => {
    expect(
      extractWikilinksFromFrontmatter({
        count: 5,
        active: true,
        when: null,
        nope: undefined,
      }),
    ).toEqual([]);
  });

  it('extracts multiple links from one string value', () => {
    expect(extractWikilinksFromFrontmatter({ note: '[[A]] and [[B]]' })).toEqual(['A', 'B']);
  });

  it('walks deeply nested structures', () => {
    expect(
      extractWikilinksFromFrontmatter({
        a: { b: { c: ['[[Deep]]', { d: '[[Deeper]]' }] } },
      }),
    ).toEqual(['Deep', 'Deeper']);
  });

  it('handles arrays of mixed types', () => {
    expect(extractWikilinksFromFrontmatter({ tags: ['[[A]]', 5, null, '[[B]]'] })).toEqual([
      'A',
      'B',
    ]);
  });
});
