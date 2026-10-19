import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesDeps,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { LexicalSearchError } from '../../../src/lib/obsidian/lexical/reader.js';
import type { IFanOutResult } from '../../../src/lib/fan-out.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool, expectToolError } from '../../_gate.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { FAN_OUT_SUFFIX } from '../../../src/lib/vault-param.js';
import type { SmartSource } from '../../../src/modules/semantic/types.js';
import {
  MODEL_KEY,
  makeVaultFixture,
  makeFakeGraph,
  makeSearchDeps,
  makeTestRegistry,
  makeFakeCorpusIndex,
  makeSyntheticSource,
  toBackend,
  runSearch,
} from './_helpers.js';
import { CorpusNotReadyError } from '../../../src/lib/obsidian/semantic-backend.js';
import { createDaemonAttachment } from '../../../src/modules/semantic/backend/attachment.js';
import { createDaemonSemanticBackend } from '../../../src/modules/semantic/backend/daemon-backend.js';
import {
  DaemonTimeoutError,
  type IDaemonLink,
} from '../../../src/modules/semantic/daemon-connection.js';
import type { ISharedServices } from '../../../src/modules/semantic/shared-services.js';
import { makeLexicalVault, sourcesScoring, sourcesWithEmbeddingFor } from './_hybrid-helpers.js';

// Lightweight helpers for mock-only tests (no real corpus needed)
function makeMockSource(p: string, embedding: number[] = [1, 0]): SmartSource {
  return {
    path: p,
    embedding: Float32Array.from(embedding),
    blocks: [],
  };
}

function makeMockSources(paths: string[]): Map<string, SmartSource> {
  return new Map(paths.map((p) => [p, makeMockSource(p)]));
}

/** The 2-D unit vector `degrees` counter-clockwise from the query vector `[1, 0]`. */
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}
const cosDeg = (degrees: number): number => Math.cos((degrees * Math.PI) / 180);

