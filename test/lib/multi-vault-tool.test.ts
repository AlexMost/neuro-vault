import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildMultiVaultTool, payloadOnly, withVaultName } from '../../src/lib/multi-vault-tool.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';

function registryOf(...names: string[]): IVaultRegistry {
  const list = names.map((name) => ({ name, path: `/vaults/${name}` })) as IVaultEntry[];
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

interface Input {
  vault?: string;
  n?: number;
}

type Single = (entry: IVaultEntry, payload: { results: string[] }) => unknown;

function toolFor(registry: IVaultRegistry, single: Single = withVaultName) {
  return buildMultiVaultTool<Input, { results: string[] }, unknown>(registry, {
    name: 'list_tags',
    title: 'List Tags',
    description: 'Domain prose.',
    inputShape: { n: z.number().optional() },
    runForEntry: async (entry) => ({ results: [entry.name] }),
    single,
  });
}

describe('buildMultiVaultTool', () => {
  it('fans out when vault is omitted and the registry holds more than one vault', async () => {
    const out = (await toolFor(registryOf('a', 'b')).handler({})) as {
      results_by_vault: unknown[];
      skipped_vaults: unknown[];
      failed_vaults: unknown[];
    };
    expect(out.results_by_vault).toEqual([
      { vault: 'a', results: ['a'] },
      { vault: 'b', results: ['b'] },
    ]);
    expect(out.skipped_vaults).toEqual([]);
    expect(out.failed_vaults).toEqual([]);
  });

  it('targets one vault when vault is supplied', async () => {
    const out = await toolFor(registryOf('a', 'b')).handler({ vault: 'b' });
    expect(out).toEqual({ vault: 'b', results: ['b'] });
  });

  it('never fans out in single-vault mode', async () => {
    const out = await toolFor(registryOf('only')).handler({});
    expect(out).toEqual({ vault: 'only', results: ['only'] });
  });

  it('fails the whole call for an unknown vault name', async () => {
    await expect(toolFor(registryOf('a', 'b')).handler({ vault: 'nope' })).rejects.toThrow(
      ToolHandlerError,
    );
  });

  it('payloadOnly returns the payload with no added top-level vault key', async () => {
    const out = await toolFor(registryOf('a', 'b'), payloadOnly).handler({ vault: 'a' });
    expect(out).toEqual({ results: ['a'] });
  });

  it('advertises vault in multi-vault mode alongside the domain params', () => {
    const shape = (toolFor(registryOf('a', 'b')).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape).sort()).toEqual(['n', 'vault']);
  });

  it('omits vault from the advertised schema in single-vault mode', () => {
    const shape = (toolFor(registryOf('only')).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape)).toEqual(['n']);
  });

  it('appends the fan-out prose in multi-vault mode only', () => {
    expect(toolFor(registryOf('a', 'b')).description).toContain('results_by_vault');
    expect(toolFor(registryOf('only')).description).toBe('Domain prose.');
  });

  it('appends a domain-specific multiVaultNote after the shared suffix', () => {
    const tool = buildMultiVaultTool<Input, { results: string[] }, unknown>(registryOf('a', 'b'), {
      name: 'search_notes',
      title: 'Search Notes',
      description: 'Domain prose.',
      multiVaultNote: 'Vaults without a semantic index still contribute lexically.',
      inputShape: {},
      runForEntry: async (entry) => ({ results: [entry.name] }),
      single: payloadOnly,
    });
    expect(tool.description.indexOf('results_by_vault')).toBeLessThan(
      tool.description.indexOf('still contribute lexically'),
    );
  });

  it('separates the multi-vault block with a blank line at column 0 for a multi-line description', () => {
    const tool = buildMultiVaultTool<Input, { results: string[] }, unknown>(registryOf('a', 'b'), {
      name: 'list_tags',
      title: 'List Tags',
      description: 'Line one.\nLine two.',
      inputShape: { n: z.number().optional() },
      runForEntry: async (entry) => ({ results: [entry.name] }),
      single: withVaultName,
    });
    expect(tool.description).toBe(
      `Line one.\nLine two.\n\nRegistered vaults: "a", "b". ${FAN_OUT_SUFFIX}`,
    );
  });

  it('keeps the single leading-space separator for a single-paragraph description', () => {
    const tool = buildMultiVaultTool<Input, { results: string[] }, unknown>(registryOf('a', 'b'), {
      name: 'list_tags',
      title: 'List Tags',
      description: 'Domain prose.',
      inputShape: { n: z.number().optional() },
      runForEntry: async (entry) => ({ results: [entry.name] }),
      single: withVaultName,
    });
    expect(tool.description).toBe(`Domain prose. Registered vaults: "a", "b". ${FAN_OUT_SUFFIX}`);
  });

  it('rejects an inputShape that declares vault at the type level', () => {
    // Type-only assertion, never invoked at runtime: a domain `inputShape`
    // declaring its own `vault` key must fail `npm run typecheck`, which is
    // this repo's authoritative gate — vitest does not type-check test
    // bodies, so the guard is pinned here and enforced there.
    function _typeGuard(registry: IVaultRegistry) {
      return buildMultiVaultTool<Input, { results: string[] }, unknown>(registry, {
        name: 'list_tags',
        title: 'List Tags',
        description: 'Domain prose.',
        inputShape: {
          n: z.number().optional(),
          // @ts-expect-error - vault is contributed by the builder; declaring it in inputShape must be a type error.
          vault: z.string(),
        },
        runForEntry: async (entry) => ({ results: [entry.name] }),
        single: withVaultName,
      });
    }
    expect(typeof _typeGuard).toBe('function');
  });
});
