import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  loadSmartConnectionsCorpus,
  summarizeSmartConnectionsCorpus,
} from '../src/smart-connections-loader.js';
import type { SmartSource } from '../src/types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(testDir, 'fixtures/vault/.smart-env/multi');

async function makeVaultFixture(fileNames: string[]) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-loader-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

  await fs.mkdir(smartEnvPath, { recursive: true });

  for (const fileName of fileNames) {
    await fs.copyFile(path.join(fixturesRoot, fileName), path.join(smartEnvPath, fileName));
  }

  return { tempRoot, vaultPath, smartEnvPath };
}

function createCorpus(sources: Array<[string, SmartSource]>) {
  return {
    sources: new Map<string, SmartSource>(sources),
  };
}

describe('loadSmartConnectionsCorpus', () => {
  it('discovers every .ajson file in the directory and normalizes note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath);

      expect(corpus.sources).toBeInstanceOf(Map);
      expect([...corpus.sources.keys()]).toEqual([
        'Folder/note-a.md',
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads numeric embeddings and preserves blocks for display', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath);
      const noteA = corpus.sources.get('Folder/note-a.md');

      expect(noteA).toMatchObject({
        path: 'Folder/note-a.md',
        embedding: [1, 0, 0],
        blocks: [{ text: 'alpha concept' }],
      });
      expect(noteA?.embedding).toEqual([1, 0, 0]);
      expect(noteA?.embedding.every((value) => typeof value === 'number')).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('summarizes total notes, blocks, and embedding dimension', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath);
      expect(summarizeSmartConnectionsCorpus(corpus)).toEqual({
        totalNotes: 3,
        totalBlocks: 3,
        embeddingDimension: 3,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when two files normalize to the same note path', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'duplicate-path.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath)).rejects.toThrow(
        /duplicate smart connections note path/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when a block is missing usable text', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'invalid-blocks.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath)).rejects.toThrow(
        /block without usable text/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when note embeddings use mixed dimensions', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'mixed-dimension.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath)).rejects.toThrow(
        /mixed embedding dimensions/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports mixed embedding dimensions from the stats helper', () => {
    const corpus = createCorpus([
      [
        'Folder/note-a.md',
        {
          path: 'Folder/note-a.md',
          embedding: [1, 0, 0],
          blocks: [{ text: 'alpha concept' }],
        },
      ],
      [
        'Folder/note-d.md',
        {
          path: 'Folder/note-d.md',
          embedding: [0, 1, 0, 0],
          blocks: [{ text: 'delta concept' }],
        },
      ],
    ]);

    expect(() => summarizeSmartConnectionsCorpus(corpus)).toThrow(/mixed embedding dimensions/i);
  });

  it('fails fast when any .ajson file cannot be parsed or normalized', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'invalid.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath)).rejects.toThrow(
        /invalid\.ajson|usable note path|embedding/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