describe('searchNotes', () => {
  it('filters out search results whose paths no longer exist on disk', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      // note-b is absent from disk
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: 'bge-micro-v2',
        absentPaths: new Set(['Folder/note-b.md']),
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);

      try {
        const result = await callTool<SearchNotesOutput>(reg, {
          query: 'semantic query',
          threshold: 0,
        });
        expect(result.matches.map((r) => r.path)).toEqual(['Folder/note-a.md', 'Folder/note-c.md']);
        // blocks now live under each match; assert none belong to the absent path
        for (const r of result.matches) {
          expect(r.path).not.toBe('Folder/note-b.md');
          for (const block of r.blocks ?? []) {
            expect(block).not.toHaveProperty('path');
          }
        }
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns ranked search results for a query', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);

      try {
        const result = await callTool<SearchNotesOutput>(reg, {
          query: '  semantic query  ',
          threshold: 0,
        });

        expect(embed).toHaveBeenCalledTimes(1);
        expect(embed).toHaveBeenCalledWith('semantic query');
        expect(result.matches.map((r) => r.path)).toEqual([
          'Folder/note-a.md',
          'Folder/note-b.md',
          'Folder/note-c.md',
        ]);
        expect(result.matches[0].similarity).toBeGreaterThan(result.matches[1].similarity!);
        expect(result.matches[1].similarity).toBeGreaterThan(result.matches[2].similarity!);
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty query before embedding', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const embed = vi.fn();
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);

      try {
        await expect(callTool(reg, { query: '   ' })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
        expect(embed).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  // "Semantic-leg failure or emptiness SHALL NOT fail the lexical leg", and
  // the lexical leg has already produced its matches by the time the semantic
  // leg runs — failing the whole call would throw them away. The vault below
  // carries a real body under a real reader, so the surviving matches are
  // load-bearing rather than a vacuous `every()` over an empty list.
  it('degrades to the lexical leg when the query embedding fails', async () => {
    const notePath = 'Notes/a.md';
    const warn = vi.fn();
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'нотатка про пошук' },
      { sources: sourcesWithEmbeddingFor(notePath, [1, 0]) },
    );
    try {
      const embed = vi.fn().mockRejectedValue(new Error('model unavailable'));
      const tool = buildSearchNotesTool({
        ...deps,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        warn,
      });
      const reg = registerTool(tool);

      const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });

      expect(embed).toHaveBeenCalled();
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
        true,
      );
      // The field must describe the response the client is holding: a
      // lexical-only payload labelled `ready` would be a lie of the same
      // class the pinning above exists to prevent.
      expect(result.semantic_status).toEqual({
        state: 'unavailable',
        note: expect.stringContaining('lexical-only'),
      });
      // Degrading is not swallowing — the cause goes to stderr.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('model unavailable'));
    } finally {
      await cleanup();
    }
  });

  it('degrades to the lexical leg when the corpus read fails', async () => {
    const notePath = 'Notes/a.md';
    const warn = vi.fn();
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'нотатка про пошук' },
      { sources: sourcesWithEmbeddingFor(notePath, [1, 0]) },
    );
    try {
      const entry = deps.registry.list()[0];
      entry.backend = {
        ...entry.backend!,
        nearest: vi.fn().mockRejectedValue(new Error('corpus shard a.json is not valid JSON')),
      };
      const tool = buildSearchNotesTool({ ...deps, warn });
      const reg = registerTool(tool);

      const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
        true,
      );
      expect(result.semantic_status).toEqual({
        state: 'unavailable',
        note: expect.stringContaining('lexical-only'),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    } finally {
      await cleanup();
    }
  });

  it('a status timeout degrades to lexical with unavailable', async () => {
    // The real daemon backend over a connection whose `vault.status` never
    // answers in time: one search degrades, and the next one asks again.
    const notePath = 'Notes/a.md';
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: 'нотатка про пошук' });
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'vault.attach') {
        return { vault: params.vault, profiles: { [MODEL_KEY]: { state: 'ready' } } };
      }
      if (method === 'vault.status') {
        throw new DaemonTimeoutError('daemon request vault.status timed out after 10000 ms');
      }
      throw new Error(`the corpus must not be read: ${method}`);
    });
    const services: ISharedServices = {
      mode: 'daemon',
      connection: { epoch: 1, ensure: async () => {}, close: () => {}, request } as IDaemonLink,
      ensure: async () => 'daemon',
      close: () => {},
    };
    try {
      const entry = deps.registry.list()[0];
      entry.backend = createDaemonSemanticBackend({
        services,
        attachment: createDaemonAttachment({
          services,
          vaultRoot: entry.path,
          profiles: [MODEL_KEY],
        }),
        profile: MODEL_KEY,
        local: () => {
          throw new Error('never local');
        },
      });
      // The startup attach has answered.
      expect(await entry.backend.status()).toEqual({ state: 'ready' });
      const reg = registerTool(buildSearchNotesTool(deps));

      for (let call = 0; call < 2; call += 1) {
        const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });
        expect(result.semantic_status).toEqual({
          state: 'unavailable',
          note: expect.stringContaining('lexical-only'),
        });
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
          true,
        );
      }
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        'vault.attach',
        'vault.status',
        'vault.status',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('a read refused as not ready degrades to lexical, reporting the status it carries', async () => {
    const notePath = 'Notes/a.md';
    const warn = vi.fn();
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'нотатка про пошук' },
      { sources: sourcesWithEmbeddingFor(notePath, [1, 0]) },
    );
    try {
      const entry = deps.registry.list()[0];
      entry.backend = {
        ...entry.backend!,
        nearest: vi
          .fn()
          .mockRejectedValue(new CorpusNotReadyError({ state: 'indexing', indexed: 1, total: 6 })),
      };
      const reg = registerTool(buildSearchNotesTool({ ...deps, warn }));

      const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });

      expect(result.semantic_status).toEqual({
        state: 'indexing',
        indexed: 1,
        total: 6,
        note: expect.stringContaining('lexical-only'),
      });
      expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it('writes the degradation warning to stderr by default', async () => {
    const notePath = 'Notes/a.md';
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'нотатка про пошук' },
      { sources: sourcesWithEmbeddingFor(notePath, [1, 0]) },
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const tool = buildSearchNotesTool({
        ...deps,
        embeddingProvider: {
          initialize: vi.fn(),
          embedQuery: vi.fn().mockRejectedValue(new Error('model unavailable')),
        },
      });
      const reg = registerTool(tool);
      await callTool(reg, { query: 'пошук' });
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('model unavailable'));
    } finally {
      stderr.mockRestore();
      await cleanup();
    }
  });

  it('rejects thresholds below 0 and above 1', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: 'bge-micro-v2',
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);

      try {
        await expect(
          callTool(reg, { query: 'semantic query', threshold: -0.01 }),
        ).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
          details: { issues: [{ path: 'threshold' }] },
        });
        await expect(
          callTool(reg, { query: 'semantic query', threshold: 1.01 }),
        ).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
          details: { issues: [{ path: 'threshold' }] },
        });
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts a query array and returns matched_queries on each result', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);

    try {
      const embed = vi
        .fn()
        .mockResolvedValueOnce([0.7, 0.2, 0.1])
        .mockResolvedValueOnce([0.1, 0.2, 0.7]);
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);

      try {
        const output = await callTool<SearchNotesOutput>(reg, {
          query: ['alpha', 'beta'],
          threshold: 0,
        });

        expect(embed).toHaveBeenCalledTimes(2);
        expect(embed).toHaveBeenNthCalledWith(1, 'alpha');
        expect(embed).toHaveBeenNthCalledWith(2, 'beta');
        expect(output.truncated).toBe(false);
        for (const result of output.matches) {
          expect(Array.isArray(result.matched_queries)).toBe(true);
          expect(result.matched_queries!.length).toBeGreaterThan(0);
        }
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-range expansion_floor and a non-positive or fractional limit', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);
    try {
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
      });
      const reg = registerTool(buildSearchNotesTool(deps));
      try {
        for (const [field, value] of [
          ['expansion_floor', -0.01],
          ['expansion_floor', 1.01],
          ['limit', 0],
          ['limit', 1.5],
        ] as const) {
          await expect(callTool(reg, { query: 'alpha', [field]: value })).rejects.toMatchObject({
            code: 'INVALID_PARAMS',
            details: { issues: [{ path: field }] },
          });
        }
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty query array', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);
    try {
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      try {
        await expect(callTool(reg, { query: [] })).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
          details: { issues: [{ path: 'query' }] },
        });
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a query array longer than 8', async () => {
    const { tempRoot, sources } = await makeVaultFixture(['note-a.ajson']);
    try {
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      try {
        await expect(
          callTool(reg, { query: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
        ).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
          details: { issues: [{ path: 'query' }] },
        });
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('dedupes duplicate queries before embedding', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    try {
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      try {
        await callTool(reg, { query: ['  alpha  ', 'alpha', 'beta'], threshold: 0 });
        expect(embed).toHaveBeenCalledTimes(2);
        expect(embed).toHaveBeenNthCalledWith(1, 'alpha');
        expect(embed).toHaveBeenNthCalledWith(2, 'beta');
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps single-string output shape unchanged (no matched_queries, blocks omitted when the note has no block embeddings)', async () => {
    const { tempRoot, sources } = await makeVaultFixture([
      'note-a.ajson',
      'note-b.ajson',
      'note-c.ajson',
    ]);
    try {
      const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
      const { deps, cleanup } = await makeSearchDeps({
        sources,
        embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
        modelKey: MODEL_KEY,
      });
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      try {
        const output = await callTool<SearchNotesOutput>(reg, {
          query: 'semantic query',
          threshold: 0,
        });

        // The fixture notes' blocks carry no embeddings, so the real
        // `findBlockNeighbors` never surfaces a hit and backfill can't
        // manufacture one — `blocks` is omitted, not `[]`.
        for (const result of output.matches) {
          expect(result).not.toHaveProperty('matched_queries');
          expect(result).not.toHaveProperty('blocks');
          expect(result).not.toHaveProperty('related');
        }
      } finally {
        await cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a query array with an empty string element', async () => {
    const sources = makeMockSources(['note-a.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      await expect(callTool(reg, { query: [''] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects a query array with a whitespace-only string element', async () => {
    const sources = makeMockSources(['note-a.md']);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      await expect(callTool(reg, { query: ['  '] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await cleanup();
    }
  });

  it('query: array length 1 still carries matched_queries on results', async () => {
    const sources = makeMockSources(['note-a.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, { query: ['single'], threshold: 0 });

      expect(output.matches).toHaveLength(1);
      expect(output.matches[0].matched_queries).toEqual(['single']);
      expect(output.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('multi-query: matched_queries lists only queries that returned the path (above-threshold)', async () => {
    // Q1 reaches only note-a.md, Q2 only note-b.md (each orthogonal to the
    // other note, under the threshold). note-a.md should have
    // matched_queries = ['q1'] only.
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    sources.get('note-b.md')!.embedding = new Float32Array([0, 1]);
    const embed = vi
      .fn()
      .mockResolvedValueOnce([1, 0]) // q1
      .mockResolvedValueOnce([0, 1]); // q2
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        threshold: 0.5,
      });

      const byPath = new Map(output.matches.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.matched_queries).toEqual(['q1']);
      expect(byPath.get('note-b.md')!.matched_queries).toEqual(['q2']);
    } finally {
      await cleanup();
    }
  });

  it('multi-query expansion (deep): an expansion-only neighbour surfaces with expansion_similarity, not similarity', async () => {
    // The seed sits 40° off the query (0.77); exp.md 45° further on is out
    // of the query's reach (0.09) but 0.71 from the seed.
    const sources = makeMockSources(['note-a.md', 'exp.md']);
    sources.get('note-a.md')!.embedding = Float32Array.from(at(40));
    sources.get('exp.md')!.embedding = Float32Array.from(at(85));

    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1'],
        effort: 'deep',
        threshold: 0.5,
      });

      const noteA = output.matches.find((r) => r.path === 'note-a.md')!;
      expect(noteA.matched_queries).toEqual(['q1']);
      expect(noteA.found_in).toEqual(['semantic']);

      const exp = output.matches.find((r) => r.path === 'exp.md')!;
      expect(exp).toBeDefined();
      expect(exp.found_in).toEqual(['expansion']);
      expect(exp.expansion_similarity).toBeCloseTo(cosDeg(45), 6);
      expect(exp.similarity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('quick mode multi-query never surfaces expansion-only entries', async () => {
    // Same geometry as the deep case above: exp.md is reachable only by
    // expanding from note-a.md, which quick effort never does.
    const sources = makeMockSources(['note-a.md', 'exp.md']);
    sources.get('note-a.md')!.embedding = Float32Array.from(at(40));
    sources.get('exp.md')!.embedding = Float32Array.from(at(85));
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        effort: 'quick',
        threshold: 0.5,
      });

      expect(output.matches.every((r) => !r.found_in.includes('expansion'))).toBe(true);
      expect(output.matches.every((r) => r.expansion_similarity === undefined)).toBe(true);
      expect(output.matches.map((r) => r.path)).toEqual(['note-a.md']);
    } finally {
      await cleanup();
    }
  });

  it('single-query deep mode surfaces the expansion neighbour of the seed', async () => {
    const sources = makeMockSources(['note-a.md', 'exp.md']);
    sources.get('note-a.md')!.embedding = Float32Array.from(at(40));
    sources.get('exp.md')!.embedding = Float32Array.from(at(85));

    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: 'test query',
        effort: 'deep',
        threshold: 0.5,
      });

      const exp = output.matches.find((r) => r.path === 'exp.md')!;
      expect(exp.found_in).toEqual(['expansion']);
      expect(exp.expansion_similarity).toBeCloseTo(cosDeg(45), 6);
    } finally {
      await cleanup();
    }
  });

  it("multi-query deep: the same expansion neighbour fuses once at its best seed's expansion_similarity", async () => {
    // q1 sits on seed-a (0°), q2 on seed-b (20°); under the 0.95 threshold
    // each reaches only its own seed. shared.md at 50° is out of both
    // queries' reach but a neighbour of both seeds: cos 50° via seed-a, cos
    // 30° via seed-b.
    const sources = makeMockSources(['seed-a.md', 'seed-b.md', 'shared.md']);
    sources.get('seed-a.md')!.embedding = Float32Array.from(at(0));
    sources.get('seed-b.md')!.embedding = Float32Array.from(at(20));
    sources.get('shared.md')!.embedding = Float32Array.from(at(50));

    const embed = vi.fn().mockResolvedValueOnce(at(0)).mockResolvedValueOnce(at(20));
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        effort: 'deep',
        threshold: 0.95,
      });

      // "shared.md" is a neighbour of both seeds; flattened expansion dedups
      // to a single entry at the best (max) similarity — seed-b's.
      const shared = output.matches.filter((r) => r.path === 'shared.md');
      expect(shared).toHaveLength(1);
      expect(shared[0].expansion_similarity).toBeCloseTo(cosDeg(30), 6);
      expect(shared[0].similarity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('enriches single-query results with backlink_count from the graph', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const graph = makeFakeGraph({ 'note-a.md': 3, 'note-b.md': 0 });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
      graph,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, { query: 'topic', threshold: 0 });

      expect(graph.ensureFresh).toHaveBeenCalled();
      const byPath = new Map(output.matches.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.backlink_count).toBe(3);
      expect(byPath.get('note-b.md')!.backlink_count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('enriches multi-query results with backlink_count from the graph', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]);
    const graph = makeFakeGraph({ 'note-a.md': 5, 'note-b.md': 1 });
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
      graph,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2'],
        threshold: 0,
      });

      expect(graph.ensureFresh).toHaveBeenCalled();
      const byPath = new Map(output.matches.map((r) => [r.path, r]));
      expect(byPath.get('note-a.md')!.backlink_count).toBe(5);
      expect(byPath.get('note-b.md')!.backlink_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('multi-query final cap: limit=2 with 3 queries each returning 2 unique results → length ≤ 2', async () => {
    const sources = sourcesScoring([
      { path: 'a-0.md', similarity: 0.9 },
      { path: 'a-1.md', similarity: 0.8 },
      { path: 'b-0.md', similarity: 0.7 },
      { path: 'b-1.md', similarity: 0.6 },
      { path: 'c-0.md', similarity: 0.5 },
      { path: 'c-1.md', similarity: 0.4 },
    ]);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, {
        query: ['q1', 'q2', 'q3'],
        effort: 'quick',
        limit: 2,
        threshold: 0,
      });

      expect(output.matches.length).toBeLessThanOrEqual(2);
      expect(output.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('stamps vault name on every result item (single query)', async () => {
    const sources = makeMockSources(['note-a.md', 'note-b.md']);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const { deps, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: embed },
      modelKey: MODEL_KEY,
    });
    const tool = buildSearchNotesTool(deps);
    const reg = registerTool(tool);
    try {
      const output = await callTool<SearchNotesOutput>(reg, { query: 'topic', threshold: 0 });
      expect(output.matches.every((r) => r.vault === 'v')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('fans out across two semantically-available vaults when vault: is omitted in multi-vault mode', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);
    try {
      const sources1 = new Map([
        ['note-a.md', { path: 'note-a.md', embedding: new Float32Array([1, 0]), blocks: [] }],
      ]);
      const sources2 = new Map([
        ['note-b.md', { path: 'note-b.md', embedding: new Float32Array([0, 1]), blocks: [] }],
      ]);
      const corpusIndex1 = makeFakeCorpusIndex(sources1);
      const corpusIndex2 = makeFakeCorpusIndex(sources2);

      // Create temp vault roots so entry.filterExisting works
      const fs2 = await import('node:fs/promises');
      const os2 = await import('node:os');
      const path2 = await import('node:path');
      const vaultRoot1 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'fanout-v1-'));
      const vaultRoot2 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'fanout-v2-'));
      await fs2.mkdir(path2.join(vaultRoot1), { recursive: true });
      await fs2.mkdir(path2.join(vaultRoot2), { recursive: true });
      // Write the note files so entry.filterExisting keeps them
      await fs2.writeFile(path2.join(vaultRoot1, 'note-a.md'), '', 'utf8');
      await fs2.writeFile(path2.join(vaultRoot2, 'note-b.md'), '', 'utf8');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v1',
            path: vaultRoot1,
            backend: toBackend(corpusIndex1),
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
          {
            name: 'v2',
            path: vaultRoot2,
            backend: toBackend(corpusIndex2),
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
        ]);
        const tool = buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        });
        const reg = registerTool(tool);

        const result = await callTool<{
          results_by_vault: Array<{ vault: string; matches: Array<{ path: string }> }>;
          skipped_vaults: Array<{ vault: string; reason: string }>;
        }>(reg, { query: 'q', threshold: 0 });

        expect(result.results_by_vault).toHaveLength(2);
        expect(result.skipped_vaults).toEqual([]);
        const byVault = new Map(result.results_by_vault.map((g) => [g.vault, g]));
        expect(byVault.has('v1')).toBe(true);
        expect(byVault.has('v2')).toBe(true);
        expect(byVault.get('v1')!.matches[0].path).toBe('note-a.md');
        expect(byVault.get('v2')!.matches[0].path).toBe('note-b.md');
      } finally {
        await fs2.rm(vaultRoot1, { recursive: true, force: true });
        await fs2.rm(vaultRoot2, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns failed_vaults when one vault rejects outside its semantic leg', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);
    try {
      const sources1 = new Map([
        ['note-a.md', { path: 'note-a.md', embedding: new Float32Array([1, 0]), blocks: [] }],
      ]);
      const corpusIndex1 = makeFakeCorpusIndex(sources1);
      const corpusIndex2 = makeFakeCorpusIndex(new Map());
      // Vault b fails before either leg runs — its wikilink graph cannot be
      // refreshed. A *semantic-leg* failure would no longer land here: that
      // degrades to the lexical leg per vault (see the degradation tests
      // above), which is what keeps one vault's broken corpus from costing
      // the envelope its lexical answers. This vault's failure is outside
      // that boundary, so it still lands in `failed_vaults`.
      const brokenGraph = {
        ...makeFakeGraph(),
        ensureFresh: vi
          .fn()
          .mockRejectedValue(new ToolHandlerError('DEPENDENCY_ERROR', 'embedding lookup failed')),
      } as unknown as ReturnType<typeof makeFakeGraph>;

      const fs2 = await import('node:fs/promises');
      const os2 = await import('node:os');
      const path2 = await import('node:path');
      const vaultRoot1 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'partial-v1-'));
      const vaultRoot2 = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'partial-v2-'));
      await fs2.writeFile(path2.join(vaultRoot1, 'note-a.md'), '', 'utf8');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v1',
            path: vaultRoot1,
            backend: toBackend(corpusIndex1),
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
          {
            name: 'v2',
            path: vaultRoot2,
            backend: toBackend(corpusIndex2),
            graph: brokenGraph,
            listMatchingPaths: async () => new Set(),
          },
        ]);
        const tool = buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        });
        const reg = registerTool(tool);

        const result = await callTool<{
          results_by_vault: Array<{ vault: string; matches: Array<{ path: string }> }>;
          skipped_vaults: Array<{ vault: string; reason: string }>;
          failed_vaults: Array<{ vault: string; error: { code: string; message: string } }>;
        }>(reg, { query: 'q', threshold: 0 });

        expect(result.skipped_vaults).toEqual([]);
        expect(result.failed_vaults).toEqual([
          {
            vault: 'v2',
            error: { code: 'DEPENDENCY_ERROR', message: 'embedding lookup failed' },
          },
        ]);
        expect(result.results_by_vault).toHaveLength(1);
        const v1Entry = result.results_by_vault[0];
        expect(v1Entry.vault).toBe('v1');
        expect(v1Entry.matches[0].path).toBe('note-a.md');
      } finally {
        await fs2.rm(vaultRoot1, { recursive: true, force: true });
        await fs2.rm(vaultRoot2, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fan-out includes a vault without a semantic index, contributing lexically-sourced matches only', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);
    try {
      const sources1 = new Map([
        ['note-a.md', { path: 'note-a.md', embedding: new Float32Array([1, 0]), blocks: [] }],
      ]);
      const corpusIndex1 = makeFakeCorpusIndex(sources1);

      const vaultRoot1 = await (
        await import('node:fs/promises')
      ).mkdtemp(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'fanout-skip-v1-'),
      );
      await (
        await import('node:fs/promises')
      ).writeFile((await import('node:path')).join(vaultRoot1, 'note-a.md'), '', 'utf8');

      try {
        const registry = makeTestRegistry([
          {
            name: 'v1',
            path: vaultRoot1,
            backend: toBackend(corpusIndex1),
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
          {
            name: 'v2',
            path: tempRoot,
            graph: makeFakeGraph(),
            listMatchingPaths: async () => new Set(),
          },
        ]);
        const tool = buildSearchNotesTool({
          registry,
          embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
          modelKey: MODEL_KEY,
          similarity: TEST_SIMILARITY,
        });
        const reg = registerTool(tool);

        const result = await callTool<{
          results_by_vault: Array<{
            vault: string;
            matches: Array<{ path: string; found_in: string[] }>;
          }>;
          skipped_vaults: Array<{ vault: string; reason: string }>;
        }>(reg, { query: 'q', threshold: 0 });

        expect(result.results_by_vault).toHaveLength(2);
        expect(result.skipped_vaults).toEqual([]);
        const byVault = new Map(result.results_by_vault.map((g) => [g.vault, g]));
        expect(byVault.get('v1')!.matches[0].path).toBe('note-a.md');
        expect(byVault.get('v1')!.matches[0].found_in).toEqual(['semantic']);
        // v2 has no semantic corpus — hybrid falls back to lexical-only rather
        // than skipping the vault entirely. No matching notes here, so empty.
        expect(byVault.get('v2')!.matches).toEqual([]);
      } finally {
        await (await import('node:fs/promises')).rm(vaultRoot1, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns lexical-only matches (no throw) when vault has no semantic backend', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);
    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          graph: makeFakeGraph(),
          listMatchingPaths: async () => new Set(),
        },
      ]);
      const tool = buildSearchNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);

      const result = await callTool<SearchNotesOutput>(reg, { query: 'q' });
      expect(result.matches).toEqual([]);
      expect(result.truncated).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('semantic_status', () => {
  it('reports a ready backend with no counters', async () => {
    const result = await runSearch({ backendStatus: { state: 'ready' }, input: { query: 'x' } });
    expect(result.semantic_status).toEqual({ state: 'ready' });
  });

  it('carries no note when the backend is ready', async () => {
    const result = await runSearch({ backendStatus: { state: 'ready' }, input: { query: 'x' } });
    expect(result.semantic_status).not.toHaveProperty('note');
  });

  it.each(['disabled', 'unavailable'] as const)(
    'explains a %s state on the response itself',
    async (state) => {
      const result = await runSearch({ backendStatus: { state }, input: { query: 'x' } });
      expect(result.semantic_status.note).toMatch(/semantic leg did not run/i);
      expect(result.semantic_status.note).toMatch(/lexical-only/i);
    },
  );

  it('reports progress while indexing and still returns lexical matches', async () => {
    // `makeLexicalVault` writes a real on-disk body and wires a real
    // `FsVaultReader` (unlike `runSearch`'s fixture, which always writes an
    // empty body under the registry's default no-op reader) — the body
    // actually contains the query term, so the "still returns lexical
    // matches" claim in the test name is load-bearing, not a vacuous
    // `every()` over an empty `matches[]`.
    const { deps, cleanup } = await makeLexicalVault(
      { 'Notes/a.md': 'нотатка про пошук' },
      { backendStatus: { state: 'indexing', indexed: 3, total: 9 } },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });
      expect(result.semantic_status).toEqual({
        state: 'indexing',
        indexed: 3,
        total: 9,
        note: expect.stringContaining('lexical-only'),
      });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it('reports the state in lexical mode without reading the corpus', async () => {
    const corpus = makeFakeCorpusIndex(
      new Map([['Notes/a.md', makeSyntheticSource('Notes/a.md')]]),
    );
    const result = await runSearch({
      backendStatus: { state: 'ready' },
      corpus,
      input: { query: 'x', mode: 'lexical' },
    });
    expect(result.semantic_status).toEqual({ state: 'ready' });
    expect(corpus.nearest).not.toHaveBeenCalled();
    expect(corpus.nearestBlocks).not.toHaveBeenCalled();
  });

  it('reads the status once for a search whose semantic leg makes several corpus reads', async () => {
    // Deep effort over two queries: seeds, blocks and expansion are separate
    // corpus reads; the vault's status is read once for the whole call.
    const sources = new Map(
      ['Notes/a.md', 'Notes/b.md'].map((p) => [p, makeSyntheticSource(p)] as const),
    );
    const { deps, backend, cleanup } = await makeSearchDeps({
      sources,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0, 0]) },
      modelKey: MODEL_KEY,
    });
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const result = await callTool<SearchNotesOutput>(reg, {
        query: ['x', 'y'],
        effort: 'deep',
      });
      expect(result.matches.some((m) => m.found_in.includes('semantic'))).toBe(true);
      expect(backend.status).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it('reports the state on the empty-filter early return', async () => {
    const result = await runSearch({
      backendStatus: { state: 'disabled' },
      allowed: new Set<string>(),
      input: { query: 'x', filter: { path_prefix: 'Nope/' } },
    });
    expect(result.matches).toEqual([]);
    expect(result.semantic_status).toEqual({
      state: 'disabled',
      note: expect.stringContaining('lexical-only'),
    });
  });

  it('reports disabled when the semantic module is globally off (no backend)', async () => {
    const { tempRoot } = await makeVaultFixture(['note-a.ajson']);
    try {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: tempRoot,
          graph: makeFakeGraph(),
          listMatchingPaths: async () => new Set(),
        },
      ]);
      const tool = buildSearchNotesTool({
        registry,
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        modelKey: MODEL_KEY,
        similarity: TEST_SIMILARITY,
      });
      const reg = registerTool(tool);
      const result = await callTool<SearchNotesOutput>(reg, { query: 'x' });
      expect(result.semantic_status).toEqual({
        state: 'disabled',
        note: expect.stringContaining('lexical-only'),
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('drops a corpus path whose note is gone before the next reconcile', async () => {
    const result = await runSearch({
      backendStatus: { state: 'ready' },
      corpusPaths: ['Notes/gone.md', 'Notes/here.md'],
      existingPaths: ['Notes/here.md'],
      input: { query: 'x' },
    });
    expect(result.matches.map((m) => m.path)).not.toContain('Notes/gone.md');
  });

  it('pins semantic_status to the value captured up front, even if status() flips indexing -> ready mid-request', async () => {
    // The corpus holds a semantic hit for the query. If the leg
    // decision below re-read `status()` after a mid-request indexing ->
    // ready flip (the transition a warming vault makes), the semantic leg
    // would run and this hit would surface (found_in: ["semantic"]) even
    // though `semantic_status` still (correctly) reports "indexing" — a
    // direct contradiction the fix must prevent. Asserting `status` was
    // called exactly once pins that only the up-front capture is read.
    const notePath = 'Notes/a.md';
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'нотатка про пошук' },
      {
        backendStatus: { state: 'indexing', indexed: 3, total: 9 },
        sources: sourcesWithEmbeddingFor(notePath, [1, 0]),
      },
    );
    try {
      const entry = deps.registry.list()[0];
      const status = vi
        .fn()
        .mockResolvedValueOnce({ state: 'indexing', indexed: 3, total: 9 })
        .mockResolvedValue({ state: 'ready' });
      entry.backend = { ...entry.backend!, status };

      const tool = buildSearchNotesTool(deps);
      const reg = registerTool(tool);
      const result = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });

      expect(status).toHaveBeenCalledTimes(1);
      expect(result.semantic_status).toEqual({
        state: 'indexing',
        indexed: 3,
        total: 9,
        note: expect.stringContaining('lexical-only'),
      });
      expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });
});

