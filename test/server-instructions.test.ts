import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerInstructions, readExternalAgentInstructions } from '../src/server.js';

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-instructions-'));
}

describe('readExternalAgentInstructions', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns null when the file is missing', async () => {
    const vault = await makeTempVault();
    try {
      const result = await readExternalAgentInstructions(vault);
      expect(result).toBeNull();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('returns the trimmed file content when the file is present', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'for-external-agents.md'),
        '\n\n# Conventions\n- Do not write into Resources/\n\n',
        'utf8',
      );

      const result = await readExternalAgentInstructions(vault);
      expect(result).toBe('# Conventions\n- Do not write into Resources/');
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('warns and returns null on non-ENOENT read errors', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      // Make the path a directory so readFile fails with EISDIR.
      await fs.mkdir(path.join(dir, 'for-external-agents.md'));

      const result = await readExternalAgentInstructions(vault);
      expect(result).toBeNull();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const message = String(stderrSpy.mock.calls[0]![0]);
      expect(message).toMatch(/for-external-agents\.md/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

describe('buildServerInstructions', () => {
  it('appends the get_vault_overview hint regardless of whether the file exists', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(vault);
      expect(result).toMatch(/get_vault_overview/);
      expect(result).toMatch(/vault:\/\/overview/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('appends the vault-specific conventions section when the file exists', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'for-external-agents.md'),
        '## Vault rules\n\n- Do not write into Resources/\n',
        'utf8',
      );

      const result = await buildServerInstructions(vault);
      expect(result).toMatch(/## Vault-specific conventions/);
      expect(result).toMatch(/Do not write into Resources\//);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('omits the vault-specific section when the file is missing', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(vault);
      expect(result).not.toMatch(/## Vault-specific conventions/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});
