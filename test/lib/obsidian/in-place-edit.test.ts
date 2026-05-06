import { describe, expect, it } from 'vitest';

import { applyReplace, splitRawFrontmatter } from '../../../src/lib/obsidian/in-place-edit.js';

describe('splitRawFrontmatter', () => {
  it('splits a note with frontmatter, preserving the closing fence and its newline', () => {
    const raw = '---\ntype: note\ntags: [a, b]\n---\nbody line 1\nbody line 2\n';
    expect(splitRawFrontmatter(raw)).toEqual({
      prefix: '---\ntype: note\ntags: [a, b]\n---\n',
      body: 'body line 1\nbody line 2\n',
    });
  });

  it('returns empty prefix when the note has no frontmatter', () => {
    const raw = 'just a body\nwith two lines\n';
    expect(splitRawFrontmatter(raw)).toEqual({ prefix: '', body: raw });
  });

  it('treats malformed frontmatter (no closing fence) as no frontmatter', () => {
    const raw = '---\ntype: note\nbody never closes\n';
    expect(splitRawFrontmatter(raw)).toEqual({ prefix: '', body: raw });
  });

  it('handles an empty file', () => {
    expect(splitRawFrontmatter('')).toEqual({ prefix: '', body: '' });
  });

  it('handles an empty frontmatter block', () => {
    const raw = '---\n---\nbody\n';
    expect(splitRawFrontmatter(raw)).toEqual({
      prefix: '---\n---\n',
      body: 'body\n',
    });
  });

  it('preserves CRLF inside frontmatter when present', () => {
    const raw = '---\r\ntype: note\r\n---\r\nbody\n';
    expect(splitRawFrontmatter(raw)).toEqual({
      prefix: '---\r\ntype: note\r\n---\r\n',
      body: 'body\n',
    });
  });
});

describe('applyReplace', () => {
  it('replaces a single occurrence', () => {
    const body = 'first line\nfind me here\nlast line\n';
    expect(applyReplace(body, 'find me', 'changed')).toEqual({
      body: 'first line\nchanged here\nlast line\n',
    });
  });

  it('returns NOT_FOUND when find text is absent', () => {
    const body = 'no match here\n';
    expect(applyReplace(body, 'xxx', 'yyy')).toEqual({ error: 'NOT_FOUND' });
  });

  it('returns AMBIGUOUS_MATCH with 1-based line numbers when multiple matches', () => {
    const body = 'foo here\nand foo again\nfoo on third line\n';
    expect(applyReplace(body, 'foo', 'bar')).toEqual({
      error: 'AMBIGUOUS_MATCH',
      lines: [1, 2, 3],
    });
  });

  it('allows empty replacement (deletes matched text)', () => {
    const body = 'keep [delete this] keep';
    expect(applyReplace(body, '[delete this] ', '')).toEqual({ body: 'keep keep' });
  });

  it('treats whitespace-sensitive matches strictly', () => {
    const body = 'hello  world\n';
    expect(applyReplace(body, 'hello world', 'x')).toEqual({ error: 'NOT_FOUND' });
  });

  it('reports correct line numbers when the find spans a substring inside a longer line', () => {
    const body = 'aaa\nzz foo zz\nbar\nfoo at start';
    expect(applyReplace(body, 'foo', 'X')).toEqual({
      error: 'AMBIGUOUS_MATCH',
      lines: [2, 4],
    });
  });

  it('inserts the replacement verbatim, not interpreted as a regex pattern', () => {
    const body = 'unique anchor here';
    expect(applyReplace(body, 'unique anchor', '$$$&')).toEqual({
      body: '$$$& here',
    });
  });
});
