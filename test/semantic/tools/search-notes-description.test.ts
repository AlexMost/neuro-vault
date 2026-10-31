import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { EFFORT_PROFILES } from '../../../src/modules/semantic/effort-profiles.js';
import { resolveModelProfile, type SimilarityDefaults } from '../../../src/lib/model-profiles.js';

// The advertisement-derivation pin (spec: hybrid-search "Effort-profile
// advertisement derives from the retrieval constants"). Reads the SOURCE of
// the description to prove the numbers are interpolated, and the BUILT
// description/schema to prove each advertised number equals the profile
// constant.
import { readFile } from 'node:fs/promises';

import { registerTool } from '../../../src/lib/tool-registry.js';
import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { makeTestRegistry } from './_helpers.js';
import { TEST_SIMILARITY } from '../../_identity.js';

function builtTool(similarity: SimilarityDefaults = TEST_SIMILARITY) {
  return buildSearchNotesTool({
    registry: makeTestRegistry([]),
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embedQuery: () => Promise.resolve([1]),
    },
    modelKey: 'k',
    similarity,
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

  it('says lexical mode fills the merged cap', () => {
    expect(builtDescription()).toContain(
      '"lexical" runs ONLY exact matching, up to the merged cap; needs no embedding corpus.',
    );
  });

  it('threshold and expansion-floor prose interpolate their constants', async () => {
    const source = await readFile('src/modules/semantic/tools/search-notes.ts', 'utf8');
    expect(source).toContain('${similarity.quick}');
    expect(source).toContain('${similarity.deep}');
    expect(source).toContain('${retryClause(similarity.fallback)}');
    expect(source).toContain('${similarity.expansionFloor}');
    expect(source).toContain('${EFFORT_PROFILES.quick.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.quick.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.quick.mergedCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.deep.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.mergedCap}');
  });

  it('advertises the active profile’s defaults in the ADVERTISED schema', () => {
    // Pinned against the post-gate schema MCP clients receive — the
    // registration's coercing `spec.inputSchema`, converted the way the MCP
    // SDK converts it for `tools/list` (`pipeStrategy: 'input'`) — not against
    // the source file. A source-only grep (the test above) can't catch the two
    // interpolation slots getting swapped, since swapped source still contains
    // every token that grep checks for. Distinct values prove the numbers come
    // from the profile passed in, not from a constant.
    const distinct = {
      quick: 0.61,
      deep: 0.47,
      fallback: 0.42,
      blockFloor: 0.33,
      expansionFloor: 0.73,
      similarNotes: 0.6,
      duplicates: 0.95,
    };
    const { properties } = z.toJSONSchema(
      registerTool(builtTool(distinct)).spec.inputSchema as z.ZodType,
      { io: 'input' },
    ) as { properties: Record<string, { description?: string }> };
    expect(properties.threshold?.description).toContain(
      'effort defaults (0.61 quick / 0.47 deep) with one retry at 0.42',
    );
    expect(properties.expansion_floor?.description).toContain('Default 0.73');
    expect(properties.expansion_floor?.description).not.toContain('0.9+');
  });

  it('advertises no retry for a profile without a fallback', () => {
    const noFallback: SimilarityDefaults = {
      quick: 0.61,
      deep: 0.47,
      blockFloor: 0.33,
      expansionFloor: 0.73,
      similarNotes: 0.6,
      duplicates: 0.95,
    };
    const { properties } = z.toJSONSchema(
      registerTool(builtTool(noFallback)).spec.inputSchema as z.ZodType,
      { io: 'input' },
    ) as { properties: Record<string, { description?: string }> };
    expect(properties.threshold?.description).toContain(
      'effort defaults (0.61 quick / 0.47 deep) with no retry — zero hits are honest',
    );
    expect(properties.threshold?.description).not.toContain('retry at');
  });

  it('tells the agent expansion scores are not query similarities, and the floor does not bind', () => {
    const { properties } = z.toJSONSchema(registerTool(builtTool()).spec.inputSchema as z.ZodType, {
      io: 'input',
    }) as { properties: Record<string, { description?: string }> };
    expect(builtDescription()).toContain(
      '`expansion_similarity` (deep): note-to-note similarity to a semantic hit, not the query; not comparable with `similarity`.',
    );
    expect(properties.expansion_floor?.description).toContain(
      'On harrier-270m neighbour similarities sit at 0.75-0.95, so the default does not bind.',
    );
  });

  it('advertises word-prefix lexical matching, not substring', () => {
    const description = builtDescription();
    expect(description).toContain(
      'LEXICAL MATCHING: case/accent-insensitive word prefix (`пошук` finds `пошуком`);',
    );
    expect(description).not.toMatch(/substring/i);
  });

  it('advertises no retry under the real harrier-270m profile', () => {
    const { properties } = z.toJSONSchema(
      registerTool(builtTool(resolveModelProfile('harrier-270m').similarity)).spec
        .inputSchema as z.ZodType,
      { io: 'input' },
    ) as { properties: Record<string, { description?: string }> };
    expect(properties.threshold?.description).toContain(
      'effort defaults (0.45 quick / 0.45 deep) with no retry',
    );
    expect(properties.threshold?.description).not.toContain('retry at');
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

describe('search_notes evidence coordinates', () => {
  it('states the coordinates read_notes takes and the { path, lines } hand-off', () => {
    const description = builtDescription();
    expect(description).toMatch(/file-relative/);
    expect(description).toMatch(/1-based/);
    expect(description).toMatch(/inclusive/);
    expect(description).toMatch(/\{ path, lines \}/);
  });
});
