import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import type { IFanOutResult } from '../../../src/lib/fan-out.js';
import type { SmartSource } from '../../../src/modules/semantic/types.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { makeSearchDeps, makeTestRegistry } from './_helpers.js';
import {
  makeLexicalVault,
  sourcesScoring,
  sourcesWithEmbeddingFor,
  vectorScoring,
} from './_hybrid-helpers.js';

describe('unified matches shape', () => {
  it('returns one fused matches list with provenance and dual evidence', async () => {
    // vault: note hit by BOTH legs → single entry, both evidence kinds. Body
    // text deliberately avoids repeating "target" so the note surfaces via
    // exactly one lexical kind (title), keeping found_in assertion precise.
    const { deps, cleanup } = await makeLexicalVault(
      { 'Target.md': 'Notes on building a retrieval evaluation harness.\n' },
      { sources: sourcesScoring([{ path: 'Target.md', similarity: 0.8 }]) },
    );
    try {
      const out = await callTool<SearchNotesOutput>(registerTool(buildSearchNotesTool(deps)), {
        query: 'target',
      });
      expect(out.matches).toHaveLength(1);
      const m = out.matches[0];
      expect(m.found_in).toEqual(['semantic', 'lexical:title']);
      expect(m.similarity).toBeCloseTo(0.8, 6);
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'пошук', mode: 'lexical' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        mode: 'lexical',
        limit: 2,
      });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'пошук', mode: 'lexical' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'пошук', mode: 'lexical' });
      expect(out.matches).toHaveLength(2);
      expect(out.truncated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('surfaces the semantic leg pool overflow even when the lexical leg is empty and the merged cap is not hit', async () => {
    // 4 files that don't lexically match the query at all (0 lexical hits),
    // all 4 above the quick default for the query — quick effort's semantic
    // pool cap is 3, so the leg overflows (4 > 3) even though the merged list
    // (3 semantic-only entries) sits well under the quick merged cap of 5.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`note-${i}.md`] = 'irrelevant body text';
    const sources = sourcesScoring([
      { path: 'note-0.md', similarity: 0.9 },
      { path: 'note-1.md', similarity: 0.8 },
      { path: 'note-2.md', similarity: 0.7 },
      { path: 'note-3.md', similarity: 0.6 },
    ]);
    const { deps, cleanup } = await makeLexicalVault(files, { sources });
    try {
      const out = await callTool<SearchNotesOutput>(registerTool(buildSearchNotesTool(deps)), {
        query: 'zzz-no-lexical-match',
      });
      expect(out.matches).toHaveLength(3);
      expect(out.matches.every((m) => m.found_in.every((s) => s === 'semantic'))).toBe(true);
      expect(out.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('never returns an empty blocks array', async () => {
    // The seed note carries a block the query reaches, so `blocks` is
    // populated (non-empty) whenever it's present at all — proving
    // `assembleUnified` never emits `blocks: []`.
    const notePath = 'пошук note.md';
    const sources = new Map<string, SmartSource>([
      [
        notePath,
        {
          path: notePath,
          embedding: Float32Array.from(vectorScoring(0.9)),
          blocks: [
            {
              key: '#h',
              heading: '#h',
              lines: [1, 3],
              embedding: Float32Array.from(vectorScoring(0.7)),
            },
          ],
        },
      ],
    ]);
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: 'зміст нотатки' }, { sources });
    try {
      const out = await callTool<SearchNotesOutput>(registerTool(buildSearchNotesTool(deps)), {
        query: 'пошук',
        effort: 'quick',
      });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      // apostrophe variant in the query (U+2019) must still match (U+0027 in file)
      const out = await callTool<SearchNotesOutput>(reg, { query: 'об’єкт', mode: 'lexical' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: 'пошук' });
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        filter: { path_prefix: 'Tasks/' },
      });
      expect(out.matches.map((n) => n.path)).toEqual(['Tasks/a пошук.md']);
    } finally {
      await cleanup();
    }
  });

  it('mode: "lexical" never touches the corpus even when a corpus IS available', async () => {
    const notePath = 'Пошук note.md';
    // If the corpus (or the semantic leg) were read despite
    // `mode: "lexical"`, this note would surface a semantic hit — proving the
    // assertion below isn't vacuously true because the corpus is empty.
    const sources = sourcesScoring([{ path: notePath, similarity: 0.9 }]);
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: '' }, { sources });
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        mode: 'lexical',
      });
      expect(out.matches).toHaveLength(1);
      expect(out.matches[0].found_in).toEqual(['lexical:title']);
      const backend = deps.registry.list()[0].backend!;
      expect(backend.nearest).not.toHaveBeenCalled();
      expect(backend.nearestBlocks).not.toHaveBeenCalled();
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
      const quickOut = await callTool<SearchNotesOutput>(
        registerTool(buildSearchNotesTool(quickDeps)),
        {
          query: 'пошук',
          // limit: 12 raises the merged cap well above lexCap 5, so a lexCap
          // regression (e.g. lexCap silently widening) can't hide behind the
          // merged cap also being 5 by coincidence.
          limit: 12,
        },
      ); // effort defaults to "quick" -> lexCap 5 is the binding cap
      const deepOut = await callTool<SearchNotesOutput>(
        registerTool(buildSearchNotesTool(deepDeps)),
        {
          query: 'пошук',
          effort: 'deep',
        },
      ); // lexCap 10, merged cap 12, so all 7 notes fit
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: 'пошук',
        mode: 'lexical',
        limit: 2,
      });
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
      embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn().mockResolvedValue([1, 0]) },
      modelKey: 'k',
    });
    const tool = buildSearchNotesTool(deps);
    return { tool, reg: registerTool(tool), cleanup };
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
    const { reg, cleanup } = await makeTool();
    try {
      const out = await callTool(reg, { query: 'x' });
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
    const { tool, reg, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: ['   '], filter: {} }).success).toBe(true);
      await expect(callTool(reg, { query: ['   '], filter: {} })).rejects.toMatchObject({
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
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: ['vector search', 'векторний пошук'],
      });
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
      const reg = registerTool(buildSearchNotesTool({ ...a.deps, registry }));
      const out = await callTool<IFanOutResult<SearchNotesOutput>>(reg, { query: 'пошук' });
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

  it('carries a per-vault semantic_status in each fan-out entry', async () => {
    // a: ready semantic backend. b: semantic module off for this vault
    // entirely (no backend) — a vault without a backend still reports
    // `disabled` rather than omitting the field.
    const a = await makeLexicalVault({ 'пошук a.md': '' }, { backendStatus: { state: 'ready' } });
    const b = await makeLexicalVault({ 'пошук b.md': '' }, { semantic: false });
    const registry = makeTestRegistry([...a.deps.registry.list(), ...b.deps.registry.list()]);
    registry.list()[1].name = 'w';
    try {
      const reg = registerTool(buildSearchNotesTool({ ...a.deps, registry }));
      const out = await callTool<IFanOutResult<SearchNotesOutput>>(reg, { query: 'пошук' });
      const byVault = Object.fromEntries(
        out.results_by_vault.map((r) => [r.vault, r.semantic_status]),
      );
      expect(byVault.v).toEqual({ state: 'ready' });
      expect(byVault.w).toEqual({
        state: 'disabled',
        note: expect.stringContaining('lexical-only'),
      });
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
    // [0, 1] is orthogonal to the note: under every threshold, fallback too.
    const sources = sourcesWithEmbeddingFor('пошук note.md', [1, 0]);
    const { deps, cleanup } = await makeLexicalVault(
      { 'пошук note.md': 'зміст нотатки' },
      { sources },
    );
    deps.embeddingProvider.embedQuery = vi.fn(async (q: string) =>
      q === 'пошук' ? [1, 0] : [0, 1],
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, { query: ['пошук', 'Мобі'] });
      expect(out.query_stats).toEqual({
        пошук: { semantic: 1, lexical: 1 },
        // A variant that hit nothing in either executed leg says so on the
        // entry itself — the tool description no longer explains this case.
        Мобі: { semantic: 0, lexical: 0, note: expect.stringMatching(/rephrase or drop/i) },
      });
      expect(out.query_stats!['пошук']).not.toHaveProperty('note');
    } finally {
      await cleanup();
    }
  });

  it('unions matched_queries across legs even when each leg is hit by a different query', async () => {
    // note hit lexically by q1 ("пошук"), semantically by q2 ("vector") only.
    const notePath = 'Target пошук.md';
    const sources = sourcesWithEmbeddingFor(notePath, [1, 0]);
    const { deps, cleanup } = await makeLexicalVault({ [notePath]: '' }, { sources });
    deps.embeddingProvider.embedQuery = vi.fn(async (q: string) =>
      q === 'vector' ? [1, 0] : [0, 1],
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: ['пошук', 'vector'],
      });
      const m = out.matches.find((x) => x.path === notePath);
      expect(m?.matched_queries?.sort()).toEqual(['vector', 'пошук']);
    } finally {
      await cleanup();
    }
  });

  it('query_stats accompanies a filter that matches no notes for array queries', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'a.md': '' },
      { listMatchingPaths: async () => new Set() },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const out = await callTool<SearchNotesOutput>(reg, {
        query: ['x', 'y'],
        filter: { path_prefix: 'nomatch/' },
      });
      expect(out.matches).toEqual([]);
      expect(out.query_stats).toEqual({
        x: { semantic: null, lexical: 0 },
        y: { semantic: null, lexical: 0 },
      });
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
      // The knob is advertised on the schema, next to the field being
      // filled — not in the description, which every session pays for.
      expect(JSON.stringify(reg.spec.inputSchema)).toContain('expansion_floor');
      expect(reg.spec.description).not.toContain('expansion_floor');
    } finally {
      await cleanup();
    }
  });

  it('accepts expansion_floor as inert in lexical mode and quick effort', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'alpha text' });
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      await expect(
        callTool(reg, { query: 'alpha', mode: 'lexical', expansion_floor: 0.9 }),
      ).resolves.toMatchObject({ truncated: false });
      await expect(
        callTool(reg, { query: 'alpha', effort: 'quick', expansion_floor: 0.9 }),
      ).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

