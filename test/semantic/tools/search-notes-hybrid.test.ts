import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import type { IFanOutResult } from '../../../src/lib/fan-out.js';
import type { SearchEngine, SmartSource } from '../../../src/modules/semantic/types.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { makeSearchDeps, makeTestRegistry } from './_helpers.js';
import {
  engineReturning,
  makeLexicalVault,
  makeMockEngine,
  sourcesWithEmbeddingFor,
} from './_hybrid-helpers.js';

describe('unified matches shape', () => {
  it('returns one fused matches list with provenance and dual evidence', async () => {
    // vault: note hit by BOTH legs → single entry, both evidence kinds. Body
    // text deliberately avoids repeating "target" so the note surfaces via
    // exactly one lexical kind (title), keeping found_in assertion precise.
    const { deps, cleanup } = await makeLexicalVault(
      { 'Target.md': 'Notes on building a retrieval evaluation harness.\n' },
      {
        sources: sourcesWithEmbeddingFor('Target.md'),
        engine: engineReturning([{ path: 'Target.md', similarity: 0.8 }]),
      },
    );
    try {
      const out = (await buildSearchNotesTool(deps).handler({
        query: 'target',
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(1);
      const m = out.matches[0];
      expect(m.found_in).toEqual(['semantic', 'lexical:title']);
      expect(m.similarity).toBe(0.8);
      expect(m.lexical?.[0]?.matched_in).toBe('title');
      expect(out).not.toHaveProperty('semantic_matches');
      expect(out).not.toHaveProperty('lexical_matches');
      expect(out.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('degrades to pure lexical order in lexical mode with no semantic fields', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук', mode: 'lexical' })) as SearchNotesOutput;
      expect(out.matches.length).toBeGreaterThan(0);
      for (const m of out.matches) {
        expect(m.found_in.every((s) => s.startsWith('lexical:'))).toBe(true);
        expect(m.similarity).toBeUndefined();
        expect(m.expansion_similarity).toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  });

  it('caps the merged list via limit and reports truncated', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b пошук.md': '',
      'c пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        mode: 'lexical',
        limit: 2,
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(2);
      expect(out.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('surfaces leg-level truncation even when the merged cap is not hit', async () => {
    // 7 lexically-matching notes, quick effort: lexCap 5 == merged cap 5, so
    // the merged cap never fires on its own — only the lexical leg's
    // internal pool cap drops the other 2. `truncated` must still be true.
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`note-${i} пошук.md`] = '';
    const { deps, cleanup } = await makeLexicalVault(files);
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук', mode: 'lexical' })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(5);
      expect(out.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('truncated is false when neither the merged cap nor a leg pool cap dropped anything', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук', mode: 'lexical' })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(2);
      expect(out.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('surfaces the semantic leg pool overflow even when the lexical leg is empty and the merged cap is not hit', async () => {
    // 4 files that don't lexically match the query at all (0 lexical hits),
    // with the semantic engine mocked to always return all 4 regardless of
    // query — quick effort's semantic pool cap is 3, so the leg overflows
    // (4 > 3) even though the merged list (3 semantic-only entries) sits
    // well under the quick merged cap of 5.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`note-${i}.md`] = 'irrelevant body text';
    const sources: Map<string, SmartSource> = new Map(
      Object.keys(files).map((p) => [p, { path: p, embedding: [1, 0], blocks: [] }]),
    );
    const engine = engineReturning([
      { path: 'note-0.md', similarity: 0.9 },
      { path: 'note-1.md', similarity: 0.8 },
      { path: 'note-2.md', similarity: 0.7 },
      { path: 'note-3.md', similarity: 0.6 },
    ]);
    const { deps, cleanup } = await makeLexicalVault(files, { sources, engine });
    try {
      const out = (await buildSearchNotesTool(deps).handler({
        query: 'zzz-no-lexical-match',
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(3);
      expect(out.matches.every((m) => m.found_in.every((s) => s === 'semantic'))).toBe(true);
      expect(out.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('never returns an empty blocks array', async () => {
    // findBlockNeighbors is mocked to always return a hit for the seed note,
    // so `blocks` is populated (non-empty) whenever it's present at all —
    // proving `assembleUnified` never emits `blocks: []`.
    const notePath = 'пошук note.md';
    const sources = sourcesWithEmbeddingFor(notePath, [1, 0]);
    const engine: SearchEngine = {
      findNeighbors: vi.fn().mockReturnValue([{ path: notePath, similarity: 0.9 }]),
      findBlockNeighbors: vi
        .fn()
        .mockReturnValue([{ path: notePath, heading: '#h', lines: [1, 3], similarity: 0.7 }]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: 'зміст нотатки' },
      { sources, engine },
    );
    try {
      const out = (await buildSearchNotesTool(deps).handler({
        query: 'пошук',
        effort: 'quick',
      })) as SearchNotesOutput;
      for (const m of out.matches) {
        if ('blocks' in m) expect(m.blocks!.length).toBeGreaterThan(0);
      }
      expect(out.matches.some((m) => 'blocks' in m)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('lexical leg orchestration', () => {
  it('hybrid returns lexically-sourced matches when semantic is empty', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(1);
      expect(out.matches[0]).toMatchObject({
        path: 'Пошук.md',
        vault: 'v',
        backlink_count: 0,
        found_in: ['lexical:title'],
        lexical: [{ matched_in: 'title', snippet: 'Пошук' }],
      });
      expect(out.matches[0]).not.toHaveProperty('similarity');
    } finally {
      await cleanup();
    }
  });

  it('mode lexical works with NO corpus and does not touch the loader', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'n.md': "# Рішення\n\nоб'єкт тут.\n" },
      { semantic: false },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      // apostrophe variant in the query (U+2019) must still match (U+0027 in file)
      const out = (await tool.handler({ query: 'об’єкт', mode: 'lexical' })) as SearchNotesOutput;
      expect(out.matches.every((m) => m.found_in.every((s) => s.startsWith('lexical:')))).toBe(
        true,
      );
      expect(out.matches[0].lexical?.[0]).toMatchObject({
        matched_in: 'body',
        heading: 'Рішення',
        lines: [3, 3],
      });
    } finally {
      await cleanup();
    }
  });

  it('hybrid on a cold corpus still returns lexically-sourced matches instead of throwing', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' }, { semantic: false });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(1);
      expect(out.matches[0].found_in).toEqual(['lexical:title']);
      expect(out.matches[0].similarity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('filter binds the lexical leg through listMatchingPaths', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Tasks/a пошук.md': '',
      'Archive/b пошук.md': '',
    });
    // narrow the allowed set to Tasks/ only
    deps.registry.list()[0].listMatchingPaths = async () => new Set(['Tasks/a пошук.md']);
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        filter: { path_prefix: 'Tasks/' },
      })) as SearchNotesOutput;
      expect(out.matches.map((n) => n.path)).toEqual(['Tasks/a пошук.md']);
    } finally {
      await cleanup();
    }
  });

  it('mode: "lexical" never touches the corpus loader even when a corpus IS available', async () => {
    const notePath = 'Пошук note.md';
    const sources = sourcesWithEmbeddingFor(notePath);
    // If the corpus loader (or the semantic leg) were invoked despite
    // `mode: "lexical"`, this engine would surface a hit — proving the
    // assertion below isn't vacuously true because the corpus is empty.
    const engine = engineReturning([{ path: notePath, similarity: 0.9 }]);
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: '' }, { sources, engine });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        mode: 'lexical',
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(1);
      expect(out.matches[0].found_in).toEqual(['lexical:title']);
      const corpus = deps.registry.list()[0].corpus!;
      expect(corpus.snapshot).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('effort "deep" gives the lexical leg its larger default cap in hybrid mode', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`note-${i} пошук.md`] = '';
    const { deps: quickDeps, cleanup: quickCleanup } = await makeLexicalVault(files);
    const { deps: deepDeps, cleanup: deepCleanup } = await makeLexicalVault(files);
    try {
      const quickOut = (await buildSearchNotesTool(quickDeps).handler({
        query: 'пошук',
        // limit: 12 raises the merged cap well above lexCap 5, so a lexCap
        // regression (e.g. lexCap silently widening) can't hide behind the
        // merged cap also being 5 by coincidence.
        limit: 12,
      })) as SearchNotesOutput; // effort defaults to "quick" -> lexCap 5 is the binding cap
      const deepOut = (await buildSearchNotesTool(deepDeps).handler({
        query: 'пошук',
        effort: 'deep',
      })) as SearchNotesOutput; // lexCap 10, merged cap 12, so all 7 notes fit
      expect(quickOut.matches).toHaveLength(5);
      expect(deepOut.matches).toHaveLength(7);
    } finally {
      await quickCleanup();
      await deepCleanup();
    }
  });

  it('limit steers the merged list in lexical mode', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b пошук.md': '',
      'c пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: 'пошук',
        mode: 'lexical',
        limit: 2,
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe('search_notes input axes (SDK gate)', () => {
  async function makeTool() {
    const { deps, cleanup } = await makeSearchDeps({
      sources: new Map(),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeMockEngine(),
      modelKey: 'k',
    });
    return { tool: buildSearchNotesTool(deps), cleanup };
  }

  it('rejects old mode values quick/deep', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      for (const bad of ['quick', 'deep']) {
        const parsed = tool.inputSchema.safeParse({ query: 'x', mode: bad });
        expect(parsed.success).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });

  it('accepts the new axes and defaults', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: 'x' }).success).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'hybrid', effort: 'deep' }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({ query: 'x', mode: 'lexical', effort: 'quick' }).success,
      ).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', effort: 'exhaustive' }).success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('response carries matches and truncated, no split keys or results key', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      const out = await tool.handler({ query: 'x' });
      expect(out).toHaveProperty('matches');
      expect(out).toHaveProperty('truncated');
      expect(out).not.toHaveProperty('semantic_matches');
      expect(out).not.toHaveProperty('lexical_matches');
      expect(out).not.toHaveProperty('related');
      expect(out).not.toHaveProperty('results');
    } finally {
      await cleanup();
    }
  });

  it('filter-shape validation wins over query normalization when both are invalid', async () => {
    // A whitespace-only query entry passes schema (array length >= 1 is all
    // zod checks) but fails `normalizeQueryArray` at the handler level. An
    // empty filter object fails `isFilterEmpty` at the handler level too.
    // Filter-shape validation must win — it ran first before query_stats
    // existed, and query_stats support must not silently reorder it.
    const { tool, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: ['   '], filter: {} }).success).toBe(true);
      await expect(tool.handler({ query: ['   '], filter: {} })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('filter must specify at least one of'),
      });
    } finally {
      await cleanup();
    }
  });
});

describe('multi-query and fan-out', () => {
  it('multi-query unions matched_queries across matches', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Vector search.md': '',
      'Векторний пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['vector search', 'векторний пошук'],
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(2);
      const byPath = Object.fromEntries(out.matches.map((m) => [m.path, m.matched_queries]));
      expect(byPath['Vector search.md']).toEqual(['vector search']);
      expect(byPath['Векторний пошук.md']).toEqual(['векторний пошук']);
      expect(out.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('multi-vault fan-out wraps the unified shape per vault', async () => {
    // build TWO lexical vaults and register both under one registry
    const a = await makeLexicalVault({ 'пошук a.md': '' });
    const b = await makeLexicalVault({ 'пошук b.md': '' }, { semantic: false });
    const registry = makeTestRegistry([...a.deps.registry.list(), ...b.deps.registry.list()]);
    // rename second entry to avoid the name collision
    registry.list()[1].name = 'w';
    try {
      const tool = buildSearchNotesTool({ ...a.deps, registry });
      const out = (await tool.handler({ query: 'пошук' })) as IFanOutResult<SearchNotesOutput>;
      expect(out).toHaveProperty('results_by_vault');
      expect(out.results_by_vault).toHaveLength(2);
      for (const vaultResult of out.results_by_vault) {
        // The fan-out envelope flattens per-vault fields alongside `vault`
        // (results_by_vault: [{ vault, ...T }]), not nested under `.result`.
        expect(vaultResult).toHaveProperty('matches');
        expect(vaultResult).toHaveProperty('truncated');
      }
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

describe('query_stats', () => {
  it('reports pre-cap per-query stats and surfaces dead variants', async () => {
    // "пошук" matches both lexically (title) and semantically; "Мобі"
    // matches nothing in either leg — a dead query variant.
    const sources = sourcesWithEmbeddingFor('пошук note.md', [1, 0]);
    const engine: SearchEngine = {
      findNeighbors: vi.fn(({ queryVector }: { queryVector: number[] }) =>
        queryVector[0] === 1 ? [{ path: 'пошук note.md', similarity: 0.9 }] : [],
      ),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      { 'пошук note.md': 'зміст нотатки' },
      { sources, engine },
    );
    deps.embeddingProvider.embed = vi.fn(async (q: string) => (q === 'пошук' ? [1, 0] : [0, 1]));
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: ['пошук', 'Мобі'] })) as SearchNotesOutput;
      expect(out.query_stats).toEqual({
        пошук: { semantic: 1, lexical: 1 },
        Мобі: { semantic: 0, lexical: 0 },
      });
    } finally {
      await cleanup();
    }
  });

  it('unions matched_queries across legs even when each leg is hit by a different query', async () => {
    // note hit lexically by q1 ("пошук"), semantically by q2 ("vector") only.
    const notePath = 'Target пошук.md';
    const sources = sourcesWithEmbeddingFor(notePath, [1, 0]);
    const engine: SearchEngine = {
      findNeighbors: vi.fn(({ queryVector }: { queryVector: number[] }) =>
        queryVector[0] === 1 ? [{ path: notePath, similarity: 0.9 }] : [],
      ),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: '' }, { sources, engine });
    deps.embeddingProvider.embed = vi.fn(async (q: string) => (q === 'vector' ? [1, 0] : [0, 1]));
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['пошук', 'vector'],
      })) as SearchNotesOutput;
      const m = out.matches.find((x) => x.path === notePath);
      expect(m?.matched_queries?.sort()).toEqual(['vector', 'пошук']);
    } finally {
      await cleanup();
    }
  });

  it('omits query_stats for a string query', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'пошук.md': '' });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
      expect(out.query_stats).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("reports pre-cap stats even when the merge cap drops all of a query's notes", async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b тест.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['пошук', 'тест'],
        mode: 'lexical',
        limit: 1,
      })) as SearchNotesOutput;
      // the merged cap keeps only one of the two notes...
      expect(out.matches).toHaveLength(1);
      // ...but both queries still report their pre-cap lexical hit count.
      // mode: 'lexical' — the semantic leg never ran, so semantic is null.
      expect(out.query_stats).toEqual({
        пошук: { semantic: null, lexical: 1 },
        тест: { semantic: null, lexical: 1 },
      });
    } finally {
      await cleanup();
    }
  });

  it("reports pre-cap semantic stats even when the merge cap drops all of a query's hits (hybrid mode)", async () => {
    // Two notes, each surfaced semantically by exactly one of the two
    // queries (and by neither lexically). `limit: 1` caps the merged list to
    // one entry, so whichever note loses the fusion tie-break is entirely
    // absent from `matches[]` — its query must still report its pre-cap
    // semantic hit count.
    const noteA = 'a.md';
    const noteB = 'b.md';
    const sources = new Map<string, SmartSource>([
      [noteA, { path: noteA, embedding: [1, 0], blocks: [] }],
      [noteB, { path: noteB, embedding: [0, 1], blocks: [] }],
    ]);
    const engine: SearchEngine = {
      findNeighbors: vi.fn(({ queryVector }: { queryVector: number[] }) =>
        queryVector[0] === 1
          ? [{ path: noteA, similarity: 0.9 }]
          : [{ path: noteB, similarity: 0.8 }],
      ),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      { [noteA]: '', [noteB]: '' },
      { sources, engine },
    );
    deps.embeddingProvider.embed = vi.fn(async (q: string) => (q === 'q1' ? [1, 0] : [0, 1]));
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['q1', 'q2'],
        limit: 1,
      })) as SearchNotesOutput;
      expect(out.matches).toHaveLength(1);
      expect(out.query_stats).toEqual({
        q1: { semantic: 1, lexical: 0 },
        q2: { semantic: 1, lexical: 0 },
      });
    } finally {
      await cleanup();
    }
  });

  it('reports query_stats in lexical mode with semantic null', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '',
      'b тест.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['пошук', 'нема'],
        mode: 'lexical',
      })) as SearchNotesOutput;
      expect(out.query_stats).toEqual({
        пошук: { semantic: null, lexical: 1 },
        нема: { semantic: null, lexical: 0 },
      });
    } finally {
      await cleanup();
    }
  });

  it('reports query_stats with semantic null when no semantic corpus is available', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'пошук note.md': '' }, { semantic: false });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['пошук', 'нема'],
      })) as SearchNotesOutput;
      expect(out.query_stats).toEqual({
        пошук: { semantic: null, lexical: 1 },
        нема: { semantic: null, lexical: 0 },
      });
    } finally {
      await cleanup();
    }
  });

  it('query_stats accompanies the empty-filter early return for array queries', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'a.md': '' },
      { listMatchingPaths: async () => new Set() },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['x', 'y'],
        filter: { path_prefix: 'nomatch/' },
      })) as SearchNotesOutput;
      expect(out.matches).toEqual([]);
      expect(out.query_stats).toEqual({
        x: { semantic: null, lexical: 0 },
        y: { semantic: null, lexical: 0 },
      });
    } finally {
      await cleanup();
    }
  });

  it('names the killer token for an AND-killed multi-token query', async () => {
    // vault fixture: a note containing «алертів» but not «ретеншн».
    const { deps, cleanup } = await makeLexicalVault({
      'note.md': 'зміст про алертів у системі',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['ретеншн алертів'],
        mode: 'lexical',
      })) as SearchNotesOutput;
      expect(out.query_stats!['ретеншн алертів']).toEqual({
        semantic: null,
        lexical: 0,
        lexical_tokens: { ретеншн: 0, алертів: 1 },
      });
    } finally {
      await cleanup();
    }
  });

  it('omits lexical_tokens for single-token dead queries and for matching queries', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'note.md': 'звіт про пошук у системі',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = (await tool.handler({
        query: ['нема', 'пошук'],
        mode: 'lexical',
      })) as SearchNotesOutput;
      expect(out.query_stats!['нема']).toEqual({ semantic: null, lexical: 0 });
      expect(out.query_stats!['пошук'].lexical_tokens).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('expansion_floor input schema (SDK gate)', () => {
  it('advertises and validates expansion_floor', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'x' });
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const inputSchema = reg.spec.inputSchema as z.ZodTypeAny;
      expect(inputSchema.safeParse({ query: 'x', expansion_floor: 0.93 }).success).toBe(true);
      // tolerant-arguments: numeric strings coerce
      expect(inputSchema.safeParse({ query: 'x', expansion_floor: '0.93' }).success).toBe(true);
      expect(inputSchema.safeParse({ query: 'x', expansion_floor: 1.5 }).success).toBe(false);
      expect(inputSchema.safeParse({ query: 'x', expansion_floor: -0.1 }).success).toBe(false);
      expect(reg.spec.description).toContain('expansion_floor');
    } finally {
      await cleanup();
    }
  });

  it('accepts expansion_floor as inert in lexical mode and quick effort', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'alpha text' });
    try {
      const tool = buildSearchNotesTool(deps);
      await expect(
        tool.handler({ query: 'alpha', mode: 'lexical', expansion_floor: 0.9 }),
      ).resolves.toMatchObject({ truncated: false });
      await expect(
        tool.handler({ query: 'alpha', effort: 'quick', expansion_floor: 0.9 }),
      ).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

describe('query_stats semantic_fallback flag', () => {
  it('flags a query rescued by the default-threshold fallback', async () => {
    // Hits at 0.4: below the quick default 0.5, above the 0.3 fallback.
    const engine = makeMockEngine();
    engine.findNeighbors.mockImplementation(({ threshold }: { threshold: number }) =>
      threshold <= 0.4 ? [{ path: 'a.md', similarity: 0.4 }] : [],
    );
    const sources = sourcesWithEmbeddingFor('a.md');
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'body' }, { sources, engine });
    try {
      const tool = buildSearchNotesTool(deps);
      const output = (await tool.handler({ query: ['alpha', 'beta'] })) as {
        query_stats: Record<string, { semantic: number | null; semantic_fallback?: true }>;
      };
      expect(output.query_stats['alpha']).toMatchObject({ semantic: 1, semantic_fallback: true });
      expect(output.query_stats['beta']).toMatchObject({ semantic: 1, semantic_fallback: true });
    } finally {
      await cleanup();
    }
  });

  it('never flags explicit-threshold requests, even at zero hits', async () => {
    const engine = makeMockEngine(); // findNeighbors always []
    const sources = sourcesWithEmbeddingFor('a.md');
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'body' }, { sources, engine });
    try {
      const tool = buildSearchNotesTool(deps);
      const output = (await tool.handler({ query: ['alpha', 'beta'], threshold: 0.99 })) as {
        query_stats: Record<string, { semantic: number | null; semantic_fallback?: true }>;
      };
      expect(output.query_stats['alpha']).toEqual(
        expect.not.objectContaining({ semantic_fallback: true }),
      );
      expect(output.query_stats['alpha'].semantic).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('does not flag queries whose first pass had hits', async () => {
    const engine = makeMockEngine();
    engine.findNeighbors.mockReturnValue([{ path: 'a.md', similarity: 0.8 }]);
    const sources = sourcesWithEmbeddingFor('a.md');
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'body' }, { sources, engine });
    try {
      const tool = buildSearchNotesTool(deps);
      const output = (await tool.handler({ query: ['alpha', 'beta'] })) as {
        query_stats: Record<string, { semantic_fallback?: true }>;
      };
      expect(output.query_stats['alpha']).not.toHaveProperty('semantic_fallback');
    } finally {
      await cleanup();
    }
  });
});

