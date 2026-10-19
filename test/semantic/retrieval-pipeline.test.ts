import { describe, expect, it, vi } from 'vitest';

import type { RankedNote } from '../../src/lib/obsidian/lexical/index.js';
import {
  runRetrievalPipeline,
  type RetrievalPipelineDeps,
  type RetrievalPipelineInput,
} from '../../src/modules/semantic/retrieval-pipeline.js';
import { corpusOver } from '../_memory-corpus.js';
import type { SmartSource } from '../../src/modules/semantic/types.js';
import { TEST_SIMILARITY } from '../_identity.js';

// Same geometry as the old production-fusion pin: 10 unit vectors fanned away
// from the query vector, so at deep effort (pool 8) n0..n7 seed and n8/n9 are
// expansion-only. No temp vault, registry, or tool construction anywhere.
const NOTE_COUNT = 10;
const QUERY_VECTOR = [1, 0, 0];
const notePath = (i: number): string => `Notes/n${i}.md`;

function vecFor(i: number): number[] {
  const t = i / NOTE_COUNT;
  return [Math.cos(t), Math.sin(t), 0];
}

function makeSources(): Map<string, SmartSource> {
  const sources = new Map<string, SmartSource>();
  for (let i = 0; i < NOTE_COUNT; i++) {
    sources.set(notePath(i), {
      path: notePath(i),
      embedding: Float32Array.from(vecFor(i)),
      blocks: [],
    });
  }
  return sources;
}

const LEXICAL_ONLY = 'Notes/lexical-only.md';

function lexicalNote(path: string): RankedNote {
  return {
    path,
    matches: [{ matched_in: 'body', snippet: 'quirkyterm' }],
    matchedQueries: ['quirkyterm'],
  };
}

function makeDeps(overrides: Partial<RetrievalPipelineDeps> = {}): RetrievalPipelineDeps {
  return {
    corpus: corpusOver(makeSources()),
    lexical: {
      search: () =>
        Promise.resolve({
          notes: [lexicalNote(LEXICAL_ONLY), lexicalNote(notePath(9))],
          truncated: false,
          perQueryCounts: { quirkyterm: 2 },
          perQueryTokenCounts: {},
          totalNotes: NOTE_COUNT + 1,
        }),
      warm: () => Promise.resolve(),
    },
    filterExisting: (paths) => Promise.resolve(new Set(paths)),
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embedQuery: () => Promise.resolve(QUERY_VECTOR),
    },
    similarity: TEST_SIMILARITY,
    ...overrides,
  };
}

const DEEP: RetrievalPipelineInput = {
  queries: ['quirkyterm'],
  effort: 'deep',
  semantic: true,
  threshold: 0,
};

