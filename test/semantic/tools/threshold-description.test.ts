import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { registerTool, type ITool } from '../../../src/lib/tool-registry.js';
import { buildFindDuplicatesTool } from '../../../src/modules/semantic/tools/find-duplicates.js';
import { buildGetSimilarNotesTool } from '../../../src/modules/semantic/tools/get-similar-notes.js';
import { makeTestRegistry } from './_helpers.js';

// Each profile has its own similarity scale, so a caller cannot guess a
// threshold: the ADVERTISED schema (post-gate, as `tools/list` sends it) must
// name the active profile's default. Distinct values prove the number comes
// from the profile passed in, not from a constant.
const distinct = {
  quick: 0.61,
  deep: 0.47,
  fallback: 0.42,
  expansionFloor: 0.73,
  similarNotes: 0.37,
  duplicates: 0.83,
};

function advertisedThreshold<I, O>(tool: ITool<I, O>): string | undefined {
  const { properties } = z.toJSONSchema(registerTool(tool).spec.inputSchema as z.ZodType, {
    io: 'input',
  }) as { properties: Record<string, { description?: string }> };
  return properties.threshold?.description;
}

describe('threshold advertises the active profile default', () => {
  it('get_similar_notes names similarNotes', () => {
    const tool = buildGetSimilarNotesTool({
      registry: makeTestRegistry([]),
      embeddingProvider: {
        initialize: () => Promise.resolve(),
        embedQuery: () => Promise.resolve([1]),
      },
      modelKey: 'k',
      similarity: distinct,
    });
    expect(advertisedThreshold(tool)).toContain('Default 0.37');
  });

  it('find_duplicates names duplicates', () => {
    const tool = buildFindDuplicatesTool({
      registry: makeTestRegistry([]),
      modelKey: 'k',
      similarity: distinct,
    });
    expect(advertisedThreshold(tool)).toContain('Default 0.83');
  });
});
