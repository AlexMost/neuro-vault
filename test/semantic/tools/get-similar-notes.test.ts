import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { buildGetSimilarNotesTool } from '../../../src/modules/semantic/tools/get-similar-notes.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeHandlerDeps,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
} from './_helpers.js';

describe('getSimilarNotes', () => {
  it('filters stale paths from get_similar_notes results', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const pathExists = vi.fn(async (notePath: string) => notePath !== 'Folder/note-b.md');
      const tool = buildGetSimilarNotesTool(
        makeHandlerDeps({
          sources: corpus.sources,
          embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
          pathExists,
        }),
      );

      const results = await tool.handler({
        path: 'Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((r) => r.path)).toEqual(['Folder/note-c.md']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unknown note path for similar-note lookup', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetSimilarNotesTool(
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

      await expect(tool.handler({ path: 'Folder/missing.md' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('excludes the source note from similar-note results', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetSimilarNotesTool(
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

      const results = await tool.handler({
        path: 'Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((result) => result.path)).toEqual([
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
      expect(results.map((result) => result.path)).not.toContain('Folder/note-a.md');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes safe relative note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetSimilarNotesTool(
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

      const results = await tool.handler({
        path: './Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((result) => result.path)).toEqual([
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects note path traversal attempts', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetSimilarNotesTool(
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

      await expect(tool.handler({ path: '../Folder/note-a.md' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Windows-style absolute note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const tool = buildGetSimilarNotesTool(
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

      await expect(tool.handler({ path: 'C:/vault/Folder/note-a.md' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
