import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  let tmpRoot: string;
  let vaultPath: string;
  let secondVaultPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-config-'));
    vaultPath = path.join(tmpRoot, 'Sandbox');
    secondVaultPath = path.join(tmpRoot, 'Other');
    await fs.mkdir(vaultPath);
    await fs.mkdir(secondVaultPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('throws when no --vault is passed', async () => {
    await expect(parseConfig(['node', 'cli.js'])).rejects.toThrow(/--vault/);
  });

  it('accepts a single bare --vault <path> (basename becomes name)', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.vaults).toEqual([
      {
        name: 'Sandbox',
        path: vaultPath,
        smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
      },
    ]);
  });

  it('basename strips trailing slash', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath + '/']);
    expect(config.vaults[0].name).toBe('Sandbox');
  });

  it('accepts --vault name:path', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', `dmarkoff:${vaultPath}`]);
    expect(config.vaults[0]).toEqual({
      name: 'dmarkoff',
      path: vaultPath,
      smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
    });
  });

  it('accepts multiple --vault flags', async () => {
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      `personal:${vaultPath}`,
      '--vault',
      `wiki:${secondVaultPath}`,
    ]);
    expect(config.vaults.map((v) => v.name)).toEqual(['personal', 'wiki']);
    expect(config.vaults.map((v) => v.path)).toEqual([vaultPath, secondVaultPath]);
  });

  it('rejects duplicate vault names', async () => {
    await expect(
      parseConfig([
        'node',
        'cli.js',
        '--vault',
        `same:${vaultPath}`,
        '--vault',
        `same:${secondVaultPath}`,
      ]),
    ).rejects.toThrow(/unique/i);
  });

  it('rejects relative paths', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'rel/path'])).rejects.toThrow(
      /absolute/,
    );
  });

  it('rejects relative paths with name prefix', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'foo:rel/path'])).rejects.toThrow(
      /absolute/,
    );
  });

  it('rejects invalid vault names', async () => {
    await expect(
      parseConfig(['node', 'cli.js', '--vault', `bad name:${vaultPath}`]),
    ).rejects.toThrow(/name/i);
  });

  it('rejects vault path that does not exist', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    await expect(parseConfig(['node', 'cli.js', '--vault', missing])).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects vault path that is a file rather than a directory', async () => {
    const file = path.join(tmpRoot, 'a-file');
    await fs.writeFile(file, 'not a vault');
    await expect(parseConfig(['node', 'cli.js', '--vault', file])).rejects.toThrow(
      /not a directory/,
    );
  });

  it('captures --obsidian-cli as the binary path', async () => {
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
    await expect(
      parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-operations', '--no-semantic']),
    ).rejects.toThrow(/at least one module/i);
  });

  it('returns both modules enabled by default', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.semantic.enabled).toBe(true);
    expect(config.operations.enabled).toBe(true);
  });
});
