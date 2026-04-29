import { describe, expect, it } from 'vitest';

import { normalizeWikilinkTarget, parseWikilinks } from '../../../src/lib/obsidian/wikilink.js';

describe('parseWikilinks', () => {
  it('parses a single bare link', () => {
    expect(parseWikilinks('see [[Foo]]')).toEqual(['Foo']);
  });

  it('parses heading variants without stripping', () => {
    expect(parseWikilinks('[[Foo#Bar]]')).toEqual(['Foo#Bar']);
  });

  it('parses alias variants without stripping', () => {
    expect(parseWikilinks('[[Foo|Display]]')).toEqual(['Foo|Display']);
  });

  it('parses embed variants', () => {
    expect(parseWikilinks('![[Foo]]')).toEqual(['Foo']);
  });

  it('parses multiple links in order', () => {
    expect(parseWikilinks('a [[X]] then [[Y]] and ![[Z]]')).toEqual(['X', 'Y', 'Z']);
  });

  it('returns empty for no links', () => {
    expect(parseWikilinks('plain text with no links')).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(parseWikilinks('')).toEqual([]);
  });

  it('does not match unmatched [[', () => {
    expect(parseWikilinks('text [[unclosed')).toEqual([]);
  });

  it('does not match links spanning newlines', () => {
    expect(parseWikilinks('[[Foo\nBar]]')).toEqual([]);
  });

  it('handles nested-bracket malformed input without throwing', () => {
    // The regex disallows `[` or `]` inside the link body, so nested
    // brackets simply don't match — that is the correct behavior.
    expect(parseWikilinks('[[a[[b]]c]]')).toEqual(['b']);
  });

  it('handles paths with slashes', () => {
    expect(parseWikilinks('[[Folder/Sub/Note]]')).toEqual(['Folder/Sub/Note']);
  });
});

describe('normalizeWikilinkTarget', () => {
  it('returns the bare target for a plain string', () => {
    expect(normalizeWikilinkTarget('Foo')).toBe('Foo');
  });

  it('strips a #heading suffix', () => {
    expect(normalizeWikilinkTarget('Foo#Bar')).toBe('Foo');
  });

  it('strips a |alias suffix', () => {
    expect(normalizeWikilinkTarget('Foo|Bar')).toBe('Foo');
  });

  it('strips both, preferring the earliest separator', () => {
    expect(normalizeWikilinkTarget('Foo#Bar|Baz')).toBe('Foo');
    expect(normalizeWikilinkTarget('Foo|Bar#Baz')).toBe('Foo');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeWikilinkTarget('  Foo  ')).toBe('Foo');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeWikilinkTarget('')).toBe('');
  });
});
