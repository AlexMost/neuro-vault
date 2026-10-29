import { describe, expect, it } from 'vitest';

import { CorpusNotReadyError } from '../../src/lib/obsidian/semantic-backend.js';
import type {
  LexicalLegOutcome,
  SemanticLegOutcome,
} from '../../src/modules/semantic/retrieval-pipeline.js';
import {
  deriveObservability,
  type LegOutcomes,
  type ObservabilityContext,
} from '../../src/modules/semantic/search-observability.js';

// Every sentence verbatim: they are part of the tool contract, so a reworded one
// must fail here rather than pass a regex.
const INDEXING =
  'The semantic leg did not run — the index is still building, so these matches are lexical-only.';
const DISABLED =
  'The semantic leg did not run — semantic search is turned off (for this vault, or server-wide), so these matches are lexical-only.';
const UNAVAILABLE =
  'The semantic leg did not run — this vault has no usable semantic index, so these matches are lexical-only.';
const REPHRASE = 'No hits in any leg that ran — rephrase or drop this variant.';
const SPLIT =
  'No hits: every token matches on its own but they never co-occur in one title, heading or paragraph — split this variant into separate array entries.';

function semanticRan(
  perQueryHits: Record<string, number>,
  overrides: Partial<Extract<SemanticLegOutcome, { status: 'ran' }>> = {},
): SemanticLegOutcome {
  return { status: 'ran', perQueryHits, perQueryFallback: {}, truncated: false, ...overrides };
}

function lexicalRan(
  perQueryCounts: Record<string, number>,
  overrides: Partial<Extract<LexicalLegOutcome, { status: 'ran' }>> = {},
): LexicalLegOutcome {
  return {
    status: 'ran',
    perQueryCounts,
    perQueryTokenCounts: {},
    totalNotes: 10,
    truncated: false,
    ...overrides,
  };
}

function outcomes(overrides: Partial<LegOutcomes> = {}): LegOutcomes {
  return {
    semantic: { status: 'skipped' },
    lexical: lexicalRan({}),
    truncated: false,
    ...overrides,
  };
}

function context(overrides: Partial<ObservabilityContext> = {}): ObservabilityContext {
  return {
    pinnedStatus: { state: 'ready' },
    queries: ['q'],
    isMulti: false,
    fallbackThreshold: 0.3,
    vault: 'v',
    ...overrides,
  };
}

describe('deriveObservability — semantic_status', () => {
  it('reports a ready backend with no counters and no note', () => {
    expect(deriveObservability(outcomes(), context()).semantic_status).toEqual({ state: 'ready' });
  });

  it('reports an absent backend as disabled', () => {
    expect(
      deriveObservability(outcomes(), context({ pinnedStatus: undefined })).semantic_status,
    ).toEqual({ state: 'disabled', note: DISABLED });
  });

  it('carries the indexing counters, defaulting them to 0 before the scan lands', () => {
    expect(
      deriveObservability(
        outcomes(),
        context({ pinnedStatus: { state: 'indexing', indexed: 3, total: 9 } }),
      ).semantic_status,
    ).toEqual({ state: 'indexing', indexed: 3, total: 9, note: INDEXING });
    expect(
      deriveObservability(outcomes(), context({ pinnedStatus: { state: 'indexing' } }))
        .semantic_status,
    ).toEqual({ state: 'indexing', indexed: 0, total: 0, note: INDEXING });
  });

  it('explains disabled and unavailable, never exposing the backend reason', () => {
    expect(
      deriveObservability(outcomes(), context({ pinnedStatus: { state: 'disabled' } }))
        .semantic_status,
    ).toEqual({ state: 'disabled', note: DISABLED });
    expect(
      deriveObservability(
        outcomes(),
        context({ pinnedStatus: { state: 'unavailable', reason: 'shard store unreadable' } }),
      ).semantic_status,
    ).toEqual({ state: 'unavailable', note: UNAVAILABLE });
  });

  it('reports the status a not-ready refusal carries over the pinned ready', () => {
    const error = new CorpusNotReadyError({ state: 'indexing', indexed: 1, total: 6 });
    expect(
      deriveObservability(outcomes({ semantic: { status: 'failed', error } }), context())
        .semantic_status,
    ).toEqual({ state: 'indexing', indexed: 1, total: 6, note: INDEXING });
  });

  it('reports any other semantic failure as unavailable', () => {
    expect(
      deriveObservability(
        outcomes({ semantic: { status: 'failed', error: new Error('x') } }),
        context(),
      ).semantic_status,
    ).toEqual({ state: 'unavailable', note: UNAVAILABLE });
  });
});

