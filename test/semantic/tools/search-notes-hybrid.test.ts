import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import type { IFanOutResult } from '../../../src/lib/fan-out.js';
import type { SmartSource } from '../../../src/modules/semantic/types.js';
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
      const m = out.matches[0]!;
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
      expect(out.matches[0]!.lexical?.[0]).toMatchObject({
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
      expect(out.matches[0]!.found_in).toEqual(['lexical:title']);
      expect(out.matches[0]!.similarity).toBeUndefined();
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
    deps.registry.list()[0]!.listMatchingPaths = async () => new Set(['Tasks/a пошук.md']);
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
      expect(out.matches[0]!.found_in).toEqual(['lexical:title']);
      const corpus = deps.registry.list()[0]!.corpus!;
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
    registry.list()[1]!.name = 'w';
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
