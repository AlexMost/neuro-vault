import { describe, expect, it, vi } from 'vitest';

import {
  configExclusionsToPatterns,
  createVaultScope,
  gitignoreLinesToPatterns,
} from '../../../src/lib/obsidian/vault-scope.js';

describe('gitignoreLinesToPatterns', () => {
  it('skips blank, comment, and negation lines', () => {
    const lines = ['', '# a comment', '!build/keep.md', 'build/', '  '];
    expect(gitignoreLinesToPatterns(lines)).toEqual(['build', 'build/**']);
  });

  it('strips leading and trailing slashes and excludes the subtree', () => {
    expect(gitignoreLinesToPatterns(['/dist/'])).toEqual(['dist', 'dist/**']);
  });
});

describe('configExclusionsToPatterns', () => {
  it('expands an entry that names a path to the path plus its subtree', () => {
    expect(configExclusionsToPatterns(['Archive'])).toEqual(['Archive', 'Archive/**']);
    expect(configExclusionsToPatterns(['**/drafts'])).toEqual(['**/drafts', '**/drafts/**']);
    expect(configExclusionsToPatterns(['a/b'])).toEqual(['a/b', 'a/b/**']);
  });

  it('strips a trailing slash like a gitignore entry', () => {
    expect(configExclusionsToPatterns(['Archive/'])).toEqual(['Archive', 'Archive/**']);
  });

  it('leaves entries whose last segment is a wildcard untouched', () => {
    const entries = ['Archive/**', '**/*.excalidraw.md', '*.md', 'Archive/*', '**'];
    expect(configExclusionsToPatterns(entries)).toEqual(entries);
  });

  it('does not duplicate a subtree the user already spelled out', () => {
    expect(configExclusionsToPatterns(['Archive', 'Archive/**'])).toEqual([
      'Archive',
      'Archive/**',
    ]);
  });

  it('passes unusable entries through for the caller to drop', () => {
    expect(configExclusionsToPatterns(['', '!Keep'])).toEqual(['', '!Keep']);
  });
});

describe('createVaultScope', () => {
  it('always excludes dot-segment paths, regardless of configuration', () => {
    const scope = createVaultScope();
    expect(scope.isExcluded('.obsidian/workspace.md')).toBe(true);
    expect(scope.isExcluded('.neuro-vault/eval/golden.md')).toBe(true);
    expect(scope.isExcluded('sub/.trash/x.md')).toBe(true);
    expect(scope.isExcluded('Projects/x.md')).toBe(false);
  });

  it('excludes Templates/ by default', () => {
    const scope = createVaultScope();
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(scope.isExcluded('Templates.md')).toBe(false);
  });

  it('excludes gitignore entries and their subtrees', () => {
    const scope = createVaultScope({ gitignoreLines: ['docs/superpowers/'] });
    expect(scope.isExcluded('docs/superpowers/specs/a.md')).toBe(true);
    expect(scope.isExcluded('docs/other.md')).toBe(false);
  });

  it('ignores negation lines (the negated path stays excluded)', () => {
    const scope = createVaultScope({ gitignoreLines: ['build/', '!build/keep.md'] });
    expect(scope.isExcluded('build/keep.md')).toBe(true);
  });

  it('unions config globs with the defaults', () => {
    const scope = createVaultScope({ configExclusions: ['Archive/**'] });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true); // default survives
  });

  it('treats a bare config entry as a path: the named subtree is excluded', () => {
    const scope = createVaultScope({ configExclusions: ['Archive', '**/drafts'] });
    expect(scope.isExcluded('Archive')).toBe(true);
    expect(scope.isExcluded('Archive/a.md')).toBe(true);
    expect(scope.isExcluded('Archive/deep/a.md')).toBe(true);
    expect(scope.isExcluded('drafts/a.md')).toBe(true);
    expect(scope.isExcluded('Projects/drafts/a.md')).toBe(true);
    expect(scope.isExcluded('Archive2/a.md')).toBe(false);
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
  });

  it('feeds the subtree pattern to ignorePatterns too, so the glob prune matches the predicate', () => {
    const scope = createVaultScope({ configExclusions: ['Archive'] });
    expect(scope.ignorePatterns).toEqual(expect.arrayContaining(['Archive', 'Archive/**']));
  });

  it('never throws on an empty config exclusion, and ignores it', () => {
    // picomatch throws "Expected pattern to be a non-empty string" on '';
    // the throw would escape loadVaultScope and reject VaultRegistry.create.
    const scope = createVaultScope({ configExclusions: ['', '   ', 'Archive/**'] });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
    expect(scope.ignorePatterns).not.toContain('');
  });

  it('drops negated config exclusions instead of inverting membership', () => {
    // picomatch reads a leading '!' as its own negation operator, which would
    // flip the whole predicate; union-only is the contract (design D2).
    const scope = createVaultScope({ configExclusions: ['!Keep/**'] });
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
    expect(scope.isExcluded('Keep/a.md')).toBe(false);
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true); // defaults survive
  });

  it('warns when a gitignore entry compiles to a catch-all', () => {
    const warn = vi.fn();
    const scope = createVaultScope({ gitignoreLines: ['*', '!Notes/'], warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('*');
    expect(scope.isExcluded('Notes/a.md')).toBe(true); // documented hazard, not fixed
  });

  it('does not warn for an ordinary gitignore', () => {
    const warn = vi.fn();
    createVaultScope({ gitignoreLines: ['docs/superpowers/', '# comment', ''], warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('is usable without a warn callback when a catch-all is present', () => {
    expect(() => createVaultScope({ gitignoreLines: ['**'] })).not.toThrow();
  });

  it('exposes the same membership via ignorePatterns', () => {
    // Agreement between the two views (spec vault-scope R1): every pattern-
    // excluded path is predicate-excluded; the dot rule is predicate-only
    // because enumeration already runs with dot: false.
    const scope = createVaultScope({ configExclusions: ['Archive/**'] });
    expect(scope.ignorePatterns).toEqual(
      expect.arrayContaining(['Templates', 'Templates/**', 'Archive/**']),
    );
  });
});

describe('isSubtreeExcluded', () => {
  it('prunes only provable subtrees', () => {
    const scope = createVaultScope({
      gitignoreLines: ['build'],
      configExclusions: ['Archive', 'Drafts/*', '**/private/**'],
    });
    const cases: Array<[string, boolean]> = [
      ['', false],
      ['.obsidian', true],
      ['Notes/.trash', true],
      ['Templates', true],
      ['Templates/Daily', true],
      ['build', true],
      ['Archive', true],
      ['Archive/2024', true],
      // `Drafts/*` excludes the files directly under Drafts, not deeper ones, so
      // neither the directory nor a child directory is a provable subtree.
      ['Drafts', false],
      ['Drafts/x', false],
      ['a/private', true],
      ['Notes', false],
    ];
    for (const [dir, expected] of cases) {
      expect([dir, scope.isSubtreeExcluded(dir)]).toEqual([dir, expected]);
    }
  });
});
