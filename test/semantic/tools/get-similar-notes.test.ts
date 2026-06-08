import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildGetSimilarNotesTool } from '../../../src/modules/semantic/tools/get-similar-notes.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeCorpusIndex,
  makeSyntheticSource,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
  loadSmartConnectionsCorpus,
} from './_helpers.js';
import type { SmartSource } from './_helpers.js';

// Create a temp vault root with specific note files on disk.
// Returns { vaultRoot, cleanup }.
async function makeTempVault(
  notes: Record<string, string> = {},
): Promise<{ vaultRoot: string; cleanup: () => Promise<void> }> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-notes-'));
  for (const [notePath, content] of Object.entries(notes)) {
    const full = path.join(vaultRoot, notePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { vaultRoot, cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }) };
}

describe('getSimilarNotes', () => {
  it('filters stale paths from get_similar_notes results', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    // Create vault with note-a and note-c present, but NOT note-b (simulates stale)
    const { vaultRoot, cleanup: cleanupVault } = await makeTempVault({
      'Folder/note-a.md': '# A\n',
      'Folder/note-c.md': '# C\n',
    });

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await tool.handler({
        path: 'Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((r) => r.path)).toEqual(['Folder/note-c.md']);
    } finally {
      await cleanupVault();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('auto-appends .md to a path without an extension', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    const { vaultRoot, cleanup: cleanupVault } = await makeTempVault({
      'Folder/note-a.md': '# A\n',
      'Folder/note-c.md': '# C\n',
    });

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      // Note: path passed WITHOUT .md — must resolve to Folder/note-a.md and
      // return Folder/note-c.md as the similar candidate.
      const results = await tool.handler({
        path: 'Folder/note-a',
        threshold: 0,
      });

      expect(results.map((r) => r.path)).toEqual(['Folder/note-c.md']);
    } finally {
      await cleanupVault();
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

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

    const { vaultRoot, cleanup: cleanupVault } = await makeTempVault({
      'Folder/note-a.md': '# A\n',
      'Folder/note-b.md': '# B\n',
      'Folder/note-c.md': '# C\n',
    });

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

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
      await cleanupVault();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes safe relative note paths', async () => {
    const { tempRoot, smartEnvPath } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    const { vaultRoot, cleanup: cleanupVault } = await makeTempVault({
      'Folder/note-a.md': '# A\n',
      'Folder/note-b.md': '# B\n',
      'Folder/note-c.md': '# C\n',
    });

    try {
      const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
      const corpusIndex = makeFakeCorpusIndex(corpus.sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          smartEnvPath,
          corpus: corpusIndex,
          semanticAvailable: true,
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      const results = await tool.handler({
        path: './Folder/note-a.md',
        threshold: 0,
      });

      expect(results.map((result) => result.path)).toEqual([
        'Folder/note-b.md',
        'Folder/note-c.md',
      ]);
    } finally {
      await cleanupVault();
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: 'bge-micro-v2',
      });

      await expect(tool.handler({ path: 'C:/vault/Folder/note-a.md' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(tool.handler({ path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'VAULT_REQUIRED',
      });
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
      });

      await expect(tool.handler({ vault: 'v', path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('getSimilarNotes — graph signals', () => {
  function makeSources(): Map<string, SmartSource> {
    const m = new Map<string, SmartSource>();
    // A is the query note; orthogonal embeddings for B/C/D so they only
    // surface via forward link, not via semantic similarity.
    m.set('Folder/A.md', makeSyntheticSource('Folder/A.md', [1, 0, 0]));
    m.set('Folder/B.md', makeSyntheticSource('Folder/B.md', [0, 1, 0]));
    m.set('Folder/C.md', makeSyntheticSource('Folder/C.md', [0, 1, 0]));
    m.set('Folder/D.md', makeSyntheticSource('Folder/D.md', [0, 1, 0]));
    // E is highly similar to A semantically but not linked.
    m.set('Folder/E.md', makeSyntheticSource('Folder/E.md', [0.95, 0.05, 0]));
    return m;
  }

  // Build a tool backed by a temp vault directory with specific note bodies.
  // All notes in sources are pre-created on disk unless excluded via absentPaths.
  async function buildToolWithVault(
    opts: {
      sources?: Map<string, SmartSource>;
      body?: string;
      absentPaths?: string[];
    } = {},
  ): Promise<{
    tool: ReturnType<typeof buildGetSimilarNotesTool>;
    cleanup: () => Promise<void>;
  }> {
    const sources = opts.sources ?? makeSources();
    const body = opts.body ?? '# A\n\nSome text [[B]] and [[C]].\n';
    // Write A with the given body; all other notes get empty content.
    const notes: Record<string, string> = {};
    const absent = new Set(opts.absentPaths ?? []);
    for (const [notePath] of sources) {
      if (!absent.has(notePath)) {
        notes[notePath] =
          notePath === 'Folder/A.md'
            ? `---\nrelated: "[[D]]"\n---\n${body}`
            : `# ${path.basename(notePath, '.md')}\n`;
      }
    }
    const { vaultRoot, cleanup } = await makeTempVault(notes);
    const corpusIndex = makeFakeCorpusIndex(sources);
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: vaultRoot,
        smartEnvPath: path.join(vaultRoot, '.smart-env'),
        corpus: corpusIndex,
        semanticAvailable: true,
      },
    ]);
    const tool = buildGetSimilarNotesTool({
      registry,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
      modelKey: MODEL_KEY,
    });
    return { tool, cleanup };
  }

  it('surfaces forward-linked notes even when their semantic similarity is below threshold', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0.9 });
      const paths = results.map((r) => r.path);
      expect(paths).toContain('Folder/B.md');
      expect(paths).toContain('Folder/C.md');
      expect(paths).toContain('Folder/D.md');
      for (const p of ['Folder/B.md', 'Folder/C.md', 'Folder/D.md']) {
        const r = results.find((x) => x.path === p)!;
        expect(r.signals.forward_link).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('returns semantic-only neighbors with signals.semantic set', async () => {
    const { tool, cleanup } = await buildToolWithVault({ body: '# A\n\nNo links here.\n' });
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      const e = results.find((r) => r.path === 'Folder/E.md');
      expect(e).toBeDefined();
      expect(e!.signals.semantic).toBeGreaterThan(0);
      expect(e!.signals.forward_link).toBeUndefined();
      expect(e!.similarity).toBe(e!.signals.semantic);
    } finally {
      await cleanup();
    }
  });

  it('ranks forward-linked results ahead of semantic-only ones regardless of similarity', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      const indexOf = (p: string) => results.findIndex((r) => r.path === p);
      const eIdx = indexOf('Folder/E.md');
      expect(eIdx).toBeGreaterThan(indexOf('Folder/B.md'));
      expect(eIdx).toBeGreaterThan(indexOf('Folder/C.md'));
      expect(eIdx).toBeGreaterThan(indexOf('Folder/D.md'));
    } finally {
      await cleanup();
    }
  });

  it('combines signals when a path is both linked and semantically close', async () => {
    const sources = makeSources();
    sources.set('Folder/B.md', makeSyntheticSource('Folder/B.md', [0.99, 0.01, 0]));
    const { tool, cleanup } = await buildToolWithVault({ sources });
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      const b = results.find((r) => r.path === 'Folder/B.md')!;
      expect(b.signals.forward_link).toBe(true);
      expect(b.signals.semantic).toBeGreaterThan(0);
      expect(b.similarity).toBe(b.signals.semantic);
    } finally {
      await cleanup();
    }
  });

  it('removes results matching exclude_folders prefixes', async () => {
    const sources = makeSources();
    sources.set('Templates/X.md', makeSyntheticSource('Templates/X.md', [0.99, 0, 0]));
    const { tool, cleanup } = await buildToolWithVault({
      sources,
      body: '# A\n\n[[B]] [[Templates/X]]\n',
    });
    try {
      const results = await tool.handler({
        path: 'Folder/A.md',
        threshold: 0,
        exclude_folders: ['Templates'],
      });
      expect(results.map((r) => r.path)).not.toContain('Templates/X.md');
      expect(results.map((r) => r.path)).toContain('Folder/B.md');
    } finally {
      await cleanup();
    }
  });

  it('honours limit and preserves linked-first ordering during truncation', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0, limit: 2 });
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.signals.forward_link).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('silently skips broken wikilinks without throwing', async () => {
    const { tool, cleanup } = await buildToolWithVault({
      body: '# A\n\n[[Nonexistent]] but [[B]] exists\n',
    });
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      expect(results.map((r) => r.path)).toContain('Folder/B.md');
      expect(results.map((r) => r.path)).not.toContain('Nonexistent');
    } finally {
      await cleanup();
    }
  });

  it('respects pathExists filter on linked targets too', async () => {
    // Folder/B.md is absent from disk, so it should be filtered out despite being linked
    const { tool, cleanup } = await buildToolWithVault({
      absentPaths: ['Folder/B.md'],
    });
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      expect(results.map((r) => r.path)).not.toContain('Folder/B.md');
      expect(results.map((r) => r.path)).toContain('Folder/C.md');
      expect(results.map((r) => r.path)).toContain('Folder/D.md');
    } finally {
      await cleanup();
    }
  });

  it('stamps vault name on every result item', async () => {
    const { tool, cleanup } = await buildToolWithVault({ body: '# A\n\nNo links here.\n' });
    try {
      const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.vault === 'v')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // `exclude_folders` is a plain (non-union) array param; these guard that the
  // central coercion layer parses a stringified array for it at the registration
  // boundary (the schema the MCP SDK validates raw args against before the
  // handler runs). The array form's behaviour is covered by
  // 'removes results matching exclude_folders prefixes' above.
  it('coerces a stringified exclude_folders array at the registration boundary', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const reg = registerTool(tool);
      const parsed = (reg.spec.inputSchema as z.ZodType).parse({
        path: 'Folder/A.md',
        exclude_folders: '["Templates"]',
      });
      expect((parsed as { exclude_folders: string[] }).exclude_folders).toEqual(['Templates']);
    } finally {
      await cleanup();
    }
  });

  it('rejects a non-array exclude_folders string with a shape-naming message', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const reg = registerTool(tool);
      const result = (reg.spec.inputSchema as z.ZodType).safeParse({
        path: 'Folder/A.md',
        exclude_folders: 'Templates',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/array/i);
      }
    } finally {
      await cleanup();
    }
  });
});
