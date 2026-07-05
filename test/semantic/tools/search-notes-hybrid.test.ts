import { describe, expect, it, vi } from 'vitest';

import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { makeSearchDeps } from './_helpers.js';

function makeMockEngine() {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

describe('search_notes input axes (SDK gate)', () => {
  async function makeTool() {
    const { deps, cleanup } = await makeSearchDeps({
      sources: new Map(),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeMockEngine(),
      modelKey: 'k',
    });
    return { tool: buildSearchNotesTool(deps), cleanup };
  }

  it('rejects old mode values quick/deep', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      for (const bad of ['quick', 'deep']) {
        const parsed = tool.inputSchema.safeParse({ query: 'x', mode: bad });
        expect(parsed.success).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });

  it('accepts the new axes and defaults', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: 'x' }).success).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'hybrid', effort: 'deep' }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'lexical', effort: 'quick' }).success,
      ).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', effort: 'exhaustive' }).success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('response carries semantic_matches and lexical_matches, no results key', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      const out = await tool.handler({ query: 'x' });
      expect(out).toHaveProperty('semantic_matches');
      expect(out).toHaveProperty('lexical_matches');
      expect(out).not.toHaveProperty('results');
    } finally {
      await cleanup();
    }
  });
});
