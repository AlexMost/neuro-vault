import fs from 'node:fs/promises';
import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildFindDuplicatesTool } from '../../../src/modules/semantic/tools/find-duplicates.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeCorpusIndex,
  createDuplicateCorpus,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  toBackend,
} from './_helpers.js';

describe('findDuplicates', () => {
  it('drops duplicate pairs whose paths no longer exist on disk', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      // Use real tempRoot so entry.filterExisting checks an actual directory.
      // None of the fixture's note paths (nor the synthetic note-d/note-e)
      // exist on disk in tempRoot, so every pair is filtered out — this test
      // validates the filtering mechanism, not the ranking.
      const corpusIndex = makeFakeCorpusIndex(createDuplicateCorpus(sources).sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await tool.handler({ threshold: 0.95 });

      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops duplicate pairs whose paths no longer exist on disk (partially populated vault)', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const duplicateSources = createDuplicateCorpus(sources).sources;
      // Create a corpus that returns all sources including synthetic note-d/note-e
      const corpusIndex = makeFakeCorpusIndex(duplicateSources);

      // Create actual vault directory with only specific notes present
      const vaultRoot = await fs.mkdtemp(`${os.tmpdir()}/find-dup-`);
      await fs.mkdir(`${vaultRoot}/Folder`, { recursive: true });
      // Create note-a and note-e (but not note-d) so the pair (a,d) is dropped
      await fs.writeFile(`${vaultRoot}/Folder/note-a.md`, '# A\n');
      await fs.writeFile(`${vaultRoot}/Folder/note-e.md`, '# E\n');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            backend: toBackend(corpusIndex),
          },
        ]);
        const tool = buildFindDuplicatesTool({
          registry,
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        });

        const results = await tool.handler({ threshold: 0.95 });

        // note-d doesn't exist on disk; pairs involving note-d are dropped.
        // note-a and note-e both exist, so (a,e) stays; note-b and note-c
        // (the fixture's real notes) don't exist in vaultRoot either.
        expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
          ['Folder/note-a.md', 'Folder/note-e.md'],
        ]);
        expect(results.every((r) => r.vault === 'v')).toBe(true);
      } finally {
        await fs.rm(vaultRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns matching duplicate pairs with vault stamp', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const duplicateSources = createDuplicateCorpus(sources).sources;

      // Create vault with all required notes so nothing is filtered
      const vaultRoot = await fs.mkdtemp(`${os.tmpdir()}/find-dup2-`);
      await fs.mkdir(`${vaultRoot}/Folder`, { recursive: true });
      for (const name of ['note-a.md', 'note-b.md', 'note-c.md', 'note-d.md', 'note-e.md']) {
        await fs.writeFile(`${vaultRoot}/Folder/${name}`, `# ${name}\n`);
      }

      try {
        const corpusIndex = makeFakeCorpusIndex(duplicateSources);
        const registry = makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            backend: toBackend(corpusIndex),
          },
        ]);
        const tool = buildFindDuplicatesTool({
          registry,
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        });

        const results = await tool.handler({ threshold: 0.95 });

        expect(results.map((result) => [result.note_a, result.note_b])).toEqual([
          ['Folder/note-a.md', 'Folder/note-d.md'],
          ['Folder/note-a.md', 'Folder/note-e.md'],
          ['Folder/note-d.md', 'Folder/note-e.md'],
        ]);
        expect(results.every((result) => result.similarity >= 0.95)).toBe(true);
        expect(results.every((result) => result.vault === 'v')).toBe(true);
      } finally {
        await fs.rm(vaultRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws VAULT_REQUIRED in multi-vault mode when vault: is omitted', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        { name: 'v1', path: tempRoot, backend: toBackend(corpusIndex) },
        { name: 'v2', path: tempRoot, backend: toBackend(corpusIndex) },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(tool.handler({})).rejects.toMatchObject({ code: 'VAULT_REQUIRED' });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws SEMANTIC_INDEX_NOT_FOUND when vault has no semantic backend', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
        },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(tool.handler({ vault: 'v' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
  it('honours a substituted existence filter with no files on disk', async () => {
    const corpus = makeFakeCorpusIndex(
      new Map([
        ['Folder/note-d.md', { path: 'Folder/note-d.md', embedding: [1, 0, 0], blocks: [] }],
        ['Folder/note-e.md', { path: 'Folder/note-e.md', embedding: [1, 0, 0], blocks: [] }],
      ]),
    );
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: '/nonexistent',
        backend: toBackend(corpus),
        // Everything the corpus names is declared present — no temp dir.
        filterExisting: async (paths) => new Set(paths),
      },
    ]);
    const tool = buildFindDuplicatesTool({
      registry,
      searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
      modelKey: MODEL_KEY,
    });

    const results = await tool.handler({ threshold: 0.95 });

    expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
      ['Folder/note-d.md', 'Folder/note-e.md'],
    ]);
  });
});
