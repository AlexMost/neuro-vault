import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../../../src/lib/tool-response.js';
import { ScanPathNotFoundError } from '../../../../src/lib/obsidian/vault-reader.js';
import {
  matchesAnyPrefix,
  normalizePrefixList,
  rethrowPathNotFoundWithIndex,
} from '../../../../src/lib/obsidian/query/path-prefix-set.js';

describe('normalizePrefixList', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizePrefixList(undefined, 'path_prefix', 'INVALID_FILTER')).toBeUndefined();
  });

  it('normalizes a scalar into a single-element array', () => {
    expect(normalizePrefixList('Tasks/', 'path_prefix', 'INVALID_FILTER')).toEqual(['Tasks']);
  });

  it('normalizes each element of an array', () => {
    expect(
      normalizePrefixList(['Tasks/', './Reflections/'], 'path_prefix', 'INVALID_FILTER'),
    ).toEqual(['Tasks', 'Reflections']);
  });

  it('dedupes after normalization', () => {
    expect(
      normalizePrefixList(['Tasks/', 'Tasks', './Tasks/'], 'path_prefix', 'INVALID_FILTER'),
    ).toEqual(['Tasks']);
  });

  it('throws INVALID_FILTER on empty array', () => {
    expect(() => normalizePrefixList([], 'path_prefix', 'INVALID_FILTER')).toThrow(
      ToolHandlerError,
    );
    try {
      normalizePrefixList([], 'path_prefix', 'INVALID_FILTER');
    } catch (err) {
      expect((err as ToolHandlerError).code).toBe('INVALID_FILTER');
      expect((err as ToolHandlerError).message).toMatch(/path_prefix.*at least one/);
    }
  });

  it('throws INVALID_PARAMS on empty array when requested', () => {
    expect(() => normalizePrefixList([], 'exclude_path_prefix', 'INVALID_PARAMS')).toThrow(
      ToolHandlerError,
    );
    try {
      normalizePrefixList([], 'exclude_path_prefix', 'INVALID_PARAMS');
    } catch (err) {
      expect((err as ToolHandlerError).code).toBe('INVALID_PARAMS');
      expect((err as ToolHandlerError).message).toMatch(/exclude_path_prefix/);
    }
  });

  it('rejects absolute paths via normalizeVaultPathPrefix', () => {
    expect(() => normalizePrefixList(['/abs/path'], 'path_prefix', 'INVALID_FILTER')).toThrow(
      /vault-relative/,
    );
  });

  it('rejects parent-segment paths', () => {
    expect(() => normalizePrefixList(['Tasks/../etc'], 'path_prefix', 'INVALID_FILTER')).toThrow(
      /vault-relative/,
    );
  });

  it('drops empty / dot entries from arrays', () => {
    expect(normalizePrefixList(['Tasks/', '.', ''], 'path_prefix', 'INVALID_FILTER')).toEqual([
      'Tasks',
    ]);
  });

  it('returns undefined when every entry normalizes to undefined', () => {
    expect(normalizePrefixList(['.', ''], 'path_prefix', 'INVALID_FILTER')).toBeUndefined();
  });
});

describe('matchesAnyPrefix', () => {
  it('matches an exact equal path', () => {
    expect(matchesAnyPrefix('Resources', ['Resources'])).toBe(true);
  });

  it('matches with directory boundary', () => {
    expect(matchesAnyPrefix('Resources/foo.md', ['Resources'])).toBe(true);
  });

  it('does NOT match across a directory-name boundary', () => {
    expect(matchesAnyPrefix('Resources-archive/foo.md', ['Resources'])).toBe(false);
  });

  it('matches when any of multiple prefixes match', () => {
    expect(matchesAnyPrefix('Tasks/x.md', ['Resources', 'Tasks'])).toBe(true);
  });

  it('returns false when no prefix matches', () => {
    expect(matchesAnyPrefix('Notes/x.md', ['Resources', 'Tasks'])).toBe(false);
  });

  it('returns false for an empty prefix list', () => {
    expect(matchesAnyPrefix('Resources/x.md', [])).toBe(false);
  });
});

describe('rethrowPathNotFoundWithIndex', () => {
  it('wraps a raw ScanPathNotFoundError into ToolHandlerError on a single-prefix call', () => {
    try {
      rethrowPathNotFoundWithIndex(new ScanPathNotFoundError('Foo/'), 'Foo/', 0, 1);
    } catch (err) {
      expect((err as ToolHandlerError).code).toBe('PATH_NOT_FOUND');
      expect((err as ToolHandlerError).message).toBe('path_prefix not found: Foo/');
      expect((err as ToolHandlerError).details).toBeUndefined();
      return;
    }
    throw new Error('expected throw');
  });

  it('rethrows a wrapped ToolHandlerError unchanged on a single-prefix call', () => {
    const wrapped = new ToolHandlerError('PATH_NOT_FOUND', 'path_prefix not found: Foo/');
    expect(() => rethrowPathNotFoundWithIndex(wrapped, 'Foo/', 0, 1)).toThrow(wrapped);
  });

  it('enriches with path_prefix[i] framing on a multi-prefix call (raw error)', () => {
    try {
      rethrowPathNotFoundWithIndex(new ScanPathNotFoundError('Foo/'), 'Foo/', 1, 3);
    } catch (err) {
      const e = err as ToolHandlerError;
      expect(e.code).toBe('PATH_NOT_FOUND');
      expect(e.message).toBe('path_prefix[1] not found: "Foo/"');
      expect(e.details).toEqual({ path_prefix: 'Foo/', index: 1 });
      return;
    }
    throw new Error('expected throw');
  });

  it('enriches with path_prefix[i] framing on a multi-prefix call (wrapped error)', () => {
    const wrapped = new ToolHandlerError('PATH_NOT_FOUND', 'path_prefix not found: Foo/');
    try {
      rethrowPathNotFoundWithIndex(wrapped, 'Foo/', 2, 4);
    } catch (err) {
      const e = err as ToolHandlerError;
      expect(e.code).toBe('PATH_NOT_FOUND');
      expect(e.message).toBe('path_prefix[2] not found: "Foo/"');
      expect(e.details).toEqual({ path_prefix: 'Foo/', index: 2 });
      return;
    }
    throw new Error('expected throw');
  });

  it('rethrows non-path-not-found errors untouched', () => {
    const other = new Error('boom');
    expect(() => rethrowPathNotFoundWithIndex(other, 'Foo/', 0, 3)).toThrow(other);
  });
});
