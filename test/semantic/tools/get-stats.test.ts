import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { buildGetStatsTool } from '../../../src/modules/semantic/tools/get-stats.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeHandlerDeps,
  makeFakeCorpusIndex,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
} from './_helpers.js';

describe('getStats', () => {
  it('returns corpus stats and the model key', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetStatsTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed: vi.fn(),
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      await expect(tool.handler({})).resolves.toEqual({
        totalNotes: 3,
        totalBlocks: 3,
        embeddingDimension: 3,
        modelKey: 'bge-micro-v2',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('calls corpus.ensureFresh() before reading sources', async () => {
    const sources = new Map();
    const corpus = makeFakeCorpusIndex(sources);
    const tool = buildGetStatsTool(
      makeHandlerDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
        corpus,
      }),
    );

    await tool.handler({});

    expect(corpus.ensureFresh).toHaveBeenCalled();
  });
});