describe('deriveObservability — query_stats', () => {
  const multi = (queries: string[], overrides: Partial<ObservabilityContext> = {}) =>
    context({ queries, isMulti: true, ...overrides });

  it('is absent for a single string query', () => {
    expect(
      deriveObservability(outcomes({ semantic: semanticRan({ q: 1 }) }), context()),
    ).not.toHaveProperty('query_stats');
  });

  it('reports pre-cap counts per query, 0 for a query a leg did not count', () => {
    const result = deriveObservability(
      outcomes({ semantic: semanticRan({ a: 2 }), lexical: lexicalRan({ b: 1 }) }),
      multi(['a', 'b']),
    );
    expect(result.query_stats).toEqual({
      a: { semantic: 2, lexical: 0 },
      b: { semantic: 0, lexical: 1 },
    });
  });

  it('reports semantic null when the semantic leg was skipped', () => {
    const result = deriveObservability(
      outcomes({ lexical: lexicalRan({ a: 1, b: 0 }) }),
      multi(['a', 'b']),
    );
    expect(result.query_stats).toEqual({
      a: { semantic: null, lexical: 1 },
      b: { semantic: null, lexical: 0, note: REPHRASE },
    });
  });

  it('reports a failed semantic leg as one that did not run, with no fallback flag', () => {
    const result = deriveObservability(
      outcomes({
        semantic: { status: 'failed', error: new Error('x') },
        lexical: lexicalRan({ a: 1, b: 0 }),
      }),
      multi(['a', 'b']),
    );
    expect(result.query_stats).toEqual({
      a: { semantic: null, lexical: 1 },
      b: { semantic: null, lexical: 0, note: REPHRASE },
    });
  });

  it('diagnoses nothing when neither leg ran', () => {
    const result = deriveObservability(
      { semantic: { status: 'skipped' }, lexical: { status: 'skipped' }, truncated: false },
      multi(['x', 'y z']),
    );
    expect(result.query_stats).toEqual({
      x: { semantic: null, lexical: 0 },
      'y z': { semantic: null, lexical: 0 },
    });
  });

  it('calls a variant with no hits in either leg dead', () => {
    const result = deriveObservability(
      outcomes({ semantic: semanticRan({ a: 1, b: 0 }), lexical: lexicalRan({ a: 1 }) }),
      multi(['a', 'b']),
    );
    expect(result.query_stats).toEqual({
      a: { semantic: 1, lexical: 1 },
      b: { semantic: 0, lexical: 0, note: REPHRASE },
    });
  });

  it('names the one token that kills the AND match', () => {
    const tokens = { ретеншн: 0, алертів: 1 };
    const result = deriveObservability(
      outcomes({
        lexical: lexicalRan({}, { perQueryTokenCounts: { 'ретеншн алертів': tokens } }),
      }),
      multi(['ретеншн алертів']),
    );
    expect(result.query_stats).toEqual({
      'ретеншн алертів': {
        semantic: null,
        lexical: 0,
        lexical_tokens: tokens,
        note: 'No hits: "ретеншн" match no note alone, which kills the AND match — drop or replace it.',
      },
    });
  });

  it('names every killer token, in the plural', () => {
    const result = deriveObservability(
      outcomes({
        lexical: lexicalRan({}, { perQueryTokenCounts: { 'a b c': { a: 0, b: 0, c: 4 } } }),
      }),
      multi(['a b c']),
    );
    expect(result.query_stats!['a b c'].note).toBe(
      'No hits: "a", "b" match no note alone, which kills the AND match — drop or replace them.',
    );
  });

  it('tells a variant whose tokens all match alone to split', () => {
    const result = deriveObservability(
      outcomes({ lexical: lexicalRan({}, { perQueryTokenCounts: { 'a b': { a: 2, b: 1 } } }) }),
      multi(['a b']),
    );
    expect(result.query_stats!['a b'].note).toBe(SPLIT);
  });

  it('keeps a token diagnosis silent while the semantic leg found the variant', () => {
    const result = deriveObservability(
      outcomes({
        semantic: semanticRan({ 'a b': 1 }),
        lexical: lexicalRan({}, { perQueryTokenCounts: { 'a b': { a: 0, b: 1 } } }),
      }),
      multi(['a b']),
    );
    expect(result.query_stats).toEqual({
      'a b': { semantic: 1, lexical: 0, lexical_tokens: { a: 0, b: 1 } },
    });
  });

  it('flags fallback-rescued hits and names the active fallback threshold', () => {
    const result = deriveObservability(
      outcomes({ semantic: semanticRan({ a: 1, b: 2 }, { perQueryFallback: { a: true } }) }),
      multi(['a', 'b'], { fallbackThreshold: 0.42 }),
    );
    expect(result.query_stats).toEqual({
      a: {
        semantic: 1,
        lexical: 0,
        semantic_fallback: true,
        note: 'Semantic hits came from the 0.42 fallback retry, so they are weaker than a normal result.',
      },
      b: { semantic: 2, lexical: 0 },
    });
  });

  it('derives no fallback flag or note under a profile without a fallback', () => {
    const result = deriveObservability(
      outcomes({
        semantic: semanticRan({ a: 1, b: 0 }, { perQueryFallback: { a: false, b: false } }),
      }),
      multi(['a', 'b'], { fallbackThreshold: undefined }),
    );
    expect(result.query_stats?.a).toEqual({ semantic: 1, lexical: 0 });
    expect(result.query_stats?.b).not.toHaveProperty('semantic_fallback');
  });

  it('ranks a dead-variant diagnosis above the fallback note', () => {
    const result = deriveObservability(
      outcomes({ semantic: semanticRan({ a: 0 }, { perQueryFallback: { a: true } }) }),
      multi(['a']),
    );
    expect(result.query_stats).toEqual({
      a: { semantic: 0, lexical: 0, semantic_fallback: true, note: REPHRASE },
    });
  });
});

