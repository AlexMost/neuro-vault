import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { buildFindDuplicatesTool } from '../../../src/modules/semantic/tools/find-duplicates.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeHandlerDeps,
  createDuplicateCorpus,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
} from './_helpers.js';

describe('findDuplicates', () => {
  it('drops duplicate pairs whose paths no longer exist on disk', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const pathExists = vi.fn(async (notePath: string) => notePath !== 'Folder/note-d.md');
      const tool = buildFindDuplicatesTool(
        makeHandlerDeps({
          sources: createDuplicateCorpus(corpus).sources,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
          pathExists,
        }),
      );

      const results = await tool.handler({ threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
        ['Folder/note-a.md', 'Folder/note-e.md'],
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns matching duplicate pairs', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildFindDuplicatesTool(
        makeHandlerDeps({
          sources: createDuplicateCorpus(corpus).sources,
          embeddingProvider: {
            initialize: vi.fn(),
            embed: vi.fn(),
          },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        }),
      );

      const results = await tool.handler({ threshold: 0.95 });

      expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
        ['Folder/note-a.md', 'Folder/note-d.md'],
        ['Folder/note-a.md', 'Folder/note-e.md'],
        ['Folder/note-d.md', 'Folder/note-e.md'],
      ]);
      expect(results.every((result) => result.similarity >= 0.95)).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
