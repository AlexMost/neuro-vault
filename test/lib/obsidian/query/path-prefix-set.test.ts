import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../../../src/lib/tool-response.js';
import {
  matchesAnyPrefix,
  normalizePrefixList,
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

  it('throws INVALID_FILTER on empty array', async () => {
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
