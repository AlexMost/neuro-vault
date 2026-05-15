import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

const ABS = (...segments: string[]) => path.resolve('/tmp', ...segments);

describe('parseConfig', () => {
  it('throws when no --vault is passed', async () => {
    await expect(parseConfig(['node', 'cli.js'])).rejects.toThrow(/--vault/);
  });

  it('accepts a single bare --vault <path> (basename becomes name)', async () => {
    const vaultPath = ABS('Sandbox');
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
    const vaultPath = ABS('Sandbox') + '/';
    const config = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    expect(config.vaults[0].name).toBe('Sandbox');
  });

  it('accepts --vault name:path', async () => {
    const vaultPath = ABS('wiki');
    const config = await parseConfig(['node', 'cli.js', '--vault', `dmarkoff:${vaultPath}`]);
    expect(config.vaults[0]).toEqual({
      name: 'dmarkoff',
      path: vaultPath,
      smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
    });
  });

  it('accepts multiple --vault flags', async () => {
    const a = ABS('a');
    const b = ABS('b');
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      `personal:${a}`,
      '--vault',
      `wiki:${b}`,
    ]);
    expect(config.vaults.map((v) => v.name)).toEqual(['personal', 'wiki']);
    expect(config.vaults.map((v) => v.path)).toEqual([a, b]);
  });

  it('rejects duplicate vault names', async () => {
    const a = ABS('a');
    const b = ABS('b');
    await expect(
      parseConfig(['node', 'cli.js', '--vault', `same:${a}`, '--vault', `same:${b}`]),
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
    const v = ABS('v');
    await expect(parseConfig(['node', 'cli.js', '--vault', `bad name:${v}`])).rejects.toThrow(
      /name/i,
    );
  });

  it('captures --obsidian-cli as the binary path', async () => {
    const v = ABS('v');
    const config = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      v,
      '--obsidian-cli',
      '/usr/local/bin/obsidian',
    ]);
    expect(config.operations.binaryPath).toBe('/usr/local/bin/obsidian');
  });

  it('rejects when both modules are disabled', async () => {
    const v = ABS('v');
    await expect(
      parseConfig(['node', 'cli.js', '--vault', v, '--no-operations', '--no-semantic']),
    ).rejects.toThrow(/at least one module/i);
  });

  it('returns both modules enabled by default', async () => {
    const v = ABS('v');
    const config = await parseConfig(['node', 'cli.js', '--vault', v]);
    expect(config.semantic.enabled).toBe(true);
    expect(config.operations.enabled).toBe(true);
  });
});
