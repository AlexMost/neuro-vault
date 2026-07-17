import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../src/lib/tool-response.js';
import {
  VaultRegistry,
  type IVaultEntry,
  type IVaultEntryDeps,
} from '../../src/lib/vault-registry.js';
import type { VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import type { IVaultConfig } from '../../src/types.js';

// Type-level guard: writer and provider must be required on IVaultEntry.
// If anyone reintroduces optionality (e.g. by adding `?`), this assertion
// breaks at compile time — a much cleaner signal than the 14 runtime `!`
// asserts the codebase used to carry.
type AssertRequired<T, K extends keyof T> = undefined extends T[K] ? never : true;
const _writerIsRequired: AssertRequired<IVaultEntry, 'writer'> = true;
const _providerIsRequired: AssertRequired<IVaultEntry, 'provider'> = true;
// Reference to silence the unused-variable lint.
void _writerIsRequired;
void _providerIsRequired;

function fakeDeps(): IVaultEntryDeps {
  return {
    readerFactory: ({ vaultRoot }) => ({ vaultRoot }) as never,
    writerFactory: ({ vaultRoot }) => ({ vaultRoot }) as never,
    graphFactory: ({ reader }) => ({ reader, ensureFresh: async () => {} }) as never,
    listMatchingPathsFactory: () => (async () => new Set<string>()) as never,
    providerFactory: ({ vaultName, vaultRoot, binaryPath, reader }) =>
      ({ vaultName, vaultRoot, binaryPath, reader }) as never,
    corpusFactory: async () =>
      ({ snapshot: async () => ({ sources: new Map(), basenameIndex: new Map() }) }) as never,
  };
}

function vault(name: string, path: string): IVaultConfig {
  return { name, path, smartEnvPath: `${path}/.smart-env/multi` };
}

describe('createVaultRegistry', () => {
  it('builds one entry per vault config', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a'), vault('b', '/v/b')],
        semanticEnabled: true,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(registry.list().map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('get returns undefined for unknown name', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(registry.get('missing')).toBeUndefined();
  });

  it('get is case-insensitive but entry name preserves original casing', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('Obsidian', '/v/Obsidian')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(registry.get('Obsidian')?.name).toBe('Obsidian');
    expect(registry.get('obsidian')?.name).toBe('Obsidian');
    expect(registry.get('OBSIDIAN')?.name).toBe('Obsidian');
    expect(registry.get('OBsiDIAN')?.name).toBe('Obsidian');
  });

  it('require is case-insensitive but error preserves the requested casing', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('Obsidian', '/v/Obsidian')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(registry.require('obsidian').name).toBe('Obsidian');
    try {
      registry.require('TestVault');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ToolHandlerError).details).toEqual({
        requested: 'TestVault',
        registered_vaults: ['Obsidian'],
      });
    }
  });

  it('require throws VAULT_NOT_FOUND for unknown name', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    try {
      registry.require('missing');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).code).toBe('VAULT_NOT_FOUND');
      expect((err as ToolHandlerError).details).toEqual({
        requested: 'missing',
        registered_vaults: ['a'],
      });
    }
  });

  it('isMulti reflects vault count', async () => {
    const one = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(one.isMulti()).toBe(false);

    const two = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a'), vault('b', '/v/b')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      fakeDeps(),
    );
    expect(two.isMulti()).toBe(true);
  });

  it('records semantic unavailability when corpus factory throws', async () => {
    const deps = fakeDeps();
    deps.corpusFactory = async () => {
      throw new Error('ENOENT: .smart-env/multi missing');
    };
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: true,
        modelKey: 'm',
      },
      deps,
    );
    const entry = registry.require('a');
    expect(entry.semanticAvailable).toBe(false);
    expect(entry.semanticUnavailableReason).toMatch(/ENOENT/);
    expect(entry.corpus).toBeUndefined();
  });

  it('records semantic unavailability when initial snapshot is empty', async () => {
    const deps = fakeDeps();
    deps.corpusFactory = async () =>
      ({ snapshot: async () => ({ sources: new Map(), basenameIndex: new Map() }) }) as never;
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: true,
        modelKey: 'm',
      },
      deps,
    );
    expect(registry.require('a').semanticAvailable).toBe(false);
  });

  it('passes the vault reader to providerFactory', async () => {
    const fakeReader = { sentinel: 'reader' } as unknown as VaultReader;
    const seen: unknown[] = [];
    const deps = fakeDeps();
    deps.readerFactory = () => fakeReader;
    deps.providerFactory = (opts) => {
      seen.push(opts.reader);
      return { vaultName: opts.vaultName, vaultRoot: opts.vaultRoot } as never;
    };
    await VaultRegistry.create(
      {
        vaults: [vault('a', '/v/a')],
        semanticEnabled: false,
        modelKey: 'm',
      },
      deps,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(fakeReader);
  });

  it('always populates writer and provider on every entry', async () => {
    const registry = await VaultRegistry.create(
      {
        vaults: [vault('v', '/tmp/v')],
        semanticEnabled: false,
        modelKey: 'bge-micro-v2',
      },
      fakeDeps(),
    );
    const [entry] = registry.list();
    expect(entry.writer).toBeDefined();
    expect(entry.provider).toBeDefined();
  });
});
