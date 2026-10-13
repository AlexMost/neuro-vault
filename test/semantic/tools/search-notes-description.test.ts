import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPANSION_FLOOR,
  EFFORT_PROFILES,
  FALLBACK_THRESHOLD,
} from '../../../src/modules/semantic/effort-profiles.js';

// The advertisement-derivation pin (spec: hybrid-search "Effort-profile
// advertisement derives from the retrieval constants"). Reads the SOURCE of
// the description to prove the numbers are interpolated, and the BUILT
// description/schema to prove each advertised number equals the profile
// constant.
import { readFile } from 'node:fs/promises';

import { registerTool } from '../../../src/lib/tool-registry.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { makeTestRegistry } from './_helpers.js';

function builtTool() {
  return buildSearchNotesTool({
    registry: makeTestRegistry([]),
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embedQuery: () => Promise.resolve([1]),
    },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
    modelKey: 'k',
  });
}

function builtDescription(): string {
  return registerTool(builtTool()).spec.description!;
}

describe('search_notes advertised numbers derive from the effort profile', () => {
  it('the description carries every profile number', () => {
    const description = builtDescription();
    const { quick, deep } = EFFORT_PROFILES;
    expect(description).toContain(
      `"quick" (default) — compact lookup (${quick.semanticPool} semantic notes, ~${quick.lexicalNoteCap} lexical, no expansion, merged cap ${quick.mergedCap})`,
    );
    expect(description).toContain(
      `"deep" — exploration (${deep.semanticPool} semantic, ~${deep.lexicalNoteCap} lexical, expansion on, merged cap ${deep.mergedCap})`,
    );
  });

  it('threshold and expansion-floor prose interpolate their constants', async () => {
    const source = await readFile('src/modules/semantic/tools/search-notes.ts', 'utf8');
    expect(source).toContain('${FALLBACK_THRESHOLD}');
    expect(source).toContain('${DEFAULT_EXPANSION_FLOOR}');
    expect(source).toContain('${EFFORT_PROFILES.quick.semanticThreshold}');
    expect(source).toContain('${EFFORT_PROFILES.deep.semanticThreshold}');
    expect(source).toContain('${EFFORT_PROFILES.quick.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.quick.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.quick.mergedCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.deep.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.mergedCap}');
  });

  it('threshold and expansion-floor numbers land in the ADVERTISED schema', () => {
    // Pinned against the post-gate schema MCP clients receive — the
    // registration's coercing `spec.inputSchema`, converted the way the MCP
    // SDK converts it for `tools/list` (`pipeStrategy: 'input'`) — not against
    // the source file. A source-only grep (the test above) can't catch the two
    // interpolation slots getting swapped, since swapped source still contains
    // every token that grep checks for.
    const { properties } = z.toJSONSchema(registerTool(builtTool()).spec.inputSchema as z.ZodType, {
      io: 'input',
    }) as { properties: Record<string, { description?: string }> };
    expect(properties.threshold?.description).toContain(
      `effort defaults (${EFFORT_PROFILES.quick.semanticThreshold} quick / ${EFFORT_PROFILES.deep.semanticThreshold} deep) with one retry at ${FALLBACK_THRESHOLD}`,
    );
    expect(properties.expansion_floor?.description).toContain(`Default ${DEFAULT_EXPANSION_FLOOR}`);
  });

  it('the input gate advertises every field description the tool declares', () => {
    // The sweep: whatever the tool declares per field must survive
    // `wrapSchemaWithCoercion`, so the pre- and post-gate advertisements agree.
    const tool = builtTool();
    const describedFields = (schema: z.ZodType) =>
      Object.fromEntries(
        Object.entries(
          (
            z.toJSONSchema(schema, { io: 'input' }) as {
              properties: Record<string, { description?: string }>;
            }
          ).properties,
        ).flatMap(([k, v]) => (v.description === undefined ? [] : [[k, v.description]])),
      );
    const declared = describedFields(tool.inputSchema);
    expect(Object.keys(declared)).toEqual(expect.arrayContaining(['threshold', 'expansion_floor']));
    expect(describedFields(registerTool(tool).spec.inputSchema as z.ZodType)).toEqual(declared);
  });
});
