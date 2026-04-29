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
  buildBasenameIndex,
  makeSyntheticSource,
} from './_helpers.js';
import type { PathExistsCheck, SmartSource } from './_helpers.js';

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

  function buildTool(
    opts: {
      sources?: Map<string, SmartSource>;
      body?: string;
      pathExists?: PathExistsCheck;
    } = {},
  ) {
    const sources = opts.sources ?? makeSources();
    const body = opts.body ?? '# A\n\nSome text [[B]] and [[C]].\n';
    const readNoteContent = vi.fn(async () => `---\nrelated: "[[D]]"\n---\n${body}`);
    return buildGetSimilarNotesTool(
      makeHandlerDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
        searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
        modelKey: MODEL_KEY,
        pathExists: opts.pathExists,
        basenameIndex: buildBasenameIndex(sources.keys()),
        readNoteContent,
      }),
    );
  }

  it('surfaces forward-linked notes even when their semantic similarity is below threshold', async () => {
    const tool = buildTool();
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0.9 });
    const paths = results.map((r) => r.path);
    expect(paths).toContain('Folder/B.md');
    expect(paths).toContain('Folder/C.md');
    expect(paths).toContain('Folder/D.md');
    for (const path of ['Folder/B.md', 'Folder/C.md', 'Folder/D.md']) {
      const r = results.find((x) => x.path === path)!;
      expect(r.signals.forward_link).toBe(true);
    }
  });

  it('returns semantic-only neighbors with signals.semantic set', async () => {
    const tool = buildTool({ body: '# A\n\nNo links here.\n' });
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
    const e = results.find((r) => r.path === 'Folder/E.md');
    expect(e).toBeDefined();
    expect(e!.signals.semantic).toBeGreaterThan(0);
    expect(e!.signals.forward_link).toBeUndefined();
    expect(e!.similarity).toBe(e!.signals.semantic);
  });

  it('ranks forward-linked results ahead of semantic-only ones regardless of similarity', async () => {
    const tool = buildTool();
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
    const indexOf = (p: string) => results.findIndex((r) => r.path === p);
    const eIdx = indexOf('Folder/E.md');
    expect(eIdx).toBeGreaterThan(indexOf('Folder/B.md'));
    expect(eIdx).toBeGreaterThan(indexOf('Folder/C.md'));
    expect(eIdx).toBeGreaterThan(indexOf('Folder/D.md'));
  });

  it('combines signals when a path is both linked and semantically close', async () => {
    const sources = makeSources();
    sources.set('Folder/B.md', makeSyntheticSource('Folder/B.md', [0.99, 0.01, 0]));
    const tool = buildTool({ sources });
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
    const b = results.find((r) => r.path === 'Folder/B.md')!;
    expect(b.signals.forward_link).toBe(true);
    expect(b.signals.semantic).toBeGreaterThan(0);
    expect(b.similarity).toBe(b.signals.semantic);
  });

  it('removes results matching exclude_folders prefixes', async () => {
    const sources = makeSources();
    sources.set('Templates/X.md', makeSyntheticSource('Templates/X.md', [0.99, 0, 0]));
    const tool = buildTool({
      sources,
      body: '# A\n\n[[B]] [[Templates/X]]\n',
    });
    const results = await tool.handler({
      path: 'Folder/A.md',
      threshold: 0,
      exclude_folders: ['Templates'],
    });
    expect(results.map((r) => r.path)).not.toContain('Templates/X.md');
    expect(results.map((r) => r.path)).toContain('Folder/B.md');
  });

  it('honours limit and preserves linked-first ordering during truncation', async () => {
    const tool = buildTool();
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0, limit: 2 });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.signals.forward_link).toBe(true);
    }
  });

  it('silently skips broken wikilinks without throwing', async () => {
    const tool = buildTool({ body: '# A\n\n[[Nonexistent]] but [[B]] exists\n' });
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
    expect(results.map((r) => r.path)).toContain('Folder/B.md');
    expect(results.map((r) => r.path)).not.toContain('Nonexistent');
  });

  it('respects pathExists filter on linked targets too', async () => {
    const tool = buildTool({
      pathExists: vi.fn(async (p: string) => p !== 'Folder/B.md'),
    });
    const results = await tool.handler({ path: 'Folder/A.md', threshold: 0 });
    expect(results.map((r) => r.path)).not.toContain('Folder/B.md');
    expect(results.map((r) => r.path)).toContain('Folder/C.md');
    expect(results.map((r) => r.path)).toContain('Folder/D.md');
  });
});
