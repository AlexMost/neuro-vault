# search-notes-unified-rank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `search_notes`' three separately-ranked outputs with one RRF-fused `matches[]` (provenance + per-source evidence per entry) and add pre-cap `query_stats` for array queries.

**Architecture:** A pure fusion layer (`src/modules/semantic/rank-fusion.ts`) consumes the ordered outputs of the existing semantic leg, lexical leg, and a flattened expansion list; `runSearchForEntry` in `search-notes.ts` wires it in and assembles the new response shape. Both legs get small output extensions (per-query pre-cap counts, vault note total) — no ranking changes inside either leg. Breaking response change → major release.

**Tech Stack:** TypeScript (strict, ESM), vitest, zod. Verify with `npx tsc --noEmit` (authoritative), `npm test`, `npm run lint`.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must pass before any commit lands in the PR (repo rule).
- Conventional Commits; the change ships as ONE PR to `main` via `gh pr create`; release afterwards is **major** (breaking response shape).
- Lexical entries never carry a numeric score (spec invariant) — fusion consumes ranks only.
- One concept = one parameter name (ADR-0005): new response fields are `found_in`, `lexical`, `expansion_similarity`, `query_stats`, reused `matches`, `truncated`, `similarity`, `blocks`, `matched_queries`, `backlink_count`, `vault`, `path`.
- Artifacts of record: `openspec/changes/search-notes-unified-rank/{design.md,specs/hybrid-search/spec.md}` — scenarios there are the acceptance tests.

---

### Task 1: Lexical leg — per-query pre-cap counts + vault note total

**Files:**
- Modify: `src/lib/obsidian/lexical/rank.ts` (return `perQueryCounts`)
- Modify: `src/lib/obsidian/lexical/lexical-index.ts` (pass through + `totalNotes`)
- Test: `test/lib/obsidian/lexical/rank.test.ts`, `test/lib/obsidian/lexical/lexical-index.test.ts`

