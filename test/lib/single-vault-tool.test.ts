import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildSingleVaultTool } from '../../src/lib/single-vault-tool.js';
import type { SemanticBackend } from '../../src/lib/obsidian/semantic-backend.js';
import { registerTool } from '../../src/lib/tool-registry.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { EXPLICIT_VAULT_SUFFIX } from '../../src/lib/vault-param.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';
import { callTool, expectToolError } from '../_gate.js';

interface FakeEntrySpec {
  name: string;
  backend?: SemanticBackend;
}

function registryOf(...specs: Array<string | FakeEntrySpec>): IVaultRegistry {
  const list = specs.map((s) => {
    const { name, backend } = typeof s === 'string' ? { name: s, backend: undefined } : s;
    return { name, path: `/vaults/${name}`, backend } as unknown as IVaultEntry;
  });
  const byName = new Map(list.map((e) => [e.name, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no vault ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
  };
}

const readyBackend = { status: () => ({ state: 'ready' as const }) } as SemanticBackend;
const indexingBackend = {
  status: () => ({ state: 'indexing' as const, indexed: 1, total: 3 }),
} as SemanticBackend;

interface Input {
  vault?: string;
  n?: number;
}

function regFor(registry: IVaultRegistry) {
  return registerTool(
    buildSingleVaultTool<Input, { vault: string; n: number | null }>(registry, {
      name: 'remove_property',
      title: 'Fake Tool',
      description: 'Domain prose.',
      inputShape: { n: z.number().optional() },
      runForEntry: async (entry, input) => ({ vault: entry.name, n: input.n ?? null }),
    }),
  );
}

describe('buildSingleVaultTool', () => {
  it('refuses an omitted vault in multi-vault mode with VAULT_REQUIRED', async () => {
    const payload = await expectToolError(regFor(registryOf('a', 'b')), {});
    expect(payload.code).toBe('VAULT_REQUIRED');
    expect(payload.details).toMatchObject({
      tool: 'remove_property',
      registered_vaults: ['a', 'b'],
    });
  });

  it('targets the named vault', async () => {
    const out = await callTool(regFor(registryOf('a', 'b')), { vault: 'b', n: 7 });
    expect(out).toEqual({ vault: 'b', n: 7 });
  });

  it('fails the whole call for an unknown vault name', async () => {
    const payload = await expectToolError(regFor(registryOf('a', 'b')), { vault: 'nope' });
    expect(payload.code).toBe('VAULT_NOT_FOUND');
  });

  it('resolves the only vault in single-vault mode without a vault param', async () => {
    const out = await callTool(regFor(registryOf('only')), {});
    expect(out).toEqual({ vault: 'only', n: null });
  });

  it('advertises vault alongside domain params in multi-vault mode only', () => {
    const multiShape = (regFor(registryOf('a', 'b')).spec.inputSchema as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(multiShape).sort()).toEqual(['n', 'vault']);
    const singleShape = (regFor(registryOf('only')).spec.inputSchema as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(singleShape)).toEqual(['n']);
  });

  it('appends the explicit-vault block as the final paragraph, and only in multi-vault mode', () => {
    expect(regFor(registryOf('a', 'b')).spec.description).toBe(
      `Domain prose.\n\nRegistered vaults: "a", "b". ${EXPLICIT_VAULT_SUFFIX}`,
    );
    expect(regFor(registryOf('only')).spec.description).toBe('Domain prose.');
  });

  it('places the block as its own paragraph for a multi-line domain description too', () => {
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registryOf('a', 'b'), {
        name: 'get_note_links',
        title: 'Fake Multi-line',
        description: 'Line one.\nLine two.',
        inputShape: {},
        runForEntry: async (entry) => entry.name,
      }),
    );
    expect(reg.spec.description).toBe(
      `Line one.\nLine two.\n\nRegistered vaults: "a", "b". ${EXPLICIT_VAULT_SUFFIX}`,
    );
  });

  it('semantic: true routes through the readiness gate before the per-vault function', async () => {
    const registry = registryOf({ name: 'a', backend: indexingBackend }, { name: 'b' });
    let ran = false;
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registry, {
        name: 'find_duplicates',
        title: 'Fake Semantic',
        description: 'Domain prose.',
        semantic: true,
        inputShape: {},
        runForEntry: async (entry) => {
          ran = true;
          return entry.backend.status().state;
        },
      }),
    );
    const payload = await expectToolError(reg, { vault: 'a' });
    expect(payload.code).toBe('SEMANTIC_INDEX_BUILDING');
    expect(ran).toBe(false);
  });

  it('semantic: true hands a ready entry with a typed backend to the per-vault function', async () => {
    const registry = registryOf({ name: 'a', backend: readyBackend }, { name: 'b' });
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registry, {
        name: 'find_duplicates',
        title: 'Fake Semantic',
        description: 'Domain prose.',
        semantic: true,
        inputShape: {},
        runForEntry: async (entry) => entry.backend.status().state,
      }),
    );
    expect(await callTool(reg, { vault: 'a' })).toBe('ready');
  });
});
