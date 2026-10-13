import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { EFFORT_PROFILES } from '../../../src/modules/semantic/effort-profiles.js';
import type { SimilarityDefaults } from '../../../src/modules/semantic/model-profiles.js';

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
import { TEST_SIMILARITY } from '../../_identity.js';

function builtTool(similarity: SimilarityDefaults = TEST_SIMILARITY) {
  return buildSearchNotesTool({
    registry: makeTestRegistry([]),
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embedQuery: () => Promise.resolve([1]),
    },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
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

  it('threshold and expansion-floor prose interpolate their constants', async () => {
    const source = await readFile('src/modules/semantic/tools/search-notes.ts', 'utf8');
    expect(source).toContain('${similarity.quick}');
    expect(source).toContain('${similarity.deep}');
    expect(source).toContain('${similarity.fallback}');
    expect(source).toContain('${similarity.expansionFloor}');
    expect(source).toContain('${EFFORT_PROFILES.quick.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.quick.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.quick.mergedCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.semanticPool}');
    expect(source).toContain('${EFFORT_PROFILES.deep.lexicalNoteCap}');
    expect(source).toContain('${EFFORT_PROFILES.deep.mergedCap}');
  });

  it('advertises the active profile’s defaults in the input schema', () => {
    // Pinned against the tool's declared inputSchema converted to JSON
    // Schema the same way the MCP SDK converts it for `tools/list` — not
    // against the source file. A source-only grep (the test above) can't
    // catch the two interpolation slots getting swapped, since swapped
    // source still contains every token that grep checks for.
    //
    // Deliberately NOT `registerTool(builtTool()).spec.inputSchema`:
    // `wrapSchemaWithCoercion` (src/lib/input-coercion.ts, pre-existing,
    // unrelated to this change) unwraps every `.optional()` field down to
    // its inner schema and rebuilds a fresh wrapper around it, which drops
    // the `.describe()` metadata `.optional()` was carrying — so the
    // *coerced* schema advertises no per-field descriptions at all, for any
    // optional field on any tool. `builtTool().inputSchema` is the same zod
    // schema object minus that unrelated stripping step, so it is the
    // faithful stand-in for what the field-level prose says.
    const distinct = {
      quick: 0.61,
      deep: 0.47,
      fallback: 0.42,
      expansionFloor: 0.73,
      similarNotes: 0.6,
      duplicates: 0.95,
    };
    const schema = JSON.stringify(z.toJSONSchema(builtTool(distinct).inputSchema));
    expect(schema).toContain('effort defaults (0.61 quick / 0.47 deep) with one retry at 0.42');
    expect(schema).toContain('Default 0.73');
    expect(schema).not.toContain('0.9+');
  });
});
