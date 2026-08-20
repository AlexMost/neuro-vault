import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import { buildSemanticTools } from '../../src/modules/semantic/tools/index.js';
import { FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import type { ToolName } from '../../src/lib/tool-names.js';
import { makeTestRegistry } from '../operations/tools/_test-registry.js';
import { makeFakeGraph } from '../semantic/tools/_helpers.js';

const FAN_OUT_TOOLS: ToolName[] = [
  'list_tags',
  'list_properties',
  'query_notes',
  'get_vault_overview',
  'search_notes',
];

function allTools(...names: string[]) {
  const registry = makeTestRegistry(
    names.map((name) => ({
      name,
      path: `/vaults/${name}`,
      smartEnvPath: `/vaults/${name}/.smart-env`,
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

describe('fan-out prose carries the shared FAN_OUT_SUFFIX, not a private copy', () => {
  it('every fan-out tool carries FAN_OUT_SUFFIX byte for byte', () => {
    const tools = allTools('alpha', 'beta');
    for (const name of FAN_OUT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      expect(tool!.spec.description, `${name} description`).toContain(FAN_OUT_SUFFIX);
    }
  });

  it('no tool advertises skipped_vaults', () => {
    for (const tool of allTools('alpha', 'beta')) {
      expect(tool.spec.description, `${tool.name} description`).not.toContain('skipped_vaults');
    }
  });

  it('but the fan-out response still carries the field', async () => {
    const listTags = allTools('alpha', 'beta').find((t) => t.name === 'list_tags');
    expect(listTags, 'list_tags is not registered').toBeDefined();
    const out = await listTags!.handler({});
    const block = out.content[0] as { type: 'text'; text: string };
    const payload = JSON.parse(block.text) as { skipped_vaults: unknown[] };
    expect(payload.skipped_vaults).toEqual([]);
    expect(payload).toHaveProperty('results_by_vault');
    expect(payload).toHaveProperty('failed_vaults');
  });

  it('every fan-out tool advertises vault in multi-vault mode', () => {
    const tools = allTools('alpha', 'beta');
    for (const name of FAN_OUT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      const schema = tool!.spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(schema.shape), `${name} schema`).toContain('vault');
    }
  });

  it('no fan-out tool advertises vault or the fan-out prose in single-vault mode', () => {
    const tools = allTools('only');
    for (const name of FAN_OUT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      const schema = tool!.spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(schema.shape), `${name} schema`).not.toContain('vault');
      expect(tool!.spec.description, `${name} description`).not.toContain(FAN_OUT_SUFFIX);
    }
  });

  it('any tool describing the fan-out response envelope must use the shared suffix verbatim', () => {
    // Does not depend on the hand-maintained FAN_OUT_TOOLS list: a future sixth
    // fan-out tool cannot describe its response shape (`results_by_vault` /
    // `failed_vaults`) without also naming FAN_OUT_SUFFIX verbatim, catching a
    // hand-written private copy even if nobody remembers to update the list
    // above.
    const tools = allTools('alpha', 'beta');
    for (const tool of tools) {
      const description = tool.spec.description ?? '';
      const describesFanOutEnvelope =
        description.includes('results_by_vault') || description.includes('failed_vaults');
      if (describesFanOutEnvelope) {
        expect(description, `${tool.name} description`).toContain(FAN_OUT_SUFFIX);
      }
    }
  });
});
