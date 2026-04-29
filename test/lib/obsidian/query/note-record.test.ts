import { describe, expect, it } from 'vitest';

import { toNoteRecord } from '../../../../src/lib/obsidian/query/note-record.js';

describe('toNoteRecord', () => {
  it('passes frontmatter through untouched', () => {
    const record = toNoteRecord({
      path: 'a.md',
      frontmatter: { status: 'active', priority: 5, done: false, list: ['x', 'y'] },
      content: 'body',
    });

    expect(record).toEqual({
      path: 'a.md',
      frontmatter: { status: 'active', priority: 5, done: false, list: ['x', 'y'] },
      tags: [],
    });
  });

  it('extracts tags as array, strips leading "#"', () => {
    const record = toNoteRecord({
      path: 'a.md',
      frontmatter: { tags: ['ai', '#mcp', '  #ml  '] },
      content: '',
    });

    expect(record.tags).toEqual(['ai', 'mcp', 'ml']);
  });

  it('coerces a scalar tag into a one-element array', () => {
    const record = toNoteRecord({
      path: 'a.md',
      frontmatter: { tags: 'ai' },
      content: '',
    });

    expect(record.tags).toEqual(['ai']);
  });

  it('returns empty tags when frontmatter has no tags key', () => {
    const record = toNoteRecord({
      path: 'a.md',
      frontmatter: { status: 'todo' },
      content: '',
    });

    expect(record.tags).toEqual([]);
  });

  it('returns empty frontmatter and tags when frontmatter is null', () => {
    const record = toNoteRecord({ path: 'a.md', frontmatter: null, content: '' });

    expect(record).toEqual({ path: 'a.md', frontmatter: {}, tags: [] });
  });

  it('drops null/undefined/empty entries inside the tags array', () => {
    const record = toNoteRecord({
      path: 'a.md',
      frontmatter: { tags: ['ai', '', '  ', null, undefined, '#'] },
      content: '',
    });

    expect(record.tags).toEqual(['ai']);
  });
});
