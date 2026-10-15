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

  describe('suffix resolution for path-form targets', () => {
    it('resolves a path-form target by unique suffix when no exact path exists', () => {
      // Obsidian resolves `[[Teams/_index]]` written inside `GrowPM/` to
      // `GrowPM/Teams/_index.md` when the vault root holds no `Teams/_index.md`.
      const idx = buildBasenameIndex(['GrowPM/Teams/_index.md', 'GrowPM/Teams/team-growth.md']);
      expect(idx.resolve('Teams/_index')).toBe('GrowPM/Teams/_index.md');
      expect(idx.resolveAll('Teams/_index')).toEqual(['GrowPM/Teams/_index.md']);
    });

    it('matches a deeper suffix too', () => {
      const idx = buildBasenameIndex(['Org/Products/Shop/Metrics/_index.md']);
      expect(idx.resolve('Shop/Metrics/_index')).toBe('Org/Products/Shop/Metrics/_index.md');
      expect(idx.resolve('Products/Shop/Metrics/_index')).toBe(
        'Org/Products/Shop/Metrics/_index.md',
      );
    });

    it('accepts a .md suffix on the target', () => {
      const idx = buildBasenameIndex(['GrowPM/Teams/_index.md']);
      expect(idx.resolve('Teams/_index.md')).toBe('GrowPM/Teams/_index.md');
    });

    it('prefers an exact path over a suffix match', () => {
      const idx = buildBasenameIndex(['Teams/_index.md', 'GrowPM/Teams/_index.md']);
      expect(idx.resolve('Teams/_index')).toBe('Teams/_index.md');
      expect(idx.resolveAll('Teams/_index')).toEqual(['Teams/_index.md']);
    });

    it('leaves an ambiguous suffix unresolved while listing the candidates', () => {
      const idx = buildBasenameIndex(['Legacy/Teams/_index.md', 'GrowPM/Teams/_index.md']);
      expect(idx.resolve('Teams/_index')).toBeNull();
      expect(idx.resolveAll('Teams/_index')).toEqual([
        'GrowPM/Teams/_index.md',
        'Legacy/Teams/_index.md',
      ]);
    });

    it('matches whole segments only, never a partial folder name', () => {
      const idx = buildBasenameIndex(['GrowPM/SubTeams/_index.md']);
      expect(idx.resolve('Teams/_index')).toBeNull();
    });

    it('does not let a suffix match a bare basename target', () => {
      // `[[_index]]` stays a basename lookup; suffix matching is path-form only.
      const idx = buildBasenameIndex(['A/Teams/_index.md', 'B/People/_index.md']);
      expect(idx.resolve('_index')).toBe('A/Teams/_index.md');
      expect(idx.resolveAll('_index')).toEqual(['A/Teams/_index.md', 'B/People/_index.md']);
    });
  });
});
