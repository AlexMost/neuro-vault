import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('throws when --vault is missing', async () => {
    await expect(parseConfig(['node', 'cli.js'])).rejects.toThrow();
  });

  it('throws when --vault is present without a value', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault'])).rejects.toThrow();
  });

  it('throws when vault path is not absolute', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'relative/vault'])).rejects.toThrow(
      'absolute',
    );
  });

  it('normalizes an absolute vault path before returning config', async () => {
    const rawVaultPath = `${path.sep}tmp${path.sep}vault${path.sep}..${path.sep}vault`;
    const vaultPath = path.resolve('/tmp', 'vault');

    await expect(parseConfig(['node', 'cli.js', '--vault', rawVaultPath])).resolves.toEqual({
      vaultPath,
      smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
      modelKey: 'bge-micro-v2',
      modelId: 'TaylorAI/bge-micro-v2',
    });
  });

  it('defaults the model key to bge-micro-v2', async () => {
    const vaultPath = path.resolve('/tmp', 'vault');
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);

    expect(config.modelKey).toBe('bge-micro-v2');
  });
});
