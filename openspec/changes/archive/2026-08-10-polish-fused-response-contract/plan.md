# polish-fused-response-contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `search_notes` fused response honest: `query_stats.semantic` is `null` when the semantic leg never ran, semantic hits never ship `blocks: []` (backfill best block or omit the key), and AND-killed multi-token queries report per-token counts via `lexical_tokens`.

**Architecture:** Three thin layers, bottom-up. The lexical leg (`rank.ts` → `lexical-index.ts`) gains failure-path-only per-token note counts. The semantic leg (`retrieval-policy.ts`) gains a per-seed block backfill step after the shared block pass. The tool layer (`search-notes.ts`) widens the `query_stats` type, threads a "semantic leg ran" signal, omits empty `blocks`, and updates the contract description. Governing artifacts: `specs/hybrid-search/spec.md` (delta) and `design.md` in this change directory.

**Tech Stack:** TypeScript (strict, ESM), vitest, zod. Node ≥ 20.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must all pass before any commit (`npm run typecheck` = `tsc --noEmit`, authoritative over tsup).
- Response contract text lives in `SEARCH_NOTES_DESCRIPTION` inside `src/modules/semantic/tools/search-notes.ts` — it must match the new behavior exactly.
- Tool tests go through the SDK gate where the file's existing idiom does (registered spec + handler, not handler-only) — follow the idioms already in `test/semantic/tools/search-notes-hybrid.test.ts`.
- Commit messages: Conventional Commits, trailer `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- Never push to `main`; finish via `gh pr create`. Release (major, 15.0.0) happens on `main` after merge — not part of this plan.

---

### Task 1: Per-token counts for dead multi-token queries in `rankNotes`

**Files:**
- Modify: `src/lib/obsidian/lexical/rank.ts`
- Test: `test/lib/obsidian/lexical/rank.test.ts`

**Interfaces:**
- Consumes: existing `matchUnit(normUnit, normQuery, tokens)` from `./match.js`, `prepared[]` (`{ original, norm, tokens }`) already built in `rankNotes`.
- Produces: `rankNotes` return gains `perQueryTokenCounts: Record<string, Record<string, number>>` — an entry per query whose `perQueryCounts` is `0` AND which has ≥2 normalized tokens; inner map: normalized token → count of notes where that token alone matches (title or any unit). All other queries have no entry.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('rankNotes', ...)` block in `test/lib/obsidian/lexical/rank.test.ts`:

```ts
  describe('perQueryTokenCounts', () => {
    it('reports per-token note counts for an AND-killed multi-token query', () => {
      const map = notes([
        ['Копірайт-ревізія алертів.md', 'нотатка про алертів і їх ревізію\n'],
        ['Інша нотатка.md', 'нічого дотичного\n'],
      ]);
      const { perQueryCounts, perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['ретеншн алертів'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryCounts['ретеншн алертів']).toBe(0);
      expect(perQueryTokenCounts['ретеншн алертів']).toEqual({
        ретеншн: 0,
        алертів: 1,
      });
    });

    it('has no entry for a single-token dead query', () => {
      const map = notes([['Пошук.md', '']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['нема'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts).toEqual({});
    });

    it('has no entry for a matching multi-token query', () => {
      const map = notes([['phrase.md', '# векторний пошук\n']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['векторний пошук'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts).toEqual({});
    });

    it('counts a note once per token even when the token hits several units', () => {
      const map = notes([['multi.md', '# алертів\n\nще раз алертів у тілі\n']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['ретеншн алертів'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts['ретеншн алертів']).toEqual({ ретеншн: 0, алертів: 1 });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/lexical/rank.test.ts`
Expected: FAIL — `perQueryTokenCounts` is `undefined` (not in the return value).

- [ ] **Step 3: Implement in `rankNotes`**

In `src/lib/obsidian/lexical/rank.ts`, change the return-type annotation of `rankNotes` and add the second pass after `perQueryCounts` is computed (currently lines 118-121):

