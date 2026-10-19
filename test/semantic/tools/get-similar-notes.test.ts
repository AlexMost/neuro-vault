import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildGetSimilarNotesTool } from '../../../src/modules/semantic/tools/get-similar-notes.js';
import type { ToolRegistration } from '../../../src/lib/tool-registration.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeCorpusIndex,
  makeSyntheticSource,
  readerOf,
  toBackend,
} from './_helpers.js';
import type { SmartSource } from './_helpers.js';
import { legacyFindNeighbors } from '../_legacy-retrieval.js';
import { CorpusNotReadyError } from '../../../src/lib/obsidian/semantic-backend.js';
import { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';

type SimilarResults = Awaited<ReturnType<ReturnType<typeof buildGetSimilarNotesTool>['handler']>>;

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
    const { tempRoot, sources } = await makeVaultFixture([
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
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      const results = await callTool<SimilarResults>(reg, {
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
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    const { vaultRoot, cleanup: cleanupVault } = await makeTempVault({
      'Folder/note-a.md': '# A\n',
      'Folder/note-c.md': '# C\n',
    });

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      // Note: path passed WITHOUT .md — must resolve to Folder/note-a.md and
      // return Folder/note-c.md as the similar candidate.
      const results = await callTool<SimilarResults>(reg, {
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
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: 'Folder/missing.md' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('excludes the source note from similar-note results', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
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
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      const results = await callTool<SimilarResults>(reg, {
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
    const { tempRoot, sources } = await makeVaultFixture([
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
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      const results = await callTool<SimilarResults>(reg, {
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
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: '../Folder/note-a.md' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Windows-style absolute note paths', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const corpusIndex = makeFakeCorpusIndex(sources);
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          backend: toBackend(corpusIndex),
        },
      ]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: 'C:/vault/Folder/note-a.md' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'VAULT_REQUIRED',
      });
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
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_NOT_FOUND',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('SEMANTIC_INDEX_BUILDING while indexing', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpus = makeFakeCorpusIndex(sources);
      const backend = toBackend(corpus, { state: 'indexing', indexed: 3, total: 7 });
      const registry = makeTestRegistry([{ name: 'v', path: tempRoot, backend }]);
      const reg = registerTool(
        buildGetSimilarNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        }),
      );

      await expect(callTool(reg, { path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_BUILDING',
        details: { vault: 'v', indexed: 3, total: 7 },
      });
      // The gate read the status once and never reached the corpus.
      expect(backend.status).toHaveBeenCalledTimes(1);
      expect(corpus.nearest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('a read the corpus refuses as not ready is reported as the readiness gate would', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);

    try {
      // Ready at the gate; the daemon respawned before the read and is indexing again.
      const corpus = makeFakeCorpusIndex(sources);
      corpus.nearest.mockRejectedValue(
        new CorpusNotReadyError({ state: 'indexing', indexed: 0, total: 4 }),
      );
      const registry = makeTestRegistry([
        { name: 'v', path: tempRoot, backend: toBackend(corpus), reader: readerOf(sources) },
      ]);
      const reg = registerTool(
        buildGetSimilarNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        }),
      );

      await expect(callTool(reg, { path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'SEMANTIC_INDEX_BUILDING',
        details: { vault: 'v', indexed: 0, total: 4 },
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('a read that fails inside the corpus is a DEPENDENCY_ERROR', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);

    try {
      const corpus = makeFakeCorpusIndex(sources);
      corpus.nearest.mockRejectedValue(new Error('disk on fire'));
      const registry = makeTestRegistry([
        { name: 'v', path: tempRoot, backend: toBackend(corpus), reader: readerOf(sources) },
      ]);
      const reg = registerTool(
        buildGetSimilarNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        }),
      );

      await expect(callTool(reg, { path: 'Folder/note-a.md' })).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-range threshold and a non-positive or fractional limit', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([{ name: 'v', path: tempRoot }]);
      const reg = registerTool(
        buildGetSimilarNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        }),
      );

      for (const [field, value] of [
        ['threshold', -0.01],
        ['threshold', 1.01],
        ['limit', 0],
        ['limit', 1.5],
      ] as const) {
        await expect(
          callTool(reg, { path: 'Folder/note-a.md', [field]: value }),
        ).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
          details: { issues: [{ path: field }] },
        });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);

    try {
      const registry = makeTestRegistry([{ name: 'v', path: tempRoot }]);
      const tool = buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      await expect(callTool(reg, { path: 'Folder/note-a.md', vault: 'v' })).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
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
    reg: ToolRegistration;
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
    const reader = readerOf(sources);
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: vaultRoot,
        backend: toBackend(corpusIndex),
        reader,
        graph: new WikilinkGraphIndex({ reader }),
      },
    ]);
    const tool = buildGetSimilarNotesTool({
      registry,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: MODEL_KEY,
      similarity: TEST_SIMILARITY,
    });
    return { tool, reg: registerTool(tool), cleanup };
  }

  it('surfaces forward-linked notes even when their semantic similarity is below threshold', async () => {
    const { reg, cleanup } = await buildToolWithVault();
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0.9 });
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

  it('a link to a short note is a forward_link', async () => {
    // S is in the vault's scoped note list but carries no vector (below the embedding size gate).
    const sources = makeSources();
    sources.set('Folder/S.md', makeSyntheticSource('Folder/S.md', []));
    const { reg, cleanup } = await buildToolWithVault({
      sources,
      body: '# A\n\nA short one: [[S]].\n',
    });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0.9 });
      const s = results.find((r) => r.path === 'Folder/S.md');
      expect(s).toBeDefined();
      expect(s!.signals).toEqual({ forward_link: true });
      expect(s!.similarity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('NOT_FOUND when the note has no vector', async () => {
    const sources = makeSources();
    sources.set('Folder/S.md', makeSyntheticSource('Folder/S.md', []));
    const { reg, cleanup } = await buildToolWithVault({ sources });
    try {
      await expect(callTool(reg, { path: 'Folder/S.md', threshold: 0 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'No note found for path: Folder/S.md',
        details: { path: 'Folder/S.md' },
      });
    } finally {
      await cleanup();
    }
  });

  it('keeps the semantic scores the in-memory scan gave', async () => {
    const sources = makeSources();
    const { reg, cleanup } = await buildToolWithVault({
      sources,
      body: '# A\n\nNo links here.\n',
    });
    try {
      const expected = legacyFindNeighbors({
        queryVector: sources.get('Folder/A.md')!.embedding,
        sources: [...sources.values()].filter((s) => s.path !== 'Folder/A.md'),
        threshold: 0,
      });
      const results = await callTool<SimilarResults>(reg, {
        path: 'Folder/A.md',
        threshold: 0,
        limit: 50,
      });
      // Rank differs (the frontmatter link to D puts it first); the scores must not.
      const byPath = (list: { path: string; similarity?: number }[]) =>
        list.map((r) => [r.path, r.similarity] as const).sort(([a], [b]) => a.localeCompare(b));
      expect(byPath(results)).toEqual(byPath(expected));
    } finally {
      await cleanup();
    }
  });

  it('returns semantic-only neighbors with signals.semantic set', async () => {
    const { reg, cleanup } = await buildToolWithVault({ body: '# A\n\nNo links here.\n' });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
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
    const { reg, cleanup } = await buildToolWithVault();
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
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
    const { reg, cleanup } = await buildToolWithVault({ sources });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
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
    const { reg, cleanup } = await buildToolWithVault({
      sources,
      body: '# A\n\n[[B]] [[Templates/X]]\n',
    });
    try {
      const results = await callTool<SimilarResults>(reg, {
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
    const { reg, cleanup } = await buildToolWithVault();
    try {
      const results = await callTool<SimilarResults>(reg, {
        path: 'Folder/A.md',
        threshold: 0,
        limit: 2,
      });
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.signals.forward_link).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('resolves forward links through the vault graph, not a scan per call', async () => {
    const sources = makeSources();
    const { vaultRoot, cleanup } = await makeTempVault({
      'Folder/A.md': '# A\n\n[[B]] and [[C]]\n',
      'Folder/B.md': '# B\n',
      'Folder/C.md': '# C\n',
    });
    const reader = readerOf(sources);
    const scan = vi.spyOn(reader, 'scan');
    const graph = new WikilinkGraphIndex({ reader });
    const resolve = vi.spyOn(graph, 'resolve');
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: vaultRoot,
        backend: toBackend(makeFakeCorpusIndex(sources)),
        reader,
        graph,
      },
    ]);
    const reg = registerTool(
      buildGetSimilarNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      }),
    );
    try {
      for (let call = 0; call < 2; call += 1) {
        const results = await callTool<SimilarResults>(reg, {
          path: 'Folder/A.md',
          threshold: 0.9,
        });
        expect(results.filter((r) => r.signals.forward_link).map((r) => r.path)).toEqual([
          'Folder/B.md',
          'Folder/C.md',
        ]);
      }
      // One scan for the graph's one build; the second call reuses it.
      expect(scan).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('B');
      expect(resolve).toHaveBeenCalledWith('C');
    } finally {
      await cleanup();
    }
  });

  it('silently skips broken wikilinks without throwing', async () => {
    const { reg, cleanup } = await buildToolWithVault({
      body: '# A\n\n[[Nonexistent]] but [[B]] exists\n',
    });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
      expect(results.map((r) => r.path)).toContain('Folder/B.md');
      expect(results.map((r) => r.path)).not.toContain('Nonexistent');
    } finally {
      await cleanup();
    }
  });

  it('drops a candidate that is both excluded and missing, without raising', async () => {
    const { reg, cleanup } = await buildToolWithVault({
      absentPaths: ['Folder/B.md'],
    });
    try {
      const results = await callTool<SimilarResults>(reg, {
        path: 'Folder/A.md',
        threshold: 0,
        exclude_folders: ['Folder/B.md'],
      });
      expect(results.map((r) => r.path)).not.toContain('Folder/B.md');
      expect(results.map((r) => r.path)).toContain('Folder/C.md');
    } finally {
      await cleanup();
    }
  });

  it('respects pathExists filter on linked targets too', async () => {
    // Folder/B.md is absent from disk, so it should be filtered out despite being linked
    const { reg, cleanup } = await buildToolWithVault({
      absentPaths: ['Folder/B.md'],
    });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
      expect(results.map((r) => r.path)).not.toContain('Folder/B.md');
      expect(results.map((r) => r.path)).toContain('Folder/C.md');
      expect(results.map((r) => r.path)).toContain('Folder/D.md');
    } finally {
      await cleanup();
    }
  });

  it('stamps vault name on every result item', async () => {
    const { reg, cleanup } = await buildToolWithVault({ body: '# A\n\nNo links here.\n' });
    try {
      const results = await callTool<SimilarResults>(reg, { path: 'Folder/A.md', threshold: 0 });
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

  // Guards a routing hint that used to live only in the truncated server
  // `instructions` string.
  it('advertises the search_notes to get_similar_notes expansion flow', async () => {
    const { tool, cleanup } = await buildToolWithVault();
    try {
      const description = registerTool(tool).spec.description!;
      expect(description).toMatch(/search_notes/);
      expect(description).toMatch(/expand/i);
    } finally {
      await cleanup();
    }
  });

  it('applies the profile’s similarNotes default when threshold is omitted', async () => {
    const { vaultRoot, cleanup } = await makeTempVault({
      'a.md': '# A\n',
      'near.md': '# N\n',
      'far.md': '# F\n',
    });
    try {
      // Similarity to a.md: near 0.8, far 0.7 — only the former clears the profile's 0.77.
      const sources = new Map<string, SmartSource>([
        ['a.md', makeSyntheticSource('a.md', [1, 0])],
        ['near.md', makeSyntheticSource('near.md', [0.8, 0.6])],
        ['far.md', makeSyntheticSource('far.md', [0.7, Math.sqrt(0.51)])],
      ]);
      const tool = buildGetSimilarNotesTool({
        registry: makeTestRegistry([
          {
            name: 'v',
            path: vaultRoot,
            backend: toBackend(makeFakeCorpusIndex(sources)),
            reader: readerOf(sources),
          },
        ]),
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: { ...TEST_SIMILARITY, similarNotes: 0.77 },
      });
      const results = await callTool<SimilarResults>(registerTool(tool), { path: 'a.md' });
      expect(results.map((r) => r.path)).toEqual(['near.md']);
    } finally {
      await cleanup();
    }
  });
});
