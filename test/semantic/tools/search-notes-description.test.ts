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
    embeddingProvider: { initialize: () => Promise.resolve(), embed: () => Promise.resolve([1]) },
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
    const schema = JSON.stringify(z.toJSONSchema(builtTool().inputSchema));
    expect(schema).toContain(
      `effort defaults (${EFFORT_PROFILES.quick.semanticThreshold} quick / ${EFFORT_PROFILES.deep.semanticThreshold} deep) with one retry at ${FALLBACK_THRESHOLD}`,
    );
    expect(schema).toContain(`Default ${DEFAULT_EXPANSION_FLOOR}`);
  });
});