```ts
): {
  notes: RankedNote[];
  truncated: boolean;
  perQueryCounts: Record<string, number>;
  // Failure-path diagnostic: entries only for queries with zero AND-matches
  // and ≥2 tokens — normalized token → notes where that token alone matches.
  perQueryTokenCounts: Record<string, Record<string, number>>;
} {
```

After the `perQueryCounts` loop:

```ts
  // Per-token counts, only where they explain a zero: a multi-token query
  // that matched nothing gets each token counted individually so the caller
  // sees which token killed the AND.
  const perQueryTokenCounts: Record<string, Record<string, number>> = {};
  for (const q of prepared) {
    if (q.tokens.length < 2 || (perQueryCounts[q.original] ?? 0) !== 0) continue;
    const counts: Record<string, number> = {};
    for (const token of q.tokens) counts[token] = 0;
    for (const parsed of opts.notes.values()) {
      for (const token of q.tokens) {
        const hit =
          matchUnit(parsed.title.norm, token, [token]) !== null ||
          parsed.units.some((u) => matchUnit(u.norm, token, [token]) !== null);
        if (hit) counts[token] = (counts[token] ?? 0) + 1;
      }
    }
    perQueryTokenCounts[q.original] = counts;
  }
```

And include it in the return statement:

```ts
  return { notes: selected, truncated, perQueryCounts, perQueryTokenCounts };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/lexical/rank.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/lexical/rank.ts test/lib/obsidian/lexical/rank.test.ts
git commit -m "feat(lexical): report per-token note counts for AND-killed queries" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Thread `perQueryTokenCounts` through `LexicalIndex.search`

**Files:**
- Modify: `src/lib/obsidian/lexical/lexical-index.ts:38-49` (the `search` return-type annotation)
- Test: `test/lib/obsidian/lexical/lexical-index.test.ts`

**Interfaces:**
- Consumes: Task 1's `rankNotes` return field `perQueryTokenCounts: Record<string, Record<string, number>>`.
- Produces: `LexicalIndex.search` resolves with `{ notes, truncated, perQueryCounts, perQueryTokenCounts, totalNotes }` — the body already spreads `ranked`, so only the annotation blocks the field.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `test/lib/obsidian/lexical/lexical-index.test.ts`, using that file's existing fixture helpers for constructing an index (follow its idiom for `vaultRoot`/`reader`/`stat` setup — copy the arrangement of the nearest existing test):

```ts
  it('passes perQueryTokenCounts through from rankNotes', async () => {
    // Arrange an index over one note whose body contains «алертів» but not
    // «ретеншн», using this file's existing helper pattern.
    const result = await index.search({
      queries: ['ретеншн алертів'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: () => 0,
    });
    expect(result.perQueryTokenCounts['ретеншн алертів']).toEqual({
      ретеншн: 0,
      алертів: 1,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/obsidian/lexical/lexical-index.test.ts`
Expected: FAIL — TypeScript: property `perQueryTokenCounts` does not exist on the annotated return type (or `undefined` at runtime if the annotation is loose).

- [ ] **Step 3: Widen the annotation**

In `src/lib/obsidian/lexical/lexical-index.ts`, the `search` return type becomes:

```ts
  ): Promise<{
    notes: RankedNote[];
    truncated: boolean;
    perQueryCounts: Record<string, number>;
    perQueryTokenCounts: Record<string, Record<string, number>>;
    totalNotes: number;
  }> {
```

No body change — `{ ...ranked, totalNotes: paths.length }` already carries the field.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/lib/obsidian/lexical/lexical-index.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/lexical/lexical-index.ts test/lib/obsidian/lexical/lexical-index.test.ts
git commit -m "feat(lexical): expose perQueryTokenCounts from LexicalIndex.search" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Per-seed block backfill in the retrieval policy

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (both `executeRetrieval` Step 4 and `executeMultiRetrieval` Step 4)
- Test: `test/semantic/retrieval-policy.test.ts`

**Interfaces:**
- Consumes: existing `searchEngine.findBlockNeighbors({ queryVector, sources, threshold, limit })`, `sources: Map<string, SmartSource>`, `blocksByPath: Map<string, BlockMatch[]>`, `seedPaths: string[]`.
- Produces: after each function's block pass, every seed with an empty `blocks` bucket whose note has block embeddings carries exactly its best block. Seeds without block embeddings keep `blocks: []` internally (the tool layer omits the key in Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/retrieval-policy.test.ts` (helpers `makeSource`, `makeSearchResult`, `makeBlockResult`, `makeSources`, `makeEmbeddingProvider`, `makeSearchEngine` already exist at the top of the file):

```ts
describe('per-seed block backfill', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
  ]);

  it('backfills the best block for a seed starved by the shared pass (single query)', async () => {
    const findBlockNeighbors = vi
      .fn()
      // shared pass: everything goes to note-a
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.9)])
      // backfill lookup for note-b, scoped to its own source
      .mockReturnValueOnce([makeBlockResult('note-b.md', 0.42)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.42 }]);
    // backfill call is scoped to note-b's source alone, threshold 0, limit 1
    expect(findBlockNeighbors).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: [sources.get('note-b.md')], threshold: 0, limit: 1 }),
    );
  });

  it('leaves blocks empty when the note has no block embeddings', async () => {
    const blockless = new Map(sources);
    blockless.set('note-b.md', { path: 'note-b.md', embedding: [0.8, 0.2], blocks: [] });
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources: blockless,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
  });

  it('backfills across query vectors keeping the best block (multi query)', async () => {
    const findBlockNeighbors = vi.fn().mockImplementation(({ sources: scoped, limit }) => {
      // backfill calls are the single-source, limit-1 ones
      if (Array.isArray(scoped) && scoped.length === 1 && limit === 1) {
        return [makeBlockResult('note-b.md', 0.3)];
      }
      return [makeBlockResult('note-a.md', 0.9)];
    });
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    const noteB = output.results.find((r) => r.path === 'note-b.md')!;
    expect(noteB.blocks).toEqual([{ heading: '#block', lines: [1, 3], similarity: 0.3 }]);
  });

  it('ignores foreign-path results from a backfill lookup', async () => {
    // Defensive: a (mis)behaving engine returning another note's block for a
    // scoped lookup must not attach evidence to the wrong seed.
    const findBlockNeighbors = vi
      .fn()
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.9)])
      .mockReturnValueOnce([makeBlockResult('note-a.md', 0.5)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi
        .fn()
        .mockReturnValue([makeSearchResult('note-a.md', 0.9), makeSearchResult('note-b.md', 0.8)]),
      findBlockNeighbors,
    });

    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });

    expect(output.results.find((r) => r.path === 'note-b.md')!.blocks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/semantic/retrieval-policy.test.ts`
Expected: the four new tests FAIL (`blocks` empty where backfill is expected / call shapes missing); pre-existing tests still pass.

- [ ] **Step 3: Implement the backfill**

In `src/modules/semantic/retrieval-policy.ts`, `executeRetrieval`, immediately after the block-sorting loop that closes Step 4 (after the `for (const bucket of blocksByPath.values())` loop, still inside `if (seeds.length > 0)`):

```ts
    // Step 4b: per-seed backfill. The shared pass above can starve a seed
    // (quick: global top-N went to other seeds; deep: all its blocks fell
    // below threshold). Every starved seed gets its own best block at
    // threshold 0 — evidence is only ever absent when the note has no block
    // embeddings at all.
    for (const seedPath of seedPaths) {
      if (blocksByPath.get(seedPath)?.length) continue;
      const source = sources.get(seedPath);
      if (!source) continue;
      const best = searchEngine
        .findBlockNeighbors({ queryVector, sources: [source], threshold: 0, limit: 1 })
        .filter((b) => b.path === seedPath);
      if (best.length > 0) {
        const block = best[0];
        blocksByPath.set(seedPath, [
          { heading: block.heading, lines: block.lines, similarity: block.similarity },
        ]);
      }
    }
```

In `executeMultiRetrieval`, same position (after its block-sorting loop, inside `if (seeds.length > 0)`):

```ts
    // Step 4b: per-seed backfill across query vectors — keep the single best
    // block over all queries for each starved seed. Same guarantee as the
    // single-query path: empty only when the note has no block embeddings.
    for (const seedPath of seedPaths) {
      if (blocksByPath.get(seedPath)?.length) continue;
      const source = sources.get(seedPath);
      if (!source) continue;
      let best: BlockMatch | undefined;
      for (const { queryVector } of perQueryOutputs) {
        const [hit] = searchEngine
          .findBlockNeighbors({ queryVector, sources: [source], threshold: 0, limit: 1 })
          .filter((b) => b.path === seedPath);
        if (hit && (!best || hit.similarity > best.similarity)) {
          best = { heading: hit.heading, lines: hit.lines, similarity: hit.similarity };
        }
      }
      if (best) blocksByPath.set(seedPath, [best]);
    }
```

- [ ] **Step 4: Run the full semantic test dir**

Run: `npx vitest run test/semantic/`
Expected: PASS. If a pre-existing test asserts an exact `findBlockNeighbors` call count or exact block sets and now sees extra scoped backfill calls, update that test to account for Step 4b (the backfill is now normative — see the delta spec requirement "Semantic seeds carry backfilled block evidence").

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/retrieval-policy.ts test/semantic/retrieval-policy.test.ts
git commit -m "feat(semantic): backfill best block for seeds starved by the shared block pass" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: search_notes contract — null semantics, lexical_tokens, blocks-key omission, description

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts`
- Test: `test/semantic/tools/search-notes-hybrid.test.ts` (primary), plus any other `test/semantic/tools/*.ts` hit by the sweep in Step 4

**Interfaces:**
- Consumes: Task 2's `lexical.perQueryTokenCounts`; existing `semanticPerQueryHits` from `executeMultiRetrieval`.
- Produces: the public `SearchNotesOutput` contract:

```ts
query_stats?: Record<
  string,
  { semantic: number | null; lexical: number; lexical_tokens?: Record<string, number> }
>;
```

- [ ] **Step 1: Update the failing/behavioral tests first**

In `test/semantic/tools/search-notes-hybrid.test.ts`:

1. The test at ~line 540 `'reports query_stats in lexical mode with semantic always 0'` → rename to `'reports query_stats in lexical mode with semantic null'` and change expectations to `{ semantic: null, lexical: 1 }` / `{ semantic: null, lexical: 0 }`.
2. The test at ~line 560 (no corpus) → same change: `semantic: null`.
3. The test at ~line 576 (empty-filter early return) → `{ semantic: null, lexical: 0 }` for both queries.
4. Tests at ~line 489 and ~line 531 run hybrid with a corpus — the semantic leg executed, so numeric `semantic: 0` stays. Do not change them.
5. Add new tests in the `query_stats` describe:

```ts
    it('names the killer token for an AND-killed multi-token query', async () => {
      // vault fixture: a note containing «алертів» but not «ретеншн»
      // (arrange via this file's existing fixture helper for lexical notes)
      const out = await runSearch({ query: ['ретеншн алертів'], mode: 'lexical' });
      expect(out.query_stats!['ретеншн алертів']).toEqual({
        semantic: null,
        lexical: 0,
        lexical_tokens: { ретеншн: 0, алертів: 1 },
      });
    });

    it('omits lexical_tokens for single-token dead queries and for matching queries', async () => {
      const out = await runSearch({ query: ['нема', 'пошук'], mode: 'lexical' });
      expect(out.query_stats!['нема']).toEqual({ semantic: null, lexical: 0 });
      expect(out.query_stats!['пошук'].lexical_tokens).toBeUndefined();
    });
```

(`runSearch` here stands for this file's existing call idiom through the registered tool — reuse whatever helper the neighboring `query_stats` tests use, e.g. the SDK-gate invocation from `_hybrid-helpers.ts`; do not call the handler directly if the neighbors don't.)

6. Add a blocks-shape test where semantic fixtures exist (same file or `search-notes-e2e.test.ts`, wherever the semantic corpus fixture already lives):

```ts
    it('never returns an empty blocks array', async () => {
      const out = await runSearch({ query: 'пошук', effort: 'quick' });
      for (const m of out.matches) {
        if ('blocks' in m) expect(m.blocks!.length).toBeGreaterThan(0);
      }
    });
```

- [ ] **Step 2: Run to verify the changed/added tests fail**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
Expected: FAIL — `semantic: 0` still emitted on degradation paths; `lexical_tokens` missing.

- [ ] **Step 3: Implement in `search-notes.ts`**

1. Widen the output type (line ~82):

```ts
export type SearchNotesOutput = {
  matches: UnifiedMatch[];
  truncated: boolean;
  query_stats?: Record<
    string,
    { semantic: number | null; lexical: number; lexical_tokens?: Record<string, number> }
  >;
};
```

2. Replace `buildQueryStats` (lines ~149-170), including its stale comment:

```ts
// Pre-cap per-query hit counts for array queries. `semantic` is `null` when
// the semantic leg never executed (lexical mode, no corpus, empty-filter
// early return) — a number always means the leg ran and counted (0 = ran,
// found nothing). `lexical` counts over the leg's candidate set pre
// `noteCap` (0 over an empty filter set). `lexical_tokens` rides along only
// where it explains a zero: a multi-token query with `lexical: 0` maps each
// normalized token to how many notes it matches alone. Counts are taken
// before the cross-query merge and before the final `matches[]` cap.
// `undefined` for a single string query — `query_stats` is array-query-only.
function buildQueryStats(
  isMulti: boolean,
  queries: string[],
  lexicalPerQueryCounts: Record<string, number>,
  lexicalPerQueryTokenCounts: Record<string, Record<string, number>>,
  semanticPerQueryHits: Record<string, number> | undefined,
  semanticRan: boolean,
): SearchNotesOutput['query_stats'] {
  if (!isMulti) return undefined;
  return Object.fromEntries(
    queries.map((q) => {
      const tokenCounts = lexicalPerQueryTokenCounts[q];
      return [
        q,
        {
          semantic: semanticRan ? (semanticPerQueryHits?.[q] ?? 0) : null,
          lexical: lexicalPerQueryCounts[q] ?? 0,
          ...(tokenCounts !== undefined ? { lexical_tokens: tokenCounts } : {}),
        },
      ];
    }),
  );
}
```

3. Update the three call sites:
   - empty-filter early return (~line 303): `buildQueryStats(isMulti, queries, {}, {}, undefined, false)`
   - lexical mode / no corpus (~line 332): `buildQueryStats(isMulti, queries, lexical.perQueryCounts, lexical.perQueryTokenCounts, undefined, false)`
   - hybrid return (~line 413): `buildQueryStats(isMulti, queries, lexical.perQueryCounts, lexical.perQueryTokenCounts, semanticPerQueryHits, true)`

4. In `assembleUnified` (~line 231), never emit an empty `blocks`:

```ts
      ...(sem
        ? {
            similarity: sem.similarity,
            ...(sem.blocks.length > 0 ? { blocks: sem.blocks } : {}),
          }
        : {}),
```

5. Update `SEARCH_NOTES_DESCRIPTION`:
   - RESPONSE SHAPE `matches[]` line — evidence clause becomes: ``plus evidence fields present only for the sources that hit: `similarity` (semantic; `blocks[]` accompanies it whenever the note has block-level evidence — non-empty when present, absent for a note without block embeddings), `lexical[]` (snippet matches, max ~3, `{ matched_in, snippet, lines?, heading? }`), `expansion_similarity` (expansion).``
   - `query_stats` line becomes: ``- `query_stats` — array queries only (omitted for a single string `query`): `{ [query]: { semantic, lexical } }`, PRE-cap hit counts (before cross-query merging and before the `matches[]` cap) per input query. `semantic` is `null` when the semantic leg did not run (mode "lexical", no corpus, empty filter set) — a number always means the leg ran; `{ semantic: 0, lexical: 0 }` marks a dead variant worth rephrasing or dropping. When `lexical` is 0 for a multi-word query, `lexical_tokens` maps each token to the count of notes it matches alone — a zero names the token that killed the AND match; drop or replace that token.``
   - INVARIANTS first bullet becomes: ``- `similarity` appears ONLY when `found_in` contains "semantic"; `blocks[]` only alongside `similarity` and never empty (absent when the note has no block embeddings); `lexical[]` only when `found_in` contains a "lexical:*" value; `expansion_similarity` only when it contains "expansion".``

- [ ] **Step 4: Sweep remaining assertions and run everything**

Run: `grep -rn "semantic: 0\|blocks: \[\]\|blocks\": \[\]" test/ src/` and fix any remaining expectation that (a) asserts `semantic: 0` for a leg that did not run, or (b) asserts an empty `blocks` array in a tool response. Then:

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/tools/search-notes.ts test/semantic/tools/
git commit -m "feat(search)!: honest query_stats (null semantic, lexical_tokens) and no empty blocks" -m "BREAKING CHANGE: query_stats.semantic is null when the semantic leg did not run (was 0); blocks is omitted instead of [] when a semantic hit has no block evidence." -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Docs, full verification, PR

**Files:**
- Modify: `docs/architecture/retrieval-policy.md`, `docs/architecture/lexical-search.md`, `docs/guide/finding-notes.md`

**Interfaces:**
- Consumes: the final behavior from Tasks 1–4 and the delta spec `openspec/changes/polish-fused-response-contract/specs/hybrid-search/spec.md`.
- Produces: docs consistent with the shipped contract; a PR to `main`.

- [ ] **Step 1: Update the three docs**

Read each file first; update only the sections describing the touched fields:
- `docs/architecture/retrieval-policy.md` — document Step 4b (per-seed backfill: starved seed → own best block at threshold 0, limit 1; multi-query keeps the max-similarity block across query vectors; a note with no block embeddings stays block-less).
- `docs/architecture/lexical-search.md` — document `perQueryTokenCounts` (failure-path-only per-token note counts, ≥2 tokens, same normalization and filter set).
- `docs/guide/finding-notes.md` — the model-facing guide: `query_stats.semantic` null semantics, `lexical_tokens` reading («which token killed the AND — drop or replace it»), and the blocks presence rule (never `[]`; absent = no block embeddings).

Do NOT widen into the pre-existing docs drift tracked by the separate vault task «Синхронізувати документацію з fused-контрактом».

- [ ] **Step 2: Full verification**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 3: Commit docs**

```bash
git add docs/architecture/retrieval-policy.md docs/architecture/lexical-search.md docs/guide/finding-notes.md
git commit -m "docs: describe backfilled block evidence, null semantic stats, lexical_tokens" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "feat(search)!: polish fused-response contract (null semantic stats, block backfill, lexical_tokens)" --body "$(cat <<'EOF'
## Summary
- query_stats.semantic is null when the semantic leg never ran (lexical mode / no corpus / empty filter) — 0 now always means "ran, found nothing"
- semantic seeds starved by the shared block pass are backfilled with their own best block; blocks is omitted (never []) when a note has no block embeddings
- AND-killed multi-token queries report lexical_tokens per-token note counts

OpenSpec change: openspec/changes/polish-fused-response-contract (breaking — next release is major 15.0.0, released from main after merge).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Release is NOT part of this plan (major 15.0.0 via `npm run release` on `main` after merge).