describe('expansion_floor wiring', () => {
  it('forwards expansion_floor to the expansion leg as the per-seed findNeighbors threshold', async () => {
    const engine = makeMockEngine();
    engine.findNeighbors.mockReturnValue([{ path: 'a.md', similarity: 0.8 }]);
    const sources = sourcesWithEmbeddingFor('a.md');
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'alpha body' }, { sources, engine });
    try {
      const tool = buildSearchNotesTool(deps);
      await tool.handler({ query: 'alpha', effort: 'deep', expansion_floor: 0.91 });
      const thresholds = engine.findNeighbors.mock.calls.map(
        (call) => (call[0] as { threshold: number }).threshold,
      );
      // First call is the query pass at the deep default threshold (0.35);
      // a later call is the per-seed expansion lookup, which must carry the
      // forwarded expansion_floor rather than the default or the threshold.
      expect(thresholds).toContain(0.91);
    } finally {
      await cleanup();
    }
  });
});

describe('arity invariance (SDK gate)', () => {
  // Spec: "Semantic retrieval is arity-invariant" — a string query and a
  // one-element array query differ only in which fields surface.
  // These are characterization tests: they pass on the two-pipeline code
  // and must keep passing once the pipelines are folded into one.
  async function makeArityVault() {
    const notePath = 'Projects/alpha.md';
    return makeLexicalVault(
      { [notePath]: '# Alpha\n\nalpha beta gamma\n' },
      {
        sources: sourcesWithEmbeddingFor(notePath),
        engine: engineReturning([{ path: notePath, similarity: 0.82 }]),
      },
    );
  }

  it('a one-element array produces the same matches as the equivalent string', async () => {
    // Deep effort, plus a second source reachable only via expansion, so
    // `blocks` and `expansion_similarity` carry real (non-empty/defined)
    // values below. Under quick effort with no expansion these comparisons
    // reduce to [] === [] and undefined === undefined — vacuously true, and
    // blind to a fold that breaks block or expansion handling for one arity.
    const notePath = 'Projects/alpha.md';
    const relatedPath = 'Projects/related.md';
    const sources = new Map([
      [notePath, { path: notePath, embedding: [0, 1], blocks: [] }],
      [relatedPath, { path: relatedPath, embedding: [0.5, 0.5], blocks: [] }],
    ]);
    const engine = {
      // Main query pass embeds the query as [1, 0] (the default mock below);
      // the per-seed expansion pass looks up neighbours of the seed's OWN
      // embedding ([0, 1]) — the two are distinguishable by queryVector[0].
      findNeighbors: vi.fn(({ queryVector }: { queryVector: number[] }) =>
        queryVector[0] === 1
          ? [{ path: notePath, similarity: 0.82 }]
          : [{ path: relatedPath, similarity: 0.91 }],
      ),
      findBlockNeighbors: vi
        .fn()
        .mockReturnValue([{ path: notePath, heading: '#Alpha', lines: [1, 3], similarity: 0.7 }]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      {
        [notePath]: '# Alpha\n\nalpha beta gamma\n',
        // Deliberately no "alpha" token, so this note surfaces ONLY via
        // expansion, never the lexical leg.
        [relatedPath]: '# Unrelated\n\nfiller text only\n',
      },
      { sources, engine },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const asString = (await tool.handler({
        query: 'alpha',
        effort: 'deep',
      })) as SearchNotesOutput;
      const asArray = (await tool.handler({
        query: ['alpha'],
        effort: 'deep',
      })) as SearchNotesOutput;

      expect(asArray.matches.map((m) => m.path)).toEqual(asString.matches.map((m) => m.path));
      expect(asArray.truncated).toBe(asString.truncated);
      expect(asArray.matches.map((m) => m.similarity)).toEqual(
        asString.matches.map((m) => m.similarity),
      );
      expect(asArray.matches.map((m) => m.blocks)).toEqual(asString.matches.map((m) => m.blocks));
      expect(asArray.matches.map((m) => m.expansion_similarity)).toEqual(
        asString.matches.map((m) => m.expansion_similarity),
      );
      // Preconditions: the comparisons above are not vacuous.
      expect(asString.matches.length).toBeGreaterThan(0);
      expect(asString.matches[0].blocks?.length ?? 0).toBeGreaterThan(0);
      expect(asString.matches.some((m) => m.expansion_similarity !== undefined)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('arity changes only which fields surface', async () => {
    const { deps, cleanup } = await makeArityVault();
    try {
      const tool = buildSearchNotesTool(deps);
      const asString = (await tool.handler({ query: 'alpha' })) as SearchNotesOutput;
      const asArray = (await tool.handler({ query: ['alpha'] })) as SearchNotesOutput;

      // String: neither array-only field is present.
      expect(asString.query_stats).toBeUndefined();
      for (const match of asString.matches) {
        expect(match).not.toHaveProperty('matched_queries');
      }

      // Array of one: both present, and matched_queries names the one query.
      expect(Object.keys(asArray.query_stats!)).toEqual(['alpha']);
      for (const match of asArray.matches) {
        expect(match.matched_queries).toEqual(['alpha']);
      }

      // Nothing else differs: strip the two array-only fields and compare.
      const strip = (o: SearchNotesOutput) => ({
        truncated: o.truncated,
        matches: o.matches.map(({ matched_queries: _mq, ...rest }) => rest),
      });
      expect(strip(asArray)).toEqual(strip(asString));
    } finally {
      await cleanup();
    }
  });

  it('the semantic fallback fires identically at both arities', async () => {
    const notePath = 'Projects/alpha.md';
    // Fresh vault + engine PER ARITY: `mockReturnValueOnce([])` consumes
    // itself on the first call, so sharing one engine across both handler
    // calls would silently give the second arity a different (already-hit)
    // first pass. Each arity must independently trigger and survive the
    // 0.3 retry.
    function makeFallbackVault() {
      const engine = {
        // First call (mode default threshold) finds nothing; the 0.3 retry
        // rescues it.
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValue([{ path: notePath, similarity: 0.34 }]),
        findBlockNeighbors: vi.fn().mockReturnValue([]),
        findDuplicates: vi.fn().mockReturnValue([]),
      };
      return makeLexicalVault(
        { [notePath]: '# Alpha\n\nalpha beta gamma\n' },
        { sources: sourcesWithEmbeddingFor(notePath), engine },
      );
    }

    const stringVault = await makeFallbackVault();
    const arrayVault = await makeFallbackVault();
    try {
      const asString = (await buildSearchNotesTool(stringVault.deps).handler({
        query: 'alpha',
      })) as SearchNotesOutput;
      const asArray = (await buildSearchNotesTool(arrayVault.deps).handler({
        query: ['alpha'],
      })) as SearchNotesOutput;

      // Preconditions: the retry rescued the hit on EACH arity
      // independently — `semantic_fallback` itself is array-only, so this
      // reads its observable consequence instead: the note survives with
      // "semantic" in found_in. If the single-query retry were disabled,
      // the note would drop out of matches[] (or lose "semantic") here
      // while the array form stayed green.
      const stringMatch = asString.matches.find((m) => m.path === notePath);
      const arrayMatch = asArray.matches.find((m) => m.path === notePath);
      expect(stringMatch?.found_in).toContain('semantic');
      expect(arrayMatch?.found_in).toContain('semantic');

      // Nothing else differs: strip the array-only field and compare.
      const strip = (o: SearchNotesOutput) => ({
        truncated: o.truncated,
        matches: o.matches.map(({ matched_queries: _mq, ...rest }) => rest),
      });
      expect(strip(asArray)).toEqual(strip(asString));

      // Array-only: the fallback flag itself.
      expect(asArray.query_stats!['alpha'].semantic_fallback).toBe(true);
    } finally {
      await stringVault.cleanup();
      await arrayVault.cleanup();
    }
  });

  it('the schema advertises both arities and the gate accepts them', async () => {
    const { deps, cleanup } = await makeArityVault();
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const inputSchema = reg.spec.inputSchema as z.ZodTypeAny;
      expect(inputSchema.safeParse({ query: 'alpha' }).success).toBe(true);
      expect(inputSchema.safeParse({ query: ['alpha'] }).success).toBe(true);
      expect(inputSchema.safeParse({ query: ['alpha', 'beta'] }).success).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
