import { describe, expect, it } from 'vitest';

import type { RankedNote } from '../../src/lib/obsidian/lexical/index.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../src/modules/semantic/search-engine.js';
import {
  runRetrievalPipeline,
  type RetrievalPipelineDeps,
  type RetrievalPipelineInput,
} from '../../src/modules/semantic/retrieval-pipeline.js';
import type { SmartSource } from '../../src/modules/semantic/types.js';

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
    sources.set(notePath(i), { path: notePath(i), embedding: vecFor(i), blocks: [] });
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
    snapshot: () => Promise.resolve({ sources: makeSources() }),
    lexical: {
      search: () =>
        Promise.resolve({
          notes: [lexicalNote(LEXICAL_ONLY), lexicalNote(notePath(9))],
          truncated: false,
          perQueryCounts: { quirkyterm: 2 },
          perQueryTokenCounts: {},
          totalNotes: NOTE_COUNT + 1,
        }),
    },
    getBacklinkCount: () => 0,
    filterExisting: (paths) => Promise.resolve(new Set(paths)),
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embed: () => Promise.resolve(QUERY_VECTOR),
    },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
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
    expect(result.lexical.perQueryCounts).toEqual({ quirkyterm: 2 });
  });

  it('cap slices the fused list and reports merged-cap truncation', async () => {
    const result = await runRetrievalPipeline({ ...DEEP, cap: 3 }, makeDeps());
    expect(result.candidates).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('surfaces a leg pool overflow even when the merged cap is not hit', async () => {
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
      },
    });
    const result = await runRetrievalPipeline({ ...DEEP, cap: 50 }, deps);
    expect(result.candidates.length).toBeLessThan(50);
    expect(result.truncated).toBe(true);
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
    const deps = makeDeps({ snapshot: () => Promise.reject(boom) });
    const result = await runRetrievalPipeline({ ...DEEP }, deps);
    expect(result.semantic).toEqual({ status: 'failed', error: boom });
    expect(result.candidates.map((c) => c.path)).toEqual([LEXICAL_ONLY, notePath(9)]);
    expect(result.candidates.every((c) => c.semantic === undefined)).toBe(true);
  });

  it('skips the semantic leg when the caller opts out or no snapshot exists', async () => {
    const optedOut = await runRetrievalPipeline({ ...DEEP, semantic: false }, makeDeps());
    expect(optedOut.semantic).toEqual({ status: 'skipped' });
    const noBackend = await runRetrievalPipeline({ ...DEEP }, makeDeps({ snapshot: undefined }));
    expect(noBackend.semantic).toEqual({ status: 'skipped' });
    expect(noBackend.candidates.map((c) => c.path)).toEqual([LEXICAL_ONLY, notePath(9)]);
  });

  it('narrows the semantic sources by the allowed set', async () => {
    const allowed = new Set([notePath(1), notePath(2), LEXICAL_ONLY]);
    const result = await runRetrievalPipeline({ ...DEEP, allowed }, makeDeps());
    for (const c of result.candidates) {
      if (c.semantic) expect(allowed.has(c.path)).toBe(true);
    }
  });
});
