import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeScanPrefix,
  normalizeVaultPath,
  toPosixSlashes,
} from '../../../src/lib/obsidian/paths.js';

describe('normalizeVaultPath', () => {
  it('returns the path unchanged for a simple POSIX vault path', () => {
    expect(normalizeVaultPath('Folder/note.md')).toBe('Folder/note.md');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVaultPath('  Folder/note.md  ')).toBe('Folder/note.md');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeVaultPath('Folder\\sub\\note.md')).toBe('Folder/sub/note.md');
  });

  it('strips a leading ./', () => {
    expect(normalizeVaultPath('./Folder/note.md')).toBe('Folder/note.md');
  });

  it('collapses redundant ./ segments via path.posix.normalize', () => {
    expect(normalizeVaultPath('Folder/./sub/note.md')).toBe('Folder/sub/note.md');
  });

  it('rejects an empty string', () => {
    expect(() => normalizeVaultPath('')).toThrow(/must not be empty/);
  });

  it('rejects whitespace-only input', () => {
    expect(() => normalizeVaultPath('   ')).toThrow(/must not be empty/);
  });

  it('rejects an absolute POSIX path', () => {
    expect(() => normalizeVaultPath('/abs/path.md')).toThrow(/vault-relative/);
  });

  it('rejects a Windows-drive absolute path', () => {
    expect(() => normalizeVaultPath('C:\\Users\\x.md')).toThrow(/vault-relative/);
  });

  it('rejects parent-traversal segments', () => {
    expect(() => normalizeVaultPath('../escape.md')).toThrow(/vault-relative/);
    expect(() => normalizeVaultPath('a/../b.md')).toThrow(/vault-relative/);
  });

  it('rejects an input that normalizes to "."', () => {
    expect(() => normalizeVaultPath('.')).toThrow(/must not be empty/);
    expect(() => normalizeVaultPath('./')).toThrow(/must not be empty/);
  });

  it('rejects an input that normalizes to absolute', () => {
    expect(() => normalizeVaultPath('/x')).toThrow(/vault-relative/);
  });
});

describe('toPosixSlashes', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosixSlashes('a\\b\\c')).toBe('a/b/c');
  });

  it('returns POSIX paths unchanged', () => {
    expect(toPosixSlashes('a/b/c')).toBe('a/b/c');
  });

  it('does not validate or trim', () => {
    expect(toPosixSlashes('  /absolute  ')).toBe('  /absolute  ');
  });
});

describe('normalizeScanPrefix', () => {
  it('returns empty string for undefined', () => {
    expect(normalizeScanPrefix(undefined)).toBe('');
  });

  it('returns empty string for whitespace, "." and "./"', () => {
    expect(normalizeScanPrefix('')).toBe('');
    expect(normalizeScanPrefix('   ')).toBe('');
    expect(normalizeScanPrefix('.')).toBe('');
    expect(normalizeScanPrefix('./')).toBe('');
  });

  it('strips leading ./ and trailing /', () => {
    expect(normalizeScanPrefix('./Folder/')).toBe('Folder');
    expect(normalizeScanPrefix('Folder/sub/')).toBe('Folder/sub');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeScanPrefix('Folder\\sub')).toBe('Folder/sub');
  });

  it('does not throw on absolute or parent-traversal input (it is a prefix, not a path)', () => {
    expect(normalizeScanPrefix('/abs')).toBe('/abs');
    expect(normalizeScanPrefix('../up')).toBe('../up');
  });
});

describe('integration with node path module', () => {
  it('normalizeVaultPath result is a valid relative path that path.join resolves under a base', () => {
    const out = normalizeVaultPath('Folder/note.md');
    const joined = path.posix.join('/vault', out);
    expect(joined).toBe('/vault/Folder/note.md');
  });
});
