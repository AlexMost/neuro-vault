import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { run } from '../src/cli.js';

describe('run: argv errors on stderr', () => {
  let tmpRoot: string;
  let vaultPath: string;
  let errorLog: MockInstance<typeof console.error>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-cli-'));
    vaultPath = path.join(tmpRoot, 'Sandbox');
    await fs.mkdir(vaultPath);
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    savedExitCode = process.exitCode;
  });

  afterEach(async () => {
    errorLog.mockRestore();
    process.exitCode = savedExitCode;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** The console.error calls whose text contains `needle`. */
  function stderrCallsWith(needle: string): unknown[][] {
    return errorLog.mock.calls.filter((args) => args.map(String).join(' ').includes(needle));
  }

  it.each([
    ['the server command', [] as string[], 'Invalid values:'],
    ['index', ['index'], 'Invalid values:'],
  ])('%s prints an invalid --model once, after the usage, and exits 1', async (_, cmd, needle) => {
    await run(['node', 'cli.js', ...cmd, '--vault', vaultPath, '--model', 'nope']);

    expect(stderrCallsWith(needle)).toHaveLength(1);
    expect(stderrCallsWith('Given: "nope"')).toHaveLength(1);
    expect(stderrCallsWith('--vault')).not.toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('prints an unknown option once and exits 1', async () => {
    await run(['node', 'cli.js', '--vault', vaultPath, '--obsidian-cli', '/bin/obsidian']);

    expect(stderrCallsWith('obsidian-cli')).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('prints an error of our own (a relative --vault) once, with no usage, and exits 1', async () => {
    await run(['node', 'cli.js', '--vault', 'relative/vault']);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('--vault: path must be absolute, got "relative/vault"');
    expect(process.exitCode).toBe(1);
  });
});
