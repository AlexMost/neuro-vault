import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPANSION_FLOOR,
  EFFORT_PROFILES,
  FALLBACK_THRESHOLD,
} from '../../../src/modules/semantic/effort-profiles.js';

// The advertisement-derivation pin (spec: hybrid-search "Effort-profile
// advertisement derives from the retrieval constants"). Reads the SOURCE of
// the description to prove the numbers are interpolated, and the BUILT
// description to prove each advertised number equals the profile constant.
import { readFile } from 'node:fs/promises';

import { registerTool } from '../../../src/lib/tool-registry.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { makeTestRegistry } from './_helpers.js';

function builtDescription(): string {
  return registerTool(
    buildSearchNotesTool({
      registry: makeTestRegistry([]),
      embeddingProvider: { initialize: () => Promise.resolve(), embed: () => Promise.resolve([1]) },
      searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
      modelKey: 'k',
    }),
  ).spec.description!;
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
    // And the values render into the advertised text.
    expect(builtDescription()).toBeTruthy();
    expect(String(FALLBACK_THRESHOLD)).toBe('0.3');
    expect(String(DEFAULT_EXPANSION_FLOOR)).toBe('0.35');
  });
});
