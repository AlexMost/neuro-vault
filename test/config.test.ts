import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('throws when --vault is missing', async () => {
    await expect(parseConfig(['node', 'cli.js'])).rejects.toThrow();
  });

  it('throws when vault path is not absolute', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'relative/vault'])).rejects.toThrow(
      'absolute',
    );
  });

  it('returns both modules enabled by default', async () => {
    const vaultPath = path.resolve('/tmp', 'MyVault');
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);

    expect(config).toEqual({
      vaultPath,
      semantic: {
        enabled: true,
        smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
        modelKey: 'bge-micro-v2',
        modelId: 'TaylorAI/bge-micro-v2',
      },
      operations: {
        enabled: true,
        binaryPath: undefined,
        vaultName: 'MyVault',
      },
    });
  });

  it('defaults vaultName to basename of --vault', async () => {
    const vaultPath = path.resolve('/tmp', 'Sandbox');
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.operations.vaultName).toBe('Sandbox');
  });

  it('accepts --vault-name override', async () => {
    const vaultPath = path.resolve('/tmp', 'MyVault');
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      vaultPath,
      '--vault-name',
      'Custom Name',
    ]);
    expect(config.operations.vaultName).toBe('Custom Name');
  });

  it('rejects empty --vault-name', async () => {
    const vaultPath = path.resolve('/tmp', 'MyVault');
    await expect(
      parseConfig(['node', 'cli.js', '--vault', vaultPath, '--vault-name', '   ']),
    ).rejects.toThrow(/vault-name/i);
  });

  it('basename strips trailing slash on --vault', async () => {
    const vaultPath = path.resolve('/tmp', 'MyVault') + '/';
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.operations.vaultName).toBe('MyVault');
  });

  it('disables operations when --no-operations is passed', async () => {
    const vaultPath = path.resolve('/tmp', 'vault');
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-operations']);

    expect(config.operations.enabled).toBe(false);
  });

  it('disables semantic when --no-semantic is passed', async () => {
    const vaultPath = path.resolve('/tmp', 'vault');
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-semantic']);

    expect(config.semantic.enabled).toBe(false);
  });

  it('captures --obsidian-cli as the binary path', async () => {
    const vaultPath = path.resolve('/tmp', 'vault');
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      vaultPath,
      '--obsidian-cli',
      '/usr/local/bin/obsidian',
    ]);

    expect(config.operations.binaryPath).toBe('/usr/local/bin/obsidian');
  });

  it('rejects when both modules are disabled', async () => {
    const vaultPath = path.resolve('/tmp', 'vault');
    await expect(
      parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-operations', '--no-semantic']),
    ).rejects.toThrow(/at least one module/i);
  });
});
