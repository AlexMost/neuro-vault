import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildServerInstructions } from '../src/server.js';
import { readVaultConventions } from '../src/lib/obsidian/vault-conventions.js';
import type { IVaultRegistry } from '../src/lib/vault-registry.js';
import { createExistingPathFilter } from '../src/lib/obsidian/existing-paths.js';
import { createVaultScope } from '../src/lib/obsidian/vault-scope.js';

/**
 * Claude Code truncates the MCP `instructions` string at exactly this many
 * characters (and hands sub-agents none of it). Everything this suite asserts
 * about ordering exists to keep the owner-authored conventions block — the one
 * piece of content no tool description can supply — inside that window.
 */
const CLIENT_INSTRUCTIONS_CAP = 2048;

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-instructions-'));
}

function makeRegistry(vaultPath: string, multi = false): IVaultRegistry {
  const entry = {
    name: path.basename(vaultPath),
    path: vaultPath,
    smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
    scope: createVaultScope(),
    reader: {} as never,
    writer: {} as never,
    provider: {} as never,
    graph: {} as never,
    listMatchingPaths: vi.fn(),
    readConventions: () => readVaultConventions(vaultPath),
    filterExisting: createExistingPathFilter({ vaultRoot: vaultPath }),
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
          readConventions: () => readVaultConventions(vaultPath + '2'),
        },
      ]
    : [entry];
  return {
    get: vi.fn(),
    require: vi.fn(),
    list: vi.fn(() => entries),
    isMulti: vi.fn(() => multi),
    names: vi.fn(() => entries.map((e) => e.name)),
  };
}

/**
 * A representative real-world conventions file: a note-type vocabulary plus a
 * couple of folder rules lands around 1,200 characters.
 */
function representativeConventions(): string {
  const body = '- Notes carry a closed `type`: project | task | idea | reflection.\n';
  return '# Vault conventions\n\n' + body.repeat(18);
}

describe('buildServerInstructions', () => {
  it('keeps a representative conventions block and the whole preamble inside the client cap', async () => {
    const conventions = representativeConventions();
    expect(conventions.length).toBeGreaterThan(1_000);
    expect(conventions.length).toBeLessThan(1_400);

    const registry = makeRegistry('/vaults/obsidian');
    const [base] = registry.list();
    registry.list = vi.fn(() => [{ ...base, readConventions: async () => conventions }]);

    const result = await buildServerInstructions(registry);
    const visible = result.slice(0, CLIENT_INSTRUCTIONS_CAP);

    // The contract is what a truncating client actually sees, not the total
    // length: the vault block whole, and the preamble whole, inside the slice.
    expect(visible).toContain(conventions);
    expect(visible).toContain('second brain');
    expect(visible).toContain('ask the user');
  });

  it('places the conventions block before any server-authored prose', async () => {
    const registry = makeRegistry('/vaults/obsidian');
    const [base] = registry.list();
    registry.list = vi.fn(() => [{ ...base, readConventions: async () => '# House rules' }]);

    const result = await buildServerInstructions(registry);
    expect(result.indexOf('# House rules')).toBeLessThan(result.indexOf('second brain'));
  });

  it('emits the preamble alone, well under the cap, when a vault has no conventions', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      expect(result).not.toMatch(/Vault-specific conventions/);
      expect(result).toContain('second brain');
      expect(result.length).toBeLessThan(CLIENT_INSTRUCTIONS_CAP);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('names the project-scoping probe order: overview, then search, then the user', async () => {
    const vault = await makeTempVault();
    try {
      const result = await buildServerInstructions(makeRegistry(vault));
      const probeStep = result.match(/Find out in this order:[^\n]*/);
      expect(probeStep).not.toBeNull();
      const step = probeStep![0];
      expect(step.indexOf('get_vault_overview')).toBeGreaterThanOrEqual(0);
      expect(step.indexOf('get_vault_overview')).toBeLessThan(step.indexOf('search_notes'));
      expect(step.indexOf('search_notes')).toBeLessThan(step.indexOf('ask the user'));
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('emits the vault-specific conventions section when the file exists', async () => {
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
      // The preamble still appears.
      expect(result).toContain('second brain');
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('never emits a multi-vault prose section — that contract lives on each tool description', async () => {
    const vault = await makeTempVault();
    try {
      expect(await buildServerInstructions(makeRegistry(vault))).not.toMatch(/Multi-vault mode/);
      expect(await buildServerInstructions(makeRegistry(vault, true))).not.toMatch(
        /Multi-vault mode/,
      );
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('emits one attributed conventions block per vault in multi-vault mode', async () => {
    const registry = makeRegistry('/vaults/obsidian', true);
    const entries = registry.list();
    registry.list = vi.fn(() => [
      { ...entries[0], name: 'alpha', readConventions: async () => 'alpha rules' },
      { ...entries[1], name: 'beta', readConventions: async () => 'beta rules' },
    ]);

    const result = await buildServerInstructions(registry);
    expect(result).toMatch(/## Vault-specific conventions — alpha/);
    expect(result).toMatch(/## Vault-specific conventions — beta/);
    expect(result).toContain('alpha rules');
    expect(result).toContain('beta rules');
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
          scope: createVaultScope(),
          reader: {} as never,
          writer: {} as never,
          provider: {} as never,
          graph: {} as never,
          listMatchingPaths: vi.fn(),
          readConventions: () => readVaultConventions(a),
          filterExisting: createExistingPathFilter({ vaultRoot: a }),
          semanticAvailable: false,
        },
        {
          name: 'second',
          path: b,
          smartEnvPath: path.join(b, '.smart-env', 'multi'),
          scope: createVaultScope(),
          reader: {} as never,
          writer: {} as never,
          provider: {} as never,
          graph: {} as never,
          listMatchingPaths: vi.fn(),
          readConventions: () => readVaultConventions(b),
          filterExisting: createExistingPathFilter({ vaultRoot: b }),
          semanticAvailable: false,
        },
      ];
      const registry: IVaultRegistry = {
        get: vi.fn(),
        require: vi.fn(),
        list: vi.fn(() => entries),
        isMulti: vi.fn(() => true),
        names: vi.fn(() => entries.map((e) => e.name)),
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
