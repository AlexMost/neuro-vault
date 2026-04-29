import { describe, expect, it } from 'vitest';

import { buildBasenameIndex } from '../../../src/lib/obsidian/link-resolver.js';

describe('buildBasenameIndex', () => {
  it('resolves an exact path-form target', () => {
    const idx = buildBasenameIndex(['Folder/X.md', 'Folder/Y.md']);
    expect(idx.resolve('Folder/X')).toBe('Folder/X.md');
  });

  it('resolves a basename target with single match', () => {
    const idx = buildBasenameIndex(['Folder/X.md', 'Folder/Y.md']);
    expect(idx.resolve('X')).toBe('Folder/X.md');
  });

  it('returns lexicographically smallest path on basename collision', () => {
    const idx = buildBasenameIndex(['Z/X.md', 'A/X.md', 'M/X.md']);
    expect(idx.resolve('X')).toBe('A/X.md');
  });

  it('returns null for unknown basename', () => {
    const idx = buildBasenameIndex(['Folder/X.md']);
    expect(idx.resolve('Missing')).toBeNull();
  });

  it('returns null for unknown path-form target', () => {
    const idx = buildBasenameIndex(['Folder/X.md']);
    expect(idx.resolve('Other/Y')).toBeNull();
  });

  it('returns null when source set is empty', () => {
    const idx = buildBasenameIndex([]);
    expect(idx.resolve('Anything')).toBeNull();
  });

  it('returns null for empty target', () => {
    const idx = buildBasenameIndex(['Folder/X.md']);
    expect(idx.resolve('')).toBeNull();
  });

  it('matches basename when target has no .md suffix', () => {
    const idx = buildBasenameIndex(['A/Foo.md']);
    expect(idx.resolve('Foo')).toBe('A/Foo.md');
  });

  it('matches path-form targets without .md suffix', () => {
    const idx = buildBasenameIndex(['A/Foo.md']);
    expect(idx.resolve('A/Foo')).toBe('A/Foo.md');
  });

  it('matches a target that already includes .md', () => {
    const idx = buildBasenameIndex(['A/Foo.md']);
    expect(idx.resolve('A/Foo.md')).toBe('A/Foo.md');
    expect(idx.resolve('Foo.md')).toBe('A/Foo.md');
  });

  it('treats targets containing a slash as path-form (no basename fallback)', () => {
    // "Other/Foo" must not fall back to "A/Foo.md" by basename.
    const idx = buildBasenameIndex(['A/Foo.md']);
    expect(idx.resolve('Other/Foo')).toBeNull();
  });
});
