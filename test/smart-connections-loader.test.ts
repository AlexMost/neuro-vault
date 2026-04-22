import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  loadSmartConnectionsCorpus,
  parseAjsonContent,
  summarizeSmartConnectionsCorpus,
} from '../src/smart-connections-loader.js';
import type { SmartSource } from '../src/types.js';

const MODEL_KEY = 'bge-micro-v2';
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

describe('parseAjsonContent', () => {
  it('parses multiple entries from a single line', () => {
    const content =
      '"smart_sources:note.md": {"path":"note.md"},"smart_blocks:note.md#heading": {"key":"note.md#heading"},';
    const entries = parseAjsonContent(content);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe('smart_sources:note.md');
    expect(entries[0]!.value).toEqual({ path: 'note.md' });
    expect(entries[1]!.key).toBe('smart_blocks:note.md#heading');
    expect(entries[1]!.value).toEqual({ key: 'note.md#heading' });
  });

  it('parses entries across multiple lines', () => {
    const content = [
      '"smart_sources:a.md": {"path":"a.md"},',
      '"smart_blocks:a.md#h1": {"key":"a.md#h1"},',
    ].join('\n');

    const entries = parseAjsonContent(content);
    expect(entries).toHaveLength(2);
  });

  it('skips empty lines', () => {
    const content = '\n"smart_sources:a.md": {"path":"a.md"},\n\n';
    const entries = parseAjsonContent(content);
    expect(entries).toHaveLength(1);
  });

  it('skips entries with null values', () => {
    const content =
      '"smart_sources:note.md": {"path":"note.md"},"smart_blocks:note.md#heading": null,"smart_blocks:note.md#other": {"key":"note.md#other"},';
    const entries = parseAjsonContent(content);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe('smart_sources:note.md');
    expect(entries[1]!.key).toBe('smart_blocks:note.md#other');
  });
});

describe('loadSmartConnectionsCorpus', () => {
  it('discovers every .ajson file in the directory and normalizes note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);

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

  it('loads numeric embeddings and preserves blocks', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const noteA = corpus.sources.get('Folder/note-a.md');

      expect(noteA).toMatchObject({
        path: 'Folder/note-a.md',
        embedding: [1, 0, 0],
      });
      expect(noteA?.embedding).toEqual([1, 0, 0]);
      expect(noteA?.embedding.every((value) => typeof value === 'number')).toBe(true);
      expect(noteA?.blocks).toHaveLength(1);
      expect(noteA?.blocks[0]).toMatchObject({
        heading: '#alpha concept',
        lines: [1, 3],
      });
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
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      expect(summarizeSmartConnectionsCorpus(corpus)).toEqual({
        totalNotes: 3,
        totalBlocks: 3,
        embeddingDimension: 3,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses last-write-wins when duplicate note paths appear (append-only format)', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'duplicate-path.ajson',
    ]);

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      expect(corpus.sources.has('Folder/note-a.md')).toBe(true);
      expect(corpus.sources.size).toBe(3);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when a block has an invalid line range', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'invalid-blocks.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY)).rejects.toThrow(
        /invalid block line range/i,
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
      await expect(loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY)).rejects.toThrow(
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
          blocks: [
            {
              key: 'Folder/note-a.md#alpha',
              heading: '#alpha',
              lines: [1, 3] as [number, number],
              embedding: [],
            },
          ],
        },
      ],
      [
        'Folder/note-d.md',
        {
          path: 'Folder/note-d.md',
          embedding: [0, 1, 0, 0],
          blocks: [
            {
              key: 'Folder/note-d.md#delta',
              heading: '#delta',
              lines: [1, 3] as [number, number],
              embedding: [],
            },
          ],
        },
      ],
    ]);

    expect(() => summarizeSmartConnectionsCorpus(corpus)).toThrow(/mixed embedding dimensions/i);
  });

  it('fails fast when any .ajson file has a source without a usable path', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'invalid.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY)).rejects.toThrow(
        /usable note path/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when a note path is absolute instead of vault-relative', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
      'absolute-path.ajson',
    ]);

    try {
      await expect(loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY)).rejects.toThrow(
        /vault-relative and POSIX-like/i,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