// The advertised `description` is the only channel every client (sub-agents
// included) receives in full — the server `instructions` string is truncated.
// These guard the query-writing recipe and the multi-vault contract that used
// to live only in `instructions`.
describe('search_notes advertised description', () => {
  function depsFor(...names: string[]): SearchNotesDeps {
    const registry = makeTestRegistry(
      names.map((name) => ({
        name,
        path: `/vaults/${name}`,
        graph: makeFakeGraph(),
        listMatchingPaths: async () => new Set<string>(),
      })),
    );
    return {
      registry,
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
      modelKey: MODEL_KEY,
      similarity: TEST_SIMILARITY,
    };
  }

  it('names the registered vaults exactly once', () => {
    const tool = buildSearchNotesTool(depsFor('alpha', 'beta'));
    const occurrences = tool.description.split('Registered vaults:').length - 1;
    expect(occurrences).toBe(1);
  });

  it('carries the shared fan-out prose followed by its semantic-index note', () => {
    const tool = buildSearchNotesTool(depsFor('alpha', 'beta'));
    expect(tool.description).toContain(FAN_OUT_SUFFIX);
    expect(tool.description.indexOf(FAN_OUT_SUFFIX)).toBeLessThan(
      tool.description.indexOf('still contributes lexically-sourced matches'),
    );
  });

  it('keeps the vault parameter line in the PARAMETERS block, gated on multi-vault mode', () => {
    const multi = buildSearchNotesTool(depsFor('alpha', 'beta'));
    const single = buildSearchNotesTool(depsFor('only'));
    expect(multi.description).toContain(
      '- vault: target a specific vault by name when multiple are registered.',
    );
    expect(single.description).not.toContain('- vault:');
    expect(single.description).not.toContain('Registered vaults:');
  });

  const PRE_FILTER_FRONTMATTER_LINE =
    'PRE-FILTER (`filter`) — applies to every leg identically; at least one field required. ' +
    '`path_prefix`/`exclude_path_prefix` scope to / drop folder subtrees (string or array); ' +
    '`tags` matches ANY listed tag (no leading "#"); `frontmatter` is a sift filter, same ' +
    'operator allow-list as query_notes.';

  it('ends the single-vault description exactly at the PRE-FILTER block, no trailing newline or multi-vault text', () => {
    const tool = buildSearchNotesTool(depsFor('only'));
    expect(tool.description.endsWith(PRE_FILTER_FRONTMATTER_LINE)).toBe(true);
    expect(tool.description.endsWith('\n')).toBe(false);
    expect(tool.description).not.toContain('Registered vaults:');
  });

  it('separates the multi-vault block from the PRE-FILTER block with a blank line at column 0', () => {
    const tool = buildSearchNotesTool(depsFor('alpha', 'beta'));
    const boundary =
      PRE_FILTER_FRONTMATTER_LINE +
      '\n\n' +
      'Registered vaults: "alpha", "beta". ' +
      FAN_OUT_SUFFIX +
      ' A vault without a semantic index still contributes lexically-sourced matches; none are skipped.';
    expect(tool.description.endsWith(boundary)).toBe(true);
  });

  // Reuses `depsFor` above — same registry/deps construction, just wrapped
  // through `registerTool` for callers that want the server-advertised
  // `spec.description` rather than the tool's own `.description`.
  function describeWith(vaultNames: string[]): string {
    const tool = buildSearchNotesTool(depsFor(...vaultNames));
    return registerTool(tool).spec.description!;
  }

  it('carries the query-writing recipe: concept extraction and multilingual arrays', () => {
    const description = describeWith(['v']);
    expect(description).toMatch(/core nouns/i);
    expect(description).toMatch(/filler/i);
    expect(description).toMatch(/1-8 strings/);
    expect(description).toMatch(/translat/i);
    expect(description).toMatch(/more than one language/i);
  });

  it('names failed_vaults in the multi-vault fan-out contract', () => {
    expect(describeWith(['a', 'b'])).toMatch(/failed_vaults/);
    expect(describeWith(['v'])).not.toMatch(/failed_vaults/);
  });

  /**
   * The description ships on every `tools/list`, in every session, to every
   * sub-agent — the always-paid channel ADR-0010 chose precisely because it
   * always arrives. The budget is what keeps it spent on guidance a caller
   * needs *before* a call; anything only useful for reading a response
   * already in hand belongs on that response instead.
   *
   * 3,800 is the floor this string can reach while `truncated` still
   * explains its two recovery paths here. That prose is the same kind of
   * post-hoc reading aid `semantic_status` and `query_stats` shed onto their
   * own payloads; `truncated` keeps it only because turning the boolean into
   * `{ by, fix }` would break a field released in 15.5.0. Doing that is the
   * next cut — do NOT lower this number by compressing `QUERY WRITING` or
   * `EXAMPLES` instead, which are the only sections that change how a model
   * writes a query, and the only ones no harness here can regression-test.
   */
  const DESCRIPTION_BUDGET = 3800;

  it('stays inside its always-paid budget', () => {
    // The multi-vault variant is the longer of the two.
    expect(describeWith(['alpha', 'beta']).length).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
  });

  it('does not spend the budget listing which fields are absent', () => {
    const description = describeWith(['v']);
    expect(description).not.toMatch(/INVARIANTS/);
    expect(description).not.toMatch(/appears ONLY when/i);
  });

  it('names semantic_status without explaining what each state does to a response', () => {
    const description = describeWith(['v']);
    expect(description).toMatch(/`semantic_status`/);
    // Per-state meaning rides on the response's own `note`, so it is paid for
    // only on the responses it applies to.
    expect(description).not.toMatch(/still building/i);
    expect(description).not.toMatch(/semantics turned off/i);
  });

  it('keeps the one semantic_status caveat a ready response cannot carry itself', () => {
    // `note` is absent when the state is `ready`, so "ready describes the
    // index, not this call" has nowhere else to live.
    expect(describeWith(['v'])).toMatch(/mode: "lexical"/);
  });

  it('leaves per-field diagnostics to the fields themselves', () => {
    const description = describeWith(['v']);
    // `semantic_fallback` and the AND-killed-token diagnosis are read only
    // when they happen, so they live on `query_stats` entries and in the
    // input schema — not in prose every session pays for.
    expect(description).not.toMatch(/semantic_fallback/);
    expect(description).not.toMatch(/lexical_tokens/);
  });

  it('leaves the expert similarity knobs to the input schema', () => {
    const description = describeWith(['v']);
    // Still callable and still validated — just not documented in the
    // always-paid channel, where their prose was mostly a warning against
    // using them.
    expect(description).not.toMatch(/expansion_floor/);
    expect(description).not.toMatch(/- threshold:/);
  });

  it('still advertises the expert knobs on the input schema', () => {
    const spec = registerTool(buildSearchNotesTool(depsFor('v'))).spec;
    const shape = JSON.stringify(spec.inputSchema);
    expect(shape).toMatch(/threshold/);
    expect(shape).toMatch(/expansion_floor/);
  });
});

