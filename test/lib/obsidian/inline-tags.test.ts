import { describe, expect, it } from 'vitest';

import { extractInlineTags } from '../../../src/lib/obsidian/inline-tags.js';

const sorted = (body: string): string[] => [...extractInlineTags(body)].sort();

describe('extractInlineTags', () => {
  it('extracts a basic inline tag', () => {
    expect(sorted('body with #alpha here\n')).toEqual(['alpha']);
  });

  it('extracts a tag at start of text', () => {
    expect(sorted('#alpha starts the note\n')).toEqual(['alpha']);
  });

  it('keeps nested tags verbatim', () => {
    expect(sorted('work on #project/alpha today\n')).toEqual(['project/alpha']);
  });

  it('rejects all-numeric tags but accepts mixed ones', () => {
    expect(sorted('issue #123 fixed in #1a and #v2\n')).toEqual(['1a', 'v2']);
  });

  it('requires whitespace or start-of-text before #', () => {
    expect(sorted('x#glued https://example.com/#section [[Note#heading]]\n')).toEqual([]);
  });

  it('ignores tags inside fenced code blocks', () => {
    expect(sorted('```\n#fenced\n```\n\nreal #tag\n')).toEqual(['tag']);
  });

  it('ignores tags inside indented code blocks', () => {
    expect(sorted('para\n\n    #indented code\n\n#real\n')).toEqual(['real']);
  });

  it('ignores tags inside inline code', () => {
    expect(sorted('use `#inline` and #real\n')).toEqual(['real']);
  });

  it('does not treat heading markers as tags, but counts tags in heading text', () => {
    expect(sorted('## Heading\n\n# Title #tagged\n')).toEqual(['tagged']);
  });

  it('stops at trailing punctuation', () => {
    expect(sorted('done #tag., also (#paren)\n')).toEqual(['tag']);
  });

  it('finds tags inside lists and blockquotes', () => {
    expect(sorted('- item #listed\n\n> quote #quoted\n')).toEqual(['listed', 'quoted']);
  });

  it('dedupes within a body', () => {
    expect(sorted('#twice and #twice again\n')).toEqual(['twice']);
  });

  it('returns [] for an empty or tagless body', () => {
    expect(sorted('')).toEqual([]);
    expect(sorted('no tags here\n')).toEqual([]);
  });
});
