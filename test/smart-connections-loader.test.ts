import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  loadSmartConnectionsCorpus,
  summarizeSmartConnectionsCorpus,
} from '../src/smart-connections-loader.js';

const fixturesRoot = path.resolve(
  '/Users/amostovenko/git/neuro-vault/.worktrees/neuro-vault-mcp/test/fixtures/vault/.smart-env/multi',
);

async function makeVaultFixture(fileNames: string[]) {
  const tempRoot = await fs.mkdtemp(path.join(process.cwd(), 'smart-loader-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');

  await fs.mkdir(smartEnvPath, { recursive: true });

  for (const fileName of fileNames) {
    await fs.copyFile(
      path.join(fixturesRoot, fileName),
      path.join(smartEnvPath, fileName),
    );
  }

  return { tempRoot, vaultPath, smartEnvPath };
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
      expect(noteA?.embedding.every((value) => typeof value === 'number')).toBe(
        true,
      );
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
