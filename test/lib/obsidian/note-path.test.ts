import { describe, expect, it } from 'vitest';

import { normalizeNotePath } from '../../../src/lib/obsidian/note-path.js';

describe('normalizeNotePath', () => {
  it('appends .md when the final segment has no extension', () => {
    expect(normalizeNotePath('Foo')).toBe('Foo.md');
  });

  it('is idempotent when .md is already present', () => {
    expect(normalizeNotePath('Foo.md')).toBe('Foo.md');
  });

  it('only promotes the final segment, not earlier ones', () => {
    expect(normalizeNotePath('Tasks/Foo')).toBe('Tasks/Foo.md');
    expect(normalizeNotePath('Tasks/Foo.md')).toBe('Tasks/Foo.md');
  });

  it('preserves a non-.md extension on the final segment', () => {
    expect(normalizeNotePath('Tasks/Foo.bar')).toBe('Tasks/Foo.bar');
    expect(normalizeNotePath('Foo.txt')).toBe('Foo.txt');
  });

  it('preserves dotted segments earlier in the path', () => {
    expect(normalizeNotePath('A.B/Foo')).toBe('A.B/Foo.md');
  });

  it('preserves multi-dot final segments (extension already there)', () => {
    expect(normalizeNotePath('Tasks/Foo.bar.baz')).toBe('Tasks/Foo.bar.baz');
  });

  it('handles leading ./ by stripping then promoting', () => {
    expect(normalizeNotePath('./Foo')).toBe('Foo.md');
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeNotePath('  Foo  ')).toBe('Foo.md');
  });

  it('rejects empty / whitespace input via normalizeVaultPath', () => {
    expect(() => normalizeNotePath('')).toThrow(/must not be empty/);
    expect(() => normalizeNotePath('   ')).toThrow(/must not be empty/);
    expect(() => normalizeNotePath('.')).toThrow(/must not be empty/);
    expect(() => normalizeNotePath('./')).toThrow(/must not be empty/);
  });

  it('rejects absolute paths via normalizeVaultPath', () => {
    expect(() => normalizeNotePath('/abs/Foo')).toThrow(/vault-relative/);
    expect(() => normalizeNotePath('C:\\Users\\x')).toThrow(/vault-relative/);
  });

  it('rejects parent traversal via normalizeVaultPath', () => {
    expect(() => normalizeNotePath('../escape')).toThrow(/vault-relative/);
    expect(() => normalizeNotePath('a/../b')).toThrow(/vault-relative/);
  });

  it('treats segments ending in a dot as having no extension', () => {
    // path.extname('Foo.') returns '.', which we treat as "no real extension":
    // promote to ".md" — otherwise "Foo." would mean a literal file with no
    // extension, which is not what users mean.
    expect(normalizeNotePath('Foo.')).toBe('Foo..md');
  });
});
