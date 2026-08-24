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

  it('warns and falls back when the config is a JSON array, not an object', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify(['Archive/**']),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Archive/old.md')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('/v');
    expect(warn.mock.calls[0][0]).not.toContain('invalid JSON');
  });

  it('warns and falls back when the config is a bare JSON string', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify('Archive/**'),
    });
    await loadVaultScope('/v', { readFile, warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain('invalid JSON');
  });

  it('stays silent for a valid object config without an "exclusions" key', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ other: 1 }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops an empty exclusion entry, warns, and still starts', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: [''] }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('/v');
  });

  it('drops a negated exclusion entry instead of inverting membership', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: ['!Keep/**'] }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
    expect(scope.isExcluded('Keep/a.md')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('!Keep/**');
  });

  it('keeps the valid entries of a mixed exclusions list', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: ['Archive/**', '', '!Keep/**'] }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Keep/a.md')).toBe(false);
    expect(scope.isExcluded('Projects/a.md')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('warns on an unreadable (non-ENOENT) .gitignore instead of silently widening scope', async () => {
    const warn = vi.fn();
    const readFile = vi.fn(async (absPath: string) => {
      if (absPath.endsWith('.gitignore')) {
        const err = new Error('EACCES') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      }
      throw enoent();
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('.gitignore');
    expect(warn.mock.calls[0][0]).toContain('/v');
  });

  it('stays silent when .gitignore is simply absent', async () => {
    const warn = vi.fn();
    await loadVaultScope('/v', { readFile: fakeReadFile({}), warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('forwards the catch-all gitignore warning through loadVaultScope', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({ '.gitignore': '*\n!Notes/\n' });
    await loadVaultScope('/v', { readFile, warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('.gitignore');
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
