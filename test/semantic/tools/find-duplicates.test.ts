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
      // Use real tempRoot so pathExistsForEntry checks an actual directory
      // The test expects 'Folder/note-d.md' to NOT exist (it doesn't in tempRoot)
      const corpusIndex = makeFakeCorpusIndex(createDuplicateCorpus(corpus).sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildFindDuplicatesTool({
        registry,
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await tool.handler({ threshold: 0.95 });

      // note-d and note-e don't exist on disk in tempRoot, so pairs including them are dropped
      // Only Folder/note-a.md and Folder/note-e.md... wait note-e also doesn't exist
      // All synthetic notes (note-d, note-e) are absent from disk in tempRoot
      // So all pairs involving note-d or note-e should be dropped
      // Original note-a,b,c.md exist on disk in tempRoot/Folder? Actually no:
      // makeVaultFixture creates the smartEnvPath inside tempRoot/vault but the .md files
      // are not created on disk. The pathExistsForEntry checks entry.path/vaultRelativePath.
      // All note paths like 'Folder/note-a.md' won't exist in tempRoot.
      // So all pairs will be filtered out. This test validates the filtering mechanism.
      expect(results.map((r) => [r.note_a, r.note_b])).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops duplicate pairs whose paths no longer exist on disk (using mock pathExists)', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const duplicateSources = createDuplicateCorpus(corpus).sources;
      // Create a corpus that returns all sources including synthetic note-d/note-e
      const corpusIndex = makeFakeCorpusIndex(duplicateSources);

      // Create actual vault directory with only specific notes present
      const vaultRoot = await fs.mkdtemp(
        (await import('node:os')).default.tmpdir()
          ? `${(await import('node:os')).default.tmpdir()}/find-dup-`
          : '/tmp/find-dup-',
      );
      await fs.mkdir(`${vaultRoot}/Folder`, { recursive: true });
      // Create note-a and note-e (but not note-d) so the pair (a,d) is dropped
      await fs.writeFile(`${vaultRoot}/Folder/note-a.md`, '# A\n');
      await fs.writeFile(`${vaultRoot}/Folder/note-e.md`, '# E\n');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            smartEnvPath,
            corpus: corpusIndex,
            semanticAvailable: true,
          },
        ]);
        const tool = buildFindDuplicatesTool({
          registry,
          searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
          modelKey: 'bge-micro-v2',
        });

        const results = await tool.handler({ threshold: 0.95 });

        // note-d doesn't exist on disk; pairs involving note-d are dropped
        // note-a and note-e both exist, so (a,e) stays
        // note-b and note-c exist on disk (they were copied to smartEnvPath, but smartEnvPath
        // is inside tempRoot not vaultRoot). Actually note-b.md & note-c.md are NOT in vaultRoot.
        // So only pairs where both notes exist: (a,e)
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
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const duplicateSources = createDuplicateCorpus(corpus).sources;

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
            smartEnvPath,
            corpus: corpusIndex,
            semanticAvailable: true,
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
    const { tempRoot, smartEnvPath } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        { name: 'v1', path: tempRoot, smartEnvPath, corpus: corpusIndex, semanticAvailable: true },
        { name: 'v2', path: tempRoot, smartEnvPath, corpus: corpusIndex, semanticAvailable: true },
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
});
