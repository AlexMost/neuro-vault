import { describe, expect, it } from 'vitest';

import { splitRawFrontmatter } from '../../../src/lib/obsidian/in-place-edit.js';

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