describe('query_stats fallback note', () => {
  it('names the active profile’s fallback threshold', async () => {
    // Hits at 0.45: below the quick default (0.5), above this profile's 0.42
    // fallback, so the leg's hits exist only because the retry ran.
    const { deps, cleanup } = await makeLexicalVault(
      { 'note.md': 'зміст' },
      { sources: sourcesScoring([{ path: 'note.md', similarity: 0.45 }]) },
    );
    try {
      const tool = buildSearchNotesTool({
        ...deps,
        similarity: { ...TEST_SIMILARITY, fallback: 0.42 },
      });
      const out = await callTool<SearchNotesOutput>(registerTool(tool), { query: ['щось'] });
      expect(out.query_stats!['щось'].note).toBe(
        'Semantic hits came from the 0.42 fallback retry, so they are weaker than a normal result.',
      );
    } finally {
      await cleanup();
    }
  });
});

describe('lexical reader failure', () => {
  const failingReader = {
    search: vi.fn().mockRejectedValue(new LexicalSearchError('boom')),
    warm: vi.fn().mockResolvedValue(undefined),
  };

  it('a lexical failure is DEPENDENCY_ERROR', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'note.md': 'зміст' });
    try {
      deps.registry.list()[0].lexical = failingReader;
      const warn = vi.fn();
      const reg = registerTool(buildSearchNotesTool({ ...deps, warn }));
      const payload = await expectToolError(reg, { query: 'зміст' });
      expect(payload.code).toBe('DEPENDENCY_ERROR');
      expect(payload.message).toBe('Lexical search failed');
      expect(payload.details).toMatchObject({ vault: 'v', operation: 'search_notes' });
      // The client sees only the generic message; the cause goes to stderr.
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(logged).toContain('"v"');
      expect(logged).toContain('boom');
    } finally {
      await cleanup();
    }
  });

  it('a lexical failure never flips the semantic fallback status', async () => {
    // The lexical leg runs first and its failure is not a semantic failure, so
    // the call fails as a whole rather than answering with a degraded status.
    const { deps, cleanup } = await makeLexicalVault(
      { 'note.md': 'зміст' },
      { sources: sourcesWithEmbeddingFor('note.md'), backendStatus: { state: 'ready' } },
    );
    try {
      deps.registry.list()[0].lexical = failingReader;
      const reg = registerTool(buildSearchNotesTool(deps));
      const payload = await expectToolError(reg, { query: 'зміст' });
      expect(payload.code).toBe('DEPENDENCY_ERROR');
    } finally {
      await cleanup();
    }
  });

  it('in a multi-vault fan-out it is one vault failing, not the whole call', async () => {
    const a = await makeLexicalVault({ 'пошук a.md': '' });
    const b = await makeLexicalVault({ 'пошук b.md': '' }, { semantic: false });
    const registry = makeTestRegistry([...a.deps.registry.list(), ...b.deps.registry.list()]);
    registry.list()[1].name = 'w';
    registry.list()[1].lexical = failingReader;
    try {
      const reg = registerTool(buildSearchNotesTool({ ...a.deps, registry }));
      const out = await callTool<IFanOutResult<SearchNotesOutput>>(reg, { query: 'пошук' });
      expect(out.results_by_vault.map((r) => r.vault)).toEqual(['v']);
      expect(out.failed_vaults).toHaveLength(1);
      expect(out.failed_vaults[0]).toMatchObject({
        vault: 'w',
        error: { code: 'DEPENDENCY_ERROR', message: 'Lexical search failed' },
      });
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