describe('runRetrievalPipeline', () => {
  it('fuses all three legs with per-leg provenance', async () => {
    const result = await runRetrievalPipeline({ ...DEEP }, makeDeps());
    const byPath = new Map(result.candidates.map((c) => [c.path, c]));
    // Lexical-only and expansion-only notes both survive into the fused list.
    expect(byPath.get(LEXICAL_ONLY)?.lexical).toBeDefined();
    expect(byPath.get(LEXICAL_ONLY)?.semantic).toBeUndefined();
    const expansionOnly = [notePath(8), notePath(9)].filter((p) => byPath.get(p)?.expansion);
    expect(expansionOnly.length).toBeGreaterThan(0);
    // A seed carries its semantic node; the fused order is not the pure semantic order.
    expect(byPath.get(notePath(0))?.semantic?.similarity).toBeTypeOf('number');
    expect(result.candidates.map((c) => c.path)).not.toEqual(
      [...makeSources().keys()].slice(0, result.candidates.length),
    );
    expect(result.semantic).toMatchObject({ status: 'ran', perQueryHits: { quirkyterm: 8 } });
    expect(result.lexical).toMatchObject({ status: 'ran', perQueryCounts: { quirkyterm: 2 } });
  });

  it('reports the lexical leg as a ran record with its counts', async () => {
    const result = await runRetrievalPipeline({ ...DEEP }, makeDeps());
    expect(result.lexical).toEqual({
      status: 'ran',
      perQueryCounts: { quirkyterm: 2 },
      perQueryTokenCounts: {},
      totalNotes: NOTE_COUNT + 1,
      truncated: false,
    });
  });

  it('hands the lexical reader the leg options and no backlink callback', async () => {
    const base = makeDeps().lexical;
    const search = vi.fn(base.search);
    await runRetrievalPipeline(
      { ...DEEP, allowed: new Set([LEXICAL_ONLY]) },
      makeDeps({ lexical: { ...base, search } }),
    );
    expect(search).toHaveBeenCalledTimes(1);
    const opts = search.mock.calls[0][0];
    expect(opts).toEqual({
      queries: ['quirkyterm'],
      allowed: new Set([LEXICAL_ONLY]),
      noteCap: expect.any(Number),
      perNoteCap: expect.any(Number),
    });
  });

  it('cap slices the fused list and reports merged-cap truncation', async () => {
    const result = await runRetrievalPipeline({ ...DEEP, cap: 3 }, makeDeps());
    expect(result.candidates).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.lexical).toMatchObject({ truncated: false });
  });

  it('records a leg pool overflow on that leg, not as a merged-cap cut', async () => {
    const deps = makeDeps({
      lexical: {
        search: () =>
          Promise.resolve({
            notes: [lexicalNote(LEXICAL_ONLY)],
            truncated: true,
            perQueryCounts: { quirkyterm: 1 },
            perQueryTokenCounts: {},
            totalNotes: NOTE_COUNT + 1,
          }),
        warm: () => Promise.resolve(),
      },
    });
    const result = await runRetrievalPipeline({ ...DEEP, cap: 50 }, deps);
    expect(result.candidates.length).toBeLessThan(50);
    expect(result.truncated).toBe(false);
    expect(result.lexical).toMatchObject({ status: 'ran', truncated: true });
  });

  it('records the semantic pool cut on its own record', async () => {
    // 10 seeds above threshold 0 against deep's pool of 8.
    const result = await runRetrievalPipeline({ ...DEEP, cap: 50 }, makeDeps());
    expect(result.truncated).toBe(false);
    expect(result.semantic).toMatchObject({ status: 'ran', truncated: true });
  });

  it('keeps pre-cap per-query counts under a merged cap of one', async () => {
    const result = await runRetrievalPipeline({ ...DEEP, cap: 1 }, makeDeps());
    expect(result.candidates).toHaveLength(1);
    expect(result.semantic).toMatchObject({ status: 'ran', perQueryHits: { quirkyterm: 8 } });
    expect(result.lexical).toMatchObject({ status: 'ran', perQueryCounts: { quirkyterm: 2 } });
  });

  it('reads neither leg over an empty allowed set', async () => {
    const base = makeDeps();
    const search = vi.fn(base.lexical.search);
    const embedQuery = vi.fn(base.embeddingProvider.embedQuery);
    const result = await runRetrievalPipeline(
      { ...DEEP, allowed: new Set() },
      makeDeps({
        lexical: { ...base.lexical, search },
        embeddingProvider: { ...base.embeddingProvider, embedQuery },
      }),
    );
    expect(search).not.toHaveBeenCalled();
    expect(embedQuery).not.toHaveBeenCalled();
    expect(result).toEqual({
      candidates: [],
      truncated: false,
      semantic: { status: 'skipped' },
      lexical: { status: 'skipped' },
    });
  });

  it('existence-filters seeds and their expansion targets before fusion', async () => {
    const deps = makeDeps({
      filterExisting: (paths) =>
        Promise.resolve(new Set(paths.filter((p) => p !== notePath(0) && p !== notePath(8)))),
    });
    const result = await runRetrievalPipeline({ ...DEEP }, deps);
    const paths = result.candidates.map((c) => c.path);
    expect(paths).not.toContain(notePath(0));
    expect(paths).not.toContain(notePath(8));
    for (const c of result.candidates) {
      for (const rel of c.semantic?.related ?? []) {
        expect(rel.path).not.toBe(notePath(8));
      }
    }
  });

  it('degrades to the already-computed lexical results when the semantic leg throws', async () => {
    const boom = new Error('no model on disk');
    const deps = makeDeps({
      corpus: { nearest: () => Promise.reject(boom), nearestBlocks: () => Promise.reject(boom) },
    });
    const result = await runRetrievalPipeline({ ...DEEP }, deps);
    expect(result.semantic).toEqual({ status: 'failed', error: boom });
    expect(result.candidates.map((c) => c.path)).toEqual([LEXICAL_ONLY, notePath(9)]);
    expect(result.candidates.every((c) => c.semantic === undefined)).toBe(true);
  });

  it('skips the semantic leg when the caller opts out or no corpus exists', async () => {
    const optedOut = await runRetrievalPipeline({ ...DEEP, semantic: false }, makeDeps());
    expect(optedOut.semantic).toEqual({ status: 'skipped' });
    const noBackend = await runRetrievalPipeline({ ...DEEP }, makeDeps({ corpus: undefined }));
    expect(noBackend.semantic).toEqual({ status: 'skipped' });
    expect(noBackend.candidates.map((c) => c.path)).toEqual([LEXICAL_ONLY, notePath(9)]);
  });

  it('narrows the semantic leg by the allowed set', async () => {
    const allowed = new Set([notePath(1), notePath(2), LEXICAL_ONLY]);
    const corpus = corpusOver(makeSources());
    const nearest = vi.spyOn(corpus, 'nearest');
    const result = await runRetrievalPipeline({ ...DEEP, allowed }, makeDeps({ corpus }));
    for (const c of result.candidates) {
      if (c.semantic) expect(allowed.has(c.path)).toBe(true);
    }
    // Handed to the corpus as a list, on every note read.
    expect(nearest).toHaveBeenCalled();
    for (const [, opts] of nearest.mock.calls) expect(opts.allowed).toEqual([...allowed]);
  });
});
