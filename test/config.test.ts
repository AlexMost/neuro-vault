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

  it('registers a single vault with name = basename(path)', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.vaults).toEqual([
      {
        name: 'Sandbox',
        path: vaultPath,
        smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
      },
    ]);
  });

  it('strips trailing slash before deriving basename', async () => {
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath + '/']);
    expect(config.vaults[0].name).toBe('Sandbox');
  });

  it('registers multiple vaults — basenames become aliases', async () => {
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      vaultPath,
      '--vault',
      secondVaultPath,
    ]);
    expect(config.vaults.map((v) => v.name)).toEqual(['Sandbox', 'Other']);
    expect(config.vaults.map((v) => v.path)).toEqual([vaultPath, secondVaultPath]);
  });

  it('rejects two vaults sharing the same basename with an actionable error', async () => {
    const a = path.join(tmpRoot, 'NestedA', 'Sandbox');
    const b = path.join(tmpRoot, 'NestedB', 'Sandbox');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.mkdir(a);
    await fs.mkdir(b);
    await expect(parseConfig(['node', 'cli.js', '--vault', a, '--vault', b])).rejects.toThrow(
      /Rename one of the directories/,
    );
  });

  it('rejects basename collision case-insensitively (Sandbox vs sandbox)', async () => {
    const a = path.join(tmpRoot, 'NestedA', 'Sandbox');
    const b = path.join(tmpRoot, 'NestedB', 'sandbox');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.mkdir(a);
    await fs.mkdir(b);
    await expect(parseConfig(['node', 'cli.js', '--vault', a, '--vault', b])).rejects.toThrow(
      /case-insensitive/,
    );
  });

  it('rejects a relative path', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'rel/path'])).rejects.toThrow(
      /absolute/,
    );
  });

  it('rejects a basename that is not a valid identifier', async () => {
    const weird = path.join(tmpRoot, 'has space');
    await fs.mkdir(weird);
    await expect(parseConfig(['node', 'cli.js', '--vault', weird])).rejects.toThrow(
      /not a valid vault identifier/,
    );
  });

  it('rejects a vault path that does not exist', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    await expect(parseConfig(['node', 'cli.js', '--vault', missing])).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects a vault path that is a file rather than a directory', async () => {
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
