import { describe, expect, it, vi } from 'vitest';

import { loadVaultConfig } from '../../../src/lib/obsidian/vault-config.js';

function reader(files: Record<string, string>) {
  return async (p: string) => {
    const hit = Object.entries(files).find(([name]) => p.endsWith(name));
    if (!hit) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return hit[1];
  };
}

describe('loadVaultConfig', () => {
  it('reads semantic: false', async () => {
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"semantic": false}' }),
    });
    expect(config.semantic).toBe(false);
  });

  it('leaves semantic undefined when the key is absent', async () => {
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"exclusions": ["Archive/**"]}' }),
    });
    expect(config.semantic).toBeUndefined();
    expect(config.exclusions).toEqual(['Archive/**']);
  });

  it('warns and ignores a non-boolean semantic value', async () => {
    const warn = vi.fn();
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"semantic": "no"}' }),
      warn,
    });
    expect(config.semantic).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"semantic"'));
  });

  it('returns an empty config when the file is missing', async () => {
    const config = await loadVaultConfig('/v', { readFile: reader({}) });
    expect(config).toEqual({});
  });

  it('warns once and returns an empty config on invalid JSON', async () => {
    const warn = vi.fn();
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{oops' }),
      warn,
    });
    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