describe('expansion_floor wiring', () => {
  it('forwards expansion_floor to the expansion leg as the per-seed neighbour floor', async () => {
    // The seed sits 60° from the query (0.5); its neighbour 25° further on is
    // out of the query's reach (≈0.09) but 0.906 from the seed — over a 0.9
    // floor, under 0.91. Only the forwarded floor decides whether it expands.
    const at = (degrees: number) => {
      const r = (degrees * Math.PI) / 180;
      return Float32Array.from([Math.cos(r), Math.sin(r)]);
    };
    const sources = new Map<string, SmartSource>([
      ['a.md', { path: 'a.md', embedding: at(60), blocks: [] }],
      ['n.md', { path: 'n.md', embedding: at(85), blocks: [] }],
    ]);
    const { deps, cleanup } = await makeLexicalVault(
      { 'a.md': 'alpha body', 'n.md': 'other' },
      { sources },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const expanded = (out: SearchNotesOutput) =>
        out.matches.filter((m) => m.found_in.includes('expansion')).map((m) => m.path);
      const below = await callTool<SearchNotesOutput>(reg, {
        query: 'alpha',
        effort: 'deep',
        expansion_floor: 0.9,
      });
      const above = await callTool<SearchNotesOutput>(reg, {
        query: 'alpha',
        effort: 'deep',
        expansion_floor: 0.91,
      });
      expect(expanded(below)).toEqual(['n.md']);
      expect(expanded(above)).toEqual([]);
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
      { sources: sourcesScoring([{ path: notePath, similarity: 0.82 }]) },
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
    // The query embeds as [1, 0] (the default mock). The seed sits 35° off
    // it (0.82), carrying a block the query reaches; the related note sits
    // 45° further on — out of the query's reach under the deep default
    // (≈0.17), but 0.71 from the seed, so it surfaces only via expansion.
    const at = (degrees: number) => {
      const r = (degrees * Math.PI) / 180;
      return Float32Array.from([Math.cos(r), Math.sin(r)]);
    };
    const sources = new Map<string, SmartSource>([
      [
        notePath,
        {
          path: notePath,
          embedding: at(35),
          blocks: [{ key: '#Alpha', heading: '#Alpha', lines: [1, 3], embedding: at(45) }],
        },
      ],
      [relatedPath, { path: relatedPath, embedding: at(80), blocks: [] }],
    ]);
    const { deps, cleanup } = await makeLexicalVault(
      {
        [notePath]: '# Alpha\n\nalpha beta gamma\n',
        // Deliberately no "alpha" token, so this note surfaces ONLY via
        // expansion, never the lexical leg.
        [relatedPath]: '# Unrelated\n\nfiller text only\n',
      },
      { sources },
    );
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      const asString = await callTool<SearchNotesOutput>(reg, {
        query: 'alpha',
        effort: 'deep',
      });
      const asArray = await callTool<SearchNotesOutput>(reg, {
        query: ['alpha'],
        effort: 'deep',
      });

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
      const reg = registerTool(buildSearchNotesTool(deps));
      const asString = await callTool<SearchNotesOutput>(reg, { query: 'alpha' });
      const asArray = await callTool<SearchNotesOutput>(reg, { query: ['alpha'] });

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
    // A fresh vault PER ARITY, so neither call can lean on the other's state.
    // At 0.34 the note is under the quick default and over the 0.3 fallback:
    // the first pass finds nothing and the retry rescues it, on each arity
    // independently.
    function makeFallbackVault() {
      return makeLexicalVault(
        { [notePath]: '# Alpha\n\nalpha beta gamma\n' },
        { sources: sourcesScoring([{ path: notePath, similarity: 0.34 }]) },
      );
    }

    const stringVault = await makeFallbackVault();
    const arrayVault = await makeFallbackVault();
    try {
      const asString = await callTool<SearchNotesOutput>(
        registerTool(buildSearchNotesTool(stringVault.deps)),
        {
          query: 'alpha',
        },
      );
      const asArray = await callTool<SearchNotesOutput>(
        registerTool(buildSearchNotesTool(arrayVault.deps)),
        {
          query: ['alpha'],
        },
      );

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
