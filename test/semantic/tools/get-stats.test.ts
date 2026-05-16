import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { buildGetStatsTool } from '../../../src/modules/semantic/tools/get-stats.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeCorpusIndex,
  loadSmartConnectionsCorpus,
} from './_helpers.js';

describe('getStats', () => {
  it('returns corpus stats, the model key, and vault name', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildGetStatsTool({ registry, modelKey: 'bge-micro-v2' });

      await expect(tool.handler({})).resolves.toEqual({
        vault: 'v',
        totalNotes: 3,
        totalBlocks: 3,
        embeddingDimension: 3,
        modelKey: 'bge-micro-v2',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws VAULT_REQUIRED in multi-vault mode when vault: is omitted', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        { name: 'v1', path: tempRoot, smartEnvPath, corpus: corpusIndex, semanticAvailable: true },
        { name: 'v2', path: tempRoot, smartEnvPath, corpus: corpusIndex, semanticAvailable: true },
      ]);
      const tool = buildGetStatsTool({ registry, modelKey: MODEL_KEY });

      await expect(tool.handler({})).rejects.toMatchObject({ code: 'VAULT_REQUIRED' });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws SEMANTIC_INDEX_NOT_FOUND when vault has semanticAvailable: false', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          smartEnvPath,
          corpus: undefined,
          semanticAvailable: false,
          semanticUnavailableReason: 'no corpus',
        },
      ]);
      const tool = buildGetStatsTool({ registry, modelKey: MODEL_KEY });

      await expect(tool.handler({ vault: 'v' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
