import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import { buildSemanticTools } from '../../src/modules/semantic/tools/index.js';
import { EXPLICIT_VAULT_SUFFIX } from '../../src/lib/vault-param.js';
import type { ToolName } from '../../src/lib/tool-names.js';
import { makeTestRegistry } from '../operations/tools/_test-registry.js';
import { makeFakeGraph } from '../semantic/tools/_helpers.js';

const EXPLICIT_VAULT_TOOLS: ToolName[] = [
  'read_notes',
  'create_note',
  'edit_note',
  'read_daily',
  'set_property',
  'remove_property',
  'get_note_links',
  'get_similar_notes',
  'find_duplicates',
];

function allTools(...names: string[]) {
  const registry = makeTestRegistry(
    names.map((name) => ({
      name,
      path: `/vaults/${name}`,
      graph: makeFakeGraph(),
      listMatchingPaths: async () => new Set<string>(),
      provider: { listTags: async () => [], listProperties: async () => [] } as never,
    })),
  );
  return [
    ...buildOperationsTools({ registry }),
    ...buildSemanticTools({
      registry,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: {
        findNeighbors: vi.fn().mockReturnValue([]),
        findBlockNeighbors: vi.fn().mockReturnValue([]),
        findDuplicates: vi.fn().mockReturnValue([]),
      },
      modelKey: 'bge-micro-v2',
    }),
  ];
}

function descriptionOf(tools: ReturnType<typeof allTools>, name: ToolName): string {
  const tool = tools.find((t) => t.name === name);
  expect(tool, `${name} is not registered`).toBeDefined();
  return tool!.spec.description ?? '';
}

describe('explicit-vault prose is builder-placed, last, and shared', () => {
  it('every explicit-vault tool ends with the shared block as its own final paragraph', () => {
    // The suffix-last invariant is structural in `buildSingleVaultTool`, but it
    // is the *registered* descriptions that reach a client — this pins them.
    // `create_note` and `get_note_links` each used to violate it: one appended
    // an overwrite warning after the suffix, the other folded the suffix into a
    // `.join('\n')` element.
    const tools = allTools('alpha', 'beta');
    const block = `Registered vaults: "alpha", "beta". ${EXPLICIT_VAULT_SUFFIX}`;
    for (const name of EXPLICIT_VAULT_TOOLS) {
      const description = descriptionOf(tools, name);
      expect(description, `${name} description`).toContain(EXPLICIT_VAULT_SUFFIX);
      expect(description.endsWith(`\n\n${block}`), `${name} ends with the block paragraph`).toBe(
        true,
      );
    }
  });

  it('every explicit-vault tool advertises vault in multi-vault mode', () => {
    const tools = allTools('alpha', 'beta');
    for (const name of EXPLICIT_VAULT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      const schema = tool!.spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(schema.shape), `${name} schema`).toContain('vault');
    }
  });

  it('no explicit-vault tool advertises vault or the contract text in single-vault mode', () => {
    const tools = allTools('only');
    for (const name of EXPLICIT_VAULT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      const schema = tool!.spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(schema.shape), `${name} schema`).not.toContain('vault');
      expect(tool!.spec.description, `${name} description`).not.toContain(EXPLICIT_VAULT_SUFFIX);
      expect(tool!.spec.description, `${name} description`).not.toContain('Registered vaults:');
    }
  });

  it('any tool naming VAULT_REQUIRED in its description uses the shared suffix verbatim', () => {
    // Independent of the hand-maintained list above: a tenth explicit-vault
    // tool cannot state the contract in its own words without tripping this.
    for (const tool of allTools('alpha', 'beta')) {
      const description = tool.spec.description ?? '';
      if (description.includes('VAULT_REQUIRED')) {
        expect(description, `${tool.name} description`).toContain(EXPLICIT_VAULT_SUFFIX);
      }
    }
  });
});