describe('deriveObservability — truncated', () => {
  it('is false when no stage dropped a candidate', () => {
    expect(deriveObservability(outcomes({ semantic: semanticRan({}) }), context()).truncated).toBe(
      false,
    );
  });

  it('is true when any one stage dropped a candidate', () => {
    for (const truncatedBy of [
      outcomes({ truncated: true }),
      outcomes({ lexical: lexicalRan({}, { truncated: true }) }),
      outcomes({ semantic: semanticRan({}, { truncated: true }) }),
    ]) {
      expect(deriveObservability(truncatedBy, context()).truncated).toBe(true);
    }
  });

  it('is false when neither leg ran', () => {
    expect(
      deriveObservability(
        { semantic: { status: 'skipped' }, lexical: { status: 'skipped' }, truncated: false },
        context(),
      ).truncated,
    ).toBe(false);
  });
});

describe('deriveObservability — warning', () => {
  it('words the degradation for stderr when the semantic leg failed', () => {
    expect(
      deriveObservability(
        outcomes({ semantic: { status: 'failed', error: new Error('boom') } }),
        context({ vault: 'v' }),
      ).warning,
    ).toBe(
      'neuro-vault semantic: search_notes fell back to its lexical leg for vault "v": Error: boom',
    );
  });

  it('is absent when the semantic leg ran or was skipped', () => {
    expect(deriveObservability(outcomes(), context())).not.toHaveProperty('warning');
    expect(
      deriveObservability(outcomes({ semantic: semanticRan({}) }), context()),
    ).not.toHaveProperty('warning');
  });
});