**Interfaces:**
- Consumes: existing `rankNotes(opts)` / `LexicalIndex.search(opts)`.
- Produces: `rankNotes` returns `{ notes: RankedNote[]; truncated: boolean; perQueryCounts: Record<string, number> }`; `LexicalIndex.search` returns the same plus `totalNotes: number` (vault-wide scan count, **pre**-`allowed` scoping). Task 4/5 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — in `rank.test.ts` (follow the file's existing fixture helpers for building `ParsedNote` maps):

```ts
it('reports per-query candidate counts before the note cap', () => {
  // three notes matching "пошук", one matching "retrieval", noteCap 1
  const { notes, perQueryCounts } = rankNotes({
    notes: parsedFixture, // 3 notes contain «пошук», 1 contains «retrieval»
    queries: ['пошук', 'retrieval', 'відсутнє'],
    noteCap: 1,
    perNoteCap: 3,
    getBacklinkCount: () => 0,
  });
  expect(notes).toHaveLength(1); // cap applied to the list…
  expect(perQueryCounts).toEqual({ пошук: 3, retrieval: 1, відсутнє: 0 }); // …not to the counts
});
```

In `lexical-index.test.ts`:

```ts
it('exposes totalNotes as the pre-scope vault scan count', async () => {
  // vault fixture with 3 files, allowed narrows to 1
  const result = await index.search({
    queries: ['x'],
    allowed: new Set(['a.md']),
    noteCap: 5,
    perNoteCap: 3,
    getBacklinkCount: () => 0,
  });
  expect(result.totalNotes).toBe(3);
  expect(result.perQueryCounts).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/lib/obsidian/lexical/rank.test.ts test/lib/obsidian/lexical/lexical-index.test.ts` → FAIL (properties undefined).
- [ ] **Step 3: Implement.** In `rank.ts`, after building `byPath` (before the sort/slice), count every query over the full candidate set and add to the return:

```ts
const perQueryCounts: Record<string, number> = {};
for (const q of opts.queries) perQueryCounts[q] = 0;
for (const cand of byPath.values())
  for (const q of cand.matchedQueries) perQueryCounts[q] = (perQueryCounts[q] ?? 0) + 1;
// ...
return { notes: selected, truncated, perQueryCounts };
```

In `lexical-index.ts` `search()`: `const paths = await this.reader.scan();` already exists — extend the return:

```ts
const ranked = rankNotes({ ... });
return { ...ranked, totalNotes: paths.length };
```

- [ ] **Step 4: Run the two test files** → PASS. Run `npx tsc --noEmit` → clean (callers only gain fields).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(lexical): expose per-query pre-cap counts and vault note total"`

---

### Task 2: Semantic leg — per-query pre-merge hit counts

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (`MultiRetrievalOutput`, `executeMultiRetrieval`)
- Test: `test/semantic/retrieval-policy.test.ts`

**Interfaces:**
- Produces: `MultiRetrievalOutput` gains `per_query_hits: Record<string, number>` — per input query, `neighbors.length` after threshold/fallback, **before** cross-query merge and seed cap. `executeRetrieval` (single query) is unchanged.

- [ ] **Step 1: Write the failing test** in `retrieval-policy.test.ts` (reuse the file's existing fake engine/provider setup):

```ts
it('reports per-query hits before the cross-query cap', async () => {
  // engine returns 2 hits for query "a", 0 for query "dead"
  const out = await executeMultiRetrieval({
    queries: ['a', 'dead'],
    mode: 'quick',
    sources,
    embeddingProvider,
    searchEngine, // mock: findNeighbors → 2 results for a's vector, [] for dead's
  });
  expect(out.per_query_hits).toEqual({ a: 2, dead: 0 });
});
```

- [ ] **Step 2: Run** `npx vitest run test/semantic/retrieval-policy.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `executeMultiRetrieval`, Step-1 already produces `perQueryOutputs` with `{ query, neighbors }`; collect after the `Promise.all`:

```ts
const per_query_hits: Record<string, number> = {};
for (const { query, neighbors } of perQueryOutputs) per_query_hits[query] = neighbors.length;
```

and add `per_query_hits` to both the `MultiRetrievalOutput` interface and the final `return { results, truncated, per_query_hits }`.

- [ ] **Step 4: Run the test file** → PASS. `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(semantic): expose per-query pre-merge hit counts from multi retrieval"`

---

### Task 3: Fusion module (`rank-fusion.ts`)

**Files:**
- Create: `src/modules/semantic/rank-fusion.ts`
- Test: `test/semantic/rank-fusion.test.ts` (new)

**Interfaces:**
- Consumes: `NoteResultNode` from `src/modules/semantic/types.ts`.
- Produces (Task 4/5 import these exactly):

```ts
export function adaptiveK(totalNotes: number): number;
export interface ExpansionCandidate { path: string; expansion_similarity: number }
export function flattenExpansion(seeds: NoteResultNode[]): ExpansionCandidate[];
export interface FusedCandidate { path: string; score: number; sourceCount: number }
export function fuseRanks(args: {
  sources: { semantic: string[]; lexical: string[]; expansion: string[] }; // ordered paths per source
  totalNotes: number;
  getBacklinkCount: (path: string) => number;
}): FusedCandidate[];
```

- [ ] **Step 1: Write the failing tests** — `test/semantic/rank-fusion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  adaptiveK,
  flattenExpansion,
  fuseRanks,
} from '../../src/modules/semantic/rank-fusion.js';

describe('adaptiveK', () => {
  it('clamps sqrt(N) into [5, 60]', () => {
    expect(adaptiveK(25)).toBe(5);      // sqrt=5 → floor of range
    expect(adaptiveK(4)).toBe(5);       // below range → 5
    expect(adaptiveK(400)).toBe(20);    // sqrt=20
    expect(adaptiveK(2500)).toBe(50);   // sqrt=50
    expect(adaptiveK(10000)).toBe(60);  // above range → 60
  });
});

describe('flattenExpansion', () => {
  const seed = (path: string, related: Array<[string, number]>) => ({
    path, similarity: 0.9, blocks: [],
    related: related.map(([p, s]) => ({ path: p, expansion_similarity: s })),
  });
  it('dedupes repeated paths keeping max similarity, ordered desc', () => {
    const out = flattenExpansion([seed('a.md', [['x.md', 0.82], ['y.md', 0.7]]), seed('b.md', [['x.md', 0.89]])]);
    expect(out).toEqual([
      { path: 'x.md', expansion_similarity: 0.89 },
      { path: 'y.md', expansion_similarity: 0.7 },
    ]);
  });
  it('excludes semantic seed paths', () => {
    const out = flattenExpansion([seed('a.md', [['b.md', 0.95], ['z.md', 0.5]]), seed('b.md', [])]);
    expect(out.map((e) => e.path)).toEqual(['z.md']);
  });
});

describe('fuseRanks', () => {
  const noBacklinks = () => 0;
  it('lifts a two-source mid-rank note over a single-source top hit', () => {
    // k = adaptiveK(25) = 5. A: semantic rank 1 → 1/6 ≈ 0.167.
    // B: lexical rank 2 + expansion rank 2 → 1/7 + 1/7 ≈ 0.286.
    const out = fuseRanks({
      sources: { semantic: ['A.md'], lexical: ['C.md', 'B.md'], expansion: ['D.md', 'B.md'] },
      totalNotes: 25,
      getBacklinkCount: noBacklinks,
    });
    expect(out[0].path).toBe('B.md');
    expect(out[0].sourceCount).toBe(2);
  });
  it('breaks score ties by source count, then backlinks, then path', () => {
    const out = fuseRanks({
      sources: { semantic: ['a.md'], lexical: ['b.md'], expansion: [] },
      totalNotes: 25,
      getBacklinkCount: (p) => (p === 'b.md' ? 3 : 0),
    });
    // равні score (обидва rank 1 в одному джерелі) → backlinks вирішують
    expect(out.map((e) => e.path)).toEqual(['b.md', 'a.md']);
  });
  it('is deterministic and preserves source order under single-source degradation', () => {
    const args = {
      sources: { semantic: [], lexical: ['t.md', 'h.md', 'b.md'], expansion: [] },
      totalNotes: 1000,
      getBacklinkCount: noBacklinks,
    };
    expect(fuseRanks(args)).toEqual(fuseRanks(args));
    expect(fuseRanks(args).map((e) => e.path)).toEqual(['t.md', 'h.md', 'b.md']);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/semantic/rank-fusion.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/modules/semantic/rank-fusion.ts`:

```ts
import type { NoteResultNode } from './types.js';

// RRF over three tiny (≤10-item) rank lists. k is adaptive to vault size:
// canonical k=60 collapses within-source position at these list lengths.
const K_MIN = 5;
const K_MAX = 60;

export function adaptiveK(totalNotes: number): number {
  return Math.min(K_MAX, Math.max(K_MIN, Math.round(Math.sqrt(totalNotes))));
}

export interface ExpansionCandidate {
  path: string;
  expansion_similarity: number;
}

export function flattenExpansion(seeds: NoteResultNode[]): ExpansionCandidate[] {
  const seedPaths = new Set(seeds.map((s) => s.path));
  const best = new Map<string, number>();
  for (const s of seeds)
    for (const rel of s.related) {
      if (seedPaths.has(rel.path)) continue;
      const prev = best.get(rel.path);
      if (prev === undefined || rel.expansion_similarity > prev)
        best.set(rel.path, rel.expansion_similarity);
    }
  return [...best.entries()]
    .map(([path, expansion_similarity]) => ({ path, expansion_similarity }))
    .sort(
      (a, b) =>
        b.expansion_similarity - a.expansion_similarity || a.path.localeCompare(b.path),
    );
}

export interface FusedCandidate {
  path: string;
  score: number;
  sourceCount: number;
}

export function fuseRanks(args: {
  sources: { semantic: string[]; lexical: string[]; expansion: string[] };
  totalNotes: number;
  getBacklinkCount: (path: string) => number;
}): FusedCandidate[] {
  const k = adaptiveK(args.totalNotes);
  const acc = new Map<string, FusedCandidate>();
  for (const ordered of [args.sources.semantic, args.sources.lexical, args.sources.expansion]) {
    ordered.forEach((path, i) => {
      const cand = acc.get(path) ?? { path, score: 0, sourceCount: 0 };
      cand.score += 1 / (k + i + 1);
      cand.sourceCount += 1;
      acc.set(path, cand);
    });
  }
  return [...acc.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.sourceCount - a.sourceCount ||
      args.getBacklinkCount(b.path) - args.getBacklinkCount(a.path) ||
      a.path.localeCompare(b.path),
  );
}
```

- [ ] **Step 4: Run the test file** → PASS. `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(semantic): add RRF rank-fusion module with adaptive k and expansion flattening"`

---

### Task 4: `search_notes` integration — unified shape, single-query path, degradation

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (output types, `runSearchForEntry` assembly; leave the multi-query specifics for Task 5)
- Test: `test/semantic/tools/search-notes-hybrid.test.ts` (rewrite shape assertions), `test/semantic/tools/search-notes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`totalNotes`, lexical order), Task 3 (`fuseRanks`, `flattenExpansion`).
- Produces — the new tool output (Task 5/6 build on it):

```ts
export interface UnifiedMatch {
  path: string;
  vault: string;
  backlink_count: number;
  found_in: string[]; // ordered: "semantic", "lexical:title", "lexical:heading", "lexical:body", "expansion"
  similarity?: number;        // + blocks — present iff semantic-sourced
  blocks?: BlockMatch[];
  lexical?: LexicalMatch[];   // present iff lexical-sourced (the note's snippet matches, ≤3)
  expansion_similarity?: number; // present iff expansion-sourced
  matched_queries?: string[]; // array queries only (Task 5)
}
export interface SearchNotesOutput {
  matches: UnifiedMatch[];
  truncated: boolean;
  query_stats?: Record<string, { semantic: number; lexical: number }>;
}
```

- [ ] **Step 1: Write the failing tests** (use `makeLexicalVault` from `_hybrid-helpers.ts`; mock engine returns fixed semantic hits):

```ts
it('returns one fused matches list with provenance and dual evidence', async () => {
  // vault: note hit by BOTH legs → single entry, both evidence kinds
  const { deps, cleanup } = await makeLexicalVault(
    { 'Target.md': '# Target\n\nretrieval research\n' },
    { sources: sourcesWithEmbeddingFor('Target.md'), engine: engineReturning([{ path: 'Target.md', similarity: 0.8 }]) },
  );
  const out = (await buildSearchNotesTool(deps).handler({ query: 'target' })) as SearchNotesOutput;
  expect(out.matches).toHaveLength(1);
  const m = out.matches[0];
  expect(m.found_in).toEqual(['semantic', 'lexical:title']);
  expect(m.similarity).toBe(0.8);
  expect(m.lexical?.[0]?.matched_in).toBe('title');
  expect(out).not.toHaveProperty('semantic_matches');
  expect(out).not.toHaveProperty('lexical_matches');
  expect(out.truncated).toBe(false);
  await cleanup();
});

it('degrades to pure lexical order in lexical mode with no semantic fields', async () => {
  const out = (await tool.handler({ query: 'пошук', mode: 'lexical' })) as SearchNotesOutput;
  expect(out.matches.length).toBeGreaterThan(0);
  for (const m of out.matches) {
    expect(m.found_in.every((s) => s.startsWith('lexical:'))).toBe(true);
    expect(m.similarity).toBeUndefined();
    expect(m.expansion_similarity).toBeUndefined();
  }
});

it('caps the merged list via limit and reports truncated', async () => {
  // fixture with 3 lexically-matching notes
  const out = (await tool.handler({ query: 'пошук', mode: 'lexical', limit: 2 })) as SearchNotesOutput;
  expect(out.matches).toHaveLength(2);
  expect(out.truncated).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts` → FAIL.
- [ ] **Step 3: Implement in `search-notes.ts`.** Replace `SearchNotesOutput`/`LexicalNoteResult` exports with the interfaces above (keep `LexicalMatch` import). In `runSearchForEntry`:
  1. Lexical call now yields `{ notes, truncated, perQueryCounts, totalNotes }`.
  2. Merged cap: `const MERGED_CAP = { quick: 5, deep: 12 } as const; const cap = limit ?? MERGED_CAP[effort];` — `limit` no longer steers leg pools; `lexCap` uses only the effort default (drop the `channel === 'lexical' ? limit …` branch).
  3. Early-degradation branch (`channel === 'lexical' || !entry.semanticAvailable || corpus === undefined`) and the hybrid path both funnel into one assembler:

```ts
function assembleUnified(args: {
  semanticNodes: (NoteResultNode | MultiNoteResultNode)[]; // existence-checked
  lexicalNotes: RankedNote[];
  entry: IVaultEntry;
  totalNotes: number;
  cap: number;
  isMulti: boolean;
}): { matches: UnifiedMatch[]; truncated: boolean } {
  const { semanticNodes, lexicalNotes, entry, totalNotes, cap, isMulti } = args;
  const expansion = flattenExpansion(semanticNodes);
  const semanticByPath = new Map(semanticNodes.map((n) => [n.path, n]));
  const lexicalByPath = new Map(lexicalNotes.map((n) => [n.path, n]));
  const expansionByPath = new Map(expansion.map((e) => [e.path, e]));
  const fused = fuseRanks({
    sources: {
      semantic: semanticNodes.map((n) => n.path),
      lexical: lexicalNotes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes,
    getBacklinkCount: (p) => entry.graph.getBacklinkCount(p),
  });
  const kindOrder = ['title', 'heading', 'body'] as const;
  const matches = fused.slice(0, cap).map((c) => {
    const sem = semanticByPath.get(c.path);
    const lex = lexicalByPath.get(c.path);
    const exp = expansionByPath.get(c.path);
    const found_in = [
      ...(sem ? ['semantic'] : []),
      ...(lex
        ? kindOrder
            .filter((k) => lex.matches.some((m) => m.matched_in === k))
            .map((k) => `lexical:${k}`)
        : []),
      ...(exp ? ['expansion'] : []),
    ];
    const matchedQueries = isMulti
      ? [...new Set([...('matched_queries' in (sem ?? {}) ? (sem as MultiNoteResultNode).matched_queries : []), ...(lex?.matchedQueries ?? [])])]
      : undefined;
    return {
      path: c.path,
      vault: entry.name,
      backlink_count: entry.graph.getBacklinkCount(c.path),
      found_in,
      ...(sem ? { similarity: sem.similarity, blocks: sem.blocks } : {}),
      ...(lex ? { lexical: lex.matches } : {}),
      ...(exp ? { expansion_similarity: exp.expansion_similarity } : {}),
      ...(matchedQueries !== undefined ? { matched_queries: matchedQueries } : {}),
    };
  });
  return { matches, truncated: fused.length > cap };
}
```

  4. Existence check moves to cover semantic seeds **and** flattened expansion paths (lexical notes exist by construction — they were read from disk this request): run `buildExistingPathSet` over `[...seeds, ...expansion]` paths, filter both lists before fusion. Drop the old per-node `related` filtering/`enriched` mapping — `related` no longer leaves the tool.
  5. Empty-filter early return becomes `{ matches: [], truncated: false }` (plus `query_stats` per Task 5 when multi).
- [ ] **Step 4: Run** the two touched test files → PASS. Sweep the rest: `npx vitest run test/semantic/tools/` — expect remaining old-shape failures ONLY in files not yet rewritten (`search-notes.test.ts`, `search-notes-filter.test.ts`, `search-notes-e2e.test.ts`); rewrite their assertions now: `grep -rn "semantic_matches\|lexical_matches\|\.related" test/semantic/tools/` and convert each to `matches[]` + `found_in` equivalents (filter test: every `m.path` starts with prefix; e2e: fused list contains expected note with expected provenance).
- [ ] **Step 5: Run full gates** — `npm test && npm run lint && npx tsc --noEmit` → all pass.
- [ ] **Step 6: Commit** — `git commit -am "feat(search)!: fuse semantic, lexical and expansion sources into one RRF-ranked matches list"`

---

### Task 5: Multi-query path — `matched_queries` union + `query_stats`

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (multi branch)
- Test: `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**
- Consumes: Task 2 `per_query_hits`, Task 1 `perQueryCounts`, Task 4 assembler (`isMulti` already unions `matched_queries`).
- Produces: `query_stats: Record<string, { semantic: number; lexical: number }>` on every array-query response (all modes); omitted for string queries.

- [ ] **Step 1: Write the failing tests**:

```ts
it('reports pre-cap per-query stats and surfaces dead variants', async () => {
  // "пошук" matches lexically; "Мобі" matches nothing anywhere
  const out = (await tool.handler({ query: ['пошук', 'Мобі'] })) as SearchNotesOutput;
  expect(out.query_stats).toEqual({
    пошук: { semantic: expect.any(Number), lexical: 2 },
    Мобі: { semantic: 0, lexical: 0 },
  });
});

it('unions matched_queries across legs', async () => {
  // note hit lexically by q1, semantically by q2
  const out = (await tool.handler({ query: ['q1', 'q2'] })) as SearchNotesOutput;
  const m = out.matches.find((x) => x.path === 'Target.md');
  expect(m?.matched_queries?.sort()).toEqual(['q1', 'q2']);
});

it('omits query_stats for a string query', async () => {
  const out = (await tool.handler({ query: 'пошук' })) as SearchNotesOutput;
  expect(out.query_stats).toBeUndefined();
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In the multi branch of `runSearchForEntry` build stats from both legs (lexical-only/no-corpus paths: semantic counts are 0):

```ts
const query_stats = isMulti
  ? Object.fromEntries(
      queries.map((q) => [
        q,
        { semantic: perQueryHits?.[q] ?? 0, lexical: lexical.perQueryCounts[q] ?? 0 },
      ]),
    )
  : undefined;
```

where `perQueryHits` is `output.per_query_hits` on the hybrid path and `undefined` on degradation paths. Attach via `...(query_stats !== undefined ? { query_stats } : {})` on every multi return, including the empty-filter early return.
- [ ] **Step 4: Run the file, then full gates** — `npm test && npm run lint && npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(search): add pre-cap query_stats for array queries"`

---

### Task 6: Tool description rewrite + SDK-gate contract sweep

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (`SEARCH_NOTES_DESCRIPTION`)
- Test: `test/semantic/tools/search-notes.test.ts` (description assertions via `reg.spec`), `test/server-instructions.test.ts` if it snapshots tool descriptions (check: `grep -rn "search_notes" test/server-instructions.test.ts test/server-modules.test.ts`)

**Interfaces:** none new — this locks the advertised contract to the implemented one.

- [ ] **Step 1: Rewrite `SEARCH_NOTES_DESCRIPTION`** — replace the RESPONSE SHAPE / INVARIANTS / EXAMPLES sections with:

```
RESPONSE SHAPE:
- `matches[]` — ONE list fused across three rank sources (semantic, lexical, expansion) via reciprocal-rank fusion; a note found by 2+ sources ranks higher. Each entry: `path`, `vault`, `backlink_count`, `found_in` (provenance: "semantic", "lexical:title" | "lexical:heading" | "lexical:body", "expansion"), plus evidence per source — `similarity` + `blocks[]` (semantic), `lexical[]` snippet matches (lexical, ≤3), `expansion_similarity` (expansion), `matched_queries` (array queries: union across legs).
- `truncated` — always present; true when the merged cap dropped candidates. Default cap: 5 (quick) / 12 (deep); `limit` overrides it in every mode.
- `query_stats` — array queries only: per query `{ semantic, lexical }` PRE-cap hit counts; `{ semantic: 0, lexical: 0 }` marks a dead variant worth rephrasing.

INVARIANTS:
- Evidence fields appear only with their provenance: `similarity`/`blocks` iff "semantic" ∈ found_in; `lexical` iff a "lexical:*" ∈ found_in; `expansion_similarity` iff "expansion" ∈ found_in. Lexical evidence carries no numeric score.
- A note appears at most once in `matches[]`. Empty result is `matches: []`.
- In `mode: "lexical"` (or without a corpus) `matches[]` preserves pure lexical order.
- Expansion-only entries are evidence-light (no blocks/snippet) — follow up with read_notes or get_similar_notes.
```

Update the multi-vault suffix: fan-out wraps `{ matches, truncated, query_stats? }` per vault.
- [ ] **Step 2: Update description/SDK-gate assertions** — per repo testing convention, assert through `reg.spec` (advertisement), not just the handler: description mentions `matches`, `found_in`, `query_stats`; no stale `semantic_matches`/`lexical_matches`/`related[]` wording anywhere: `grep -n "semantic_matches\|lexical_matches\|related\[\]" src/modules/semantic/tools/search-notes.ts` → only historical comments may remain (prefer zero).
- [ ] **Step 3: Run full gates** — `npm test && npm run lint && npx tsc --noEmit` → PASS.
- [ ] **Step 4: Commit** — `git commit -am "docs(search): advertise the unified matches contract in the tool description"`

---

### Task 7: Living docs + spec hygiene + PR

**Files:**
- Create: `docs/architecture/rank-fusion.md`
- Modify: `docs/architecture/retrieval-policy.md`, `docs/architecture/lexical-search.md` (pointer paragraphs: their outputs are now fusion sources; per-query count fields), `docs/architecture/README.md` (index line), `docs/architecture/mcp-parameter-dictionary.md` (record response-field names `found_in`, `lexical`, `expansion_similarity`, `query_stats` if the dictionary covers response fields — follow its existing scope convention)

- [ ] **Step 1: Write `docs/architecture/rank-fusion.md`** — mechanism (three ordered sources → RRF), the adaptive-k formula with the small-list rationale, tie-break chain, expansion flattening rule (max-similarity dedupe, seed exclusion), degradation modes, and what is deliberately NOT here (weights, occurrence counting, ML re-rank — link the vault research note by name only).
- [ ] **Step 2: Update the two leg docs + README index + parameter dictionary** per Files above.
- [ ] **Step 3: Validate artifacts** — `npm run spec -- validate --all` (or `openspec validate --all`) → PASS.
- [ ] **Step 4: Full gates one last time** — `npm test && npm run lint && npx tsc --noEmit && npm run build` → PASS.
- [ ] **Step 5: Commit docs** — `git commit -am "docs(architecture): add rank-fusion living doc and update leg docs"`
- [ ] **Step 6: Open the PR** — branch, push, `gh pr create` to `main`; PR body: breaking response-shape change (major release on merge), link `openspec/changes/search-notes-unified-rank/`. Do NOT merge locally; do NOT release from the branch.
