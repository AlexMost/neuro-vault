import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildServerInstructions, readExternalAgentInstructions } from '../src/server.js';
import type { IVaultRegistry } from '../src/lib/vault-registry.js';

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-instructions-'));
}

function makeRegistry(vaultPath: string, multi = false): IVaultRegistry {
  const entry = {
    name: path.basename(vaultPath),
    path: vaultPath,
    smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
    reader: {} as never,
    graph: {} as never,
    listMatchingPaths: vi.fn(),
    semanticAvailable: false,
  };
  const entries = multi
    ? [
        entry,
        {
          ...entry,
          name: 'vault2',
          path: vaultPath + '2',
          smartEnvPath: vaultPath + '2/.smart-env/multi',
        },
      ]
    : [entry];
  return {
    get: vi.fn(),
    require: vi.fn(),
    list: vi.fn(() => entries),
    isMulti: vi.fn(() => multi),
    names: vi.fn(() => entries.map((e) => e.name)),
    semanticAvailableEntries: vi.fn(() => []),
  };
}

describe('readExternalAgentInstructions', () => {
  it('returns null when the file is missing', async () => {
    const vault = await makeTempVault();
    try {
      const result = await readExternalAgentInstructions(vault);
      expect(result).toBeNull();
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

  it('returns null when the path is unreadable (e.g. a directory)', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      // Make the path a directory so readFile fails with EISDIR.
      await fs.mkdir(path.join(dir, 'for-external-agents.md'));

      const result = await readExternalAgentInstructions(vault);
      expect(result).toBeNull();
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

describe('buildServerInstructions', () => {
  it('appends the get_vault_overview hint regardless of whether the file exists', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).toMatch(/get_vault_overview/);
      expect(result).toMatch(/vault:\/\/overview/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('recommends get_vault_overview as the first probe step (not the old list_tags / list_properties chain)', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      const probeStep = result.match(/1\.\s+\*\*Probe the vault structure\*\*[^\n]*/);
      expect(probeStep).not.toBeNull();
      expect(probeStep![0]).toMatch(/get_vault_overview/);
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

      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).toMatch(/## Vault-specific conventions/);
      expect(result).toMatch(/Do not write into Resources\//);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('omits the vault-specific section when the file is missing', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).not.toMatch(/## Vault-specific conventions/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('omits the vault-specific section when the file exists but is empty', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'for-external-agents.md'), '   \n\n   ', 'utf8');

      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).not.toMatch(/## Vault-specific conventions/);
      // The always-on hint still appears.
      expect(result).toMatch(/get_vault_overview/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('does not include the multi-vault block in single-vault mode', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).not.toMatch(/Multi-vault mode/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('includes the multi-vault block listing every registered vault name when more than one is registered', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault, true));
      expect(result).toMatch(/## Multi-vault mode/);
      // The mock registry produces names from path.basename(vault) and "vault2".
      expect(result).toMatch(/"vault2"/);
      // Mentions the fan-out tools and the VAULT_REQUIRED contract.
      expect(result).toMatch(/search_notes/);
      expect(result).toMatch(/VAULT_REQUIRED/);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('emits per-vault conventions sections labelled with the vault name when only one of multiple vaults has the file', async () => {
    const a = await makeTempVault();
    const b = await makeTempVault();
    try {
      // Only vault `b` has the conventions file.
      const dir = path.join(b, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'for-external-agents.md'),
        '## Wiki rules\n- Title-case folders\n',
        'utf8',
      );

      // Build a registry with two entries pointing at the two temp dirs.
      const entries = [
        {
          name: 'first',
          path: a,
          smartEnvPath: path.join(a, '.smart-env', 'multi'),
          reader: {} as never,
          graph: {} as never,
          listMatchingPaths: vi.fn(),
          semanticAvailable: false,
        },
        {
          name: 'second',
          path: b,
          smartEnvPath: path.join(b, '.smart-env', 'multi'),
          reader: {} as never,
          graph: {} as never,
          listMatchingPaths: vi.fn(),
          semanticAvailable: false,
        },
      ];
      const registry: IVaultRegistry = {
        get: vi.fn(),
        require: vi.fn(),
        list: vi.fn(() => entries),
        isMulti: vi.fn(() => true),
        names: vi.fn(() => entries.map((e) => e.name)),
        semanticAvailableEntries: vi.fn(() => []),
      };

      const result = await buildServerInstructions(registry);
      // Heading exists for "second" with its name in the label.
      expect(result).toMatch(/## Vault-specific conventions — second/);
      expect(result).toMatch(/Title-case folders/);
      // No heading for "first" — it has no file.
      expect(result).not.toMatch(/## Vault-specific conventions — first/);
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });
});
