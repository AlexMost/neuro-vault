import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('throws when --vault is missing', () => {
    expect(() => parseConfig(['node', 'cli.js'])).toThrow('--vault');
  });

  it('throws when --vault is present without a value', () => {
    expect(() => parseConfig(['node', 'cli.js', '--vault'])).toThrow('--vault');
  });

  it('throws when vault path is not absolute', () => {
    expect(() => parseConfig(['node', 'cli.js', '--vault', 'relative/vault'])).toThrow('absolute');
  });

  it('normalizes an absolute vault path before returning config', () => {
    const rawVaultPath = `${path.sep}tmp${path.sep}vault${path.sep}..${path.sep}vault`;
    const vaultPath = path.resolve('/tmp', 'vault');

    expect(parseConfig(['node', 'cli.js', '--vault', rawVaultPath])).toEqual({
      vaultPath,
      smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
      modelKey: 'bge-micro-v2',
    });
  });

  it('defaults the model key to bge-micro-v2', () => {
    const vaultPath = path.resolve('/tmp', 'vault');

    expect(parseConfig(['node', 'cli.js', '--vault', vaultPath]).modelKey).toBe('bge-micro-v2');
  });
});
