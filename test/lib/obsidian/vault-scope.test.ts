import { describe, expect, it, vi } from 'vitest';

import {
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
