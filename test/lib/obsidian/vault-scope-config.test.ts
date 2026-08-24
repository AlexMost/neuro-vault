import { describe, expect, it, vi } from 'vitest';

import { loadVaultScope } from '../../../src/lib/obsidian/vault-scope-config.js';

function enoent(): Error {
  const err = new Error('ENOENT') as Error & { code?: string };
  err.code = 'ENOENT';
  return err;
}

/** files: vault-relative posix path → content; anything else throws ENOENT. */
function fakeReadFile(files: Record<string, string>) {
  return vi.fn(async (absPath: string) => {
    const hit = Object.entries(files).find(([rel]) => absPath.endsWith(rel));
    if (!hit) throw enoent();
    return hit[1];
  });
}

describe('loadVaultScope', () => {
  it('builds defaults silently when gitignore and config are both absent', async () => {
    const warn = vi.fn();
    const scope = await loadVaultScope('/v', { readFile: fakeReadFile({}), warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(scope.isExcluded('Projects/x.md')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('layers root gitignore entries into the scope', async () => {
    const readFile = fakeReadFile({
      '.gitignore': 'docs/superpowers/\n!docs/superpowers/keep.md\n',
    });
    const scope = await loadVaultScope('/v', { readFile, warn: vi.fn() });
    expect(scope.isExcluded('docs/superpowers/specs/a.md')).toBe(true);
    expect(scope.isExcluded('docs/superpowers/keep.md')).toBe(true); // negation ignored
  });

  it('unions config exclusions with defaults', async () => {
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: ['Archive/**'] }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn: vi.fn() });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
  });

  it('warns and falls back to defaults on invalid JSON', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({ '.neuro-vault/config.json': '{ not json' });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('/v');
  });

  it('warns and falls back when exclusions is not a string array', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: 'Archive/**' }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Archive/old.md')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns on an unreadable (non-ENOENT) config', async () => {
    const warn = vi.fn();
    const readFile = vi.fn(async (absPath: string) => {
      if (absPath.endsWith('.neuro-vault/config.json')) {
        const err = new Error('EACCES') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      }
      throw enoent();
    });
    await loadVaultScope('/v', { readFile, warn });
    expect(warn).toHaveBeenCalledOnce();
  });
});
