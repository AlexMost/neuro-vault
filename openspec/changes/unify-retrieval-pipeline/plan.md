# Unify Retrieval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two duplicated semantic-retrieval pipelines in `src/modules/semantic/retrieval-policy.ts` into one that takes `queries: string[]`, with the single query as the degenerate case, without changing any observable MCP behaviour.

**Architecture:** `executeMultiRetrieval` is already a strict superset of `executeRetrieval` — every step of the single-query body appears in it, plus a cross-query merge that is provably a no-op at n=1 (its comparator is character-identical to the one `findNeighbors` already applies). So the fold is a deletion, not a new abstraction: rename the multi pipeline to `executeRetrieval`, widen `NoteResultNode` to always carry `matched_queries`, delete `MultiNoteResultNode` and the caller's `isMultiNode` type guard, and let the tool layer keep its existing `isMulti` gate over what actually surfaces in the MCP response.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 20), vitest, zod (tool input schemas), MCP SDK.

## Global Constraints

- `npx tsc --noEmit` is the authority on type-correctness. A `tsup` build alone is NOT sufficient (`isolatedModules`). See ADR-0002.
- `npm test`, `npm run lint`, and `npx tsc --noEmit` must all pass before any commit or PR.
- The MCP contract is frozen for this change: no new, renamed, or repurposed tool parameters; no output field added or removed from `search_notes`; no error-code changes. See ADR-0005.
- `matched_queries` surfaces in `search_notes` output **only for array queries**. `query_stats` is **array-query-only**. Both gates live in the tool layer (`assembleUnified` / `buildQueryStats`, keyed on `isMulti`) and must not move into the policy layer.
- Tool-surface assertions go through the SDK gate — `registerTool(...)` then `reg.spec.inputSchema`, not the bare handler.
- `docs/superpowers/` is a frozen pre-OpenSpec record. Never edit files under it.
- PRs go to `main` via `gh pr create`. Never push directly to `main`.
- Conventional Commits.

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `src/modules/semantic/retrieval-policy.ts` | **Modify.** One exported `executeRetrieval({ queries, … })`. Loses ~150–180 lines. |
| `src/modules/semantic/types.ts` | **Modify.** `NoteResultNode` gains required `matched_queries: string[]`; `MultiNoteResultNode` deleted. |
| `src/modules/semantic/tools/search-notes.ts` | **Modify.** One retrieval call site; `isMultiNode` guard deleted; `isMulti` retained for output gating only. |
| `test/semantic/retrieval-policy.test.ts` | **Modify.** Invariants asserted once, parameterized over arity. |
| `test/semantic/tools/search-notes-hybrid.test.ts` | **Modify.** Adds the arity-invariance SDK-gate assertions. |
| `test/semantic/__scratch__/` | **Create then delete.** Differential harness; never committed. |
| `docs/architecture/retrieval-policy.md` | **Modify.** Describes one pipeline. |

---

## Task 1: Differential safety net

Proves the equivalence premise against real fixtures **before** any production code moves. If this task goes red, the design is wrong and needs revisiting — do not "fix" the test.

**Files:**
- Create: `test/semantic/__scratch__/legacy-retrieval.ts` (deleted in Task 6)
- Create: `test/semantic/__scratch__/differential.test.ts` (deleted in Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces: `legacyExecuteRetrieval(input: LegacyRetrievalInput): Promise<LegacyRetrievalOutput>` — a verbatim copy of today's `executeRetrieval`, used only as a reference implementation inside `__scratch__`.

- [ ] **Step 1: Add the scratch directory to git's ignore list for this branch**

This directory must never reach a commit. Append to `.git/info/exclude` (repo-local, not tracked — so it does not pollute `.gitignore`):

```bash
echo "test/semantic/__scratch__/" >> .git/info/exclude
```

- [ ] **Step 2: Copy the current single-query implementation verbatim**

Create `test/semantic/__scratch__/legacy-retrieval.ts`. Copy lines 1–209 of the **current** `src/modules/semantic/retrieval-policy.ts` (the imports, the four constants, `ModeConfig`, `MODE_DEFAULTS`, `RetrievalInput`, `RetrievalOutput`, `computeRelatedPerSeed`, and `executeRetrieval`) with exactly three edits, and no others — no formatting cleanup, no comment edits. This is a reference implementation; any further edit weakens the proof.

1. Fix the import path to `'../../../src/modules/semantic/types.js'`.
2. Rename the exported function to `legacyExecuteRetrieval`.
3. **Do not import `NoteResultNode`.** Task 2 widens that interface with a required `matched_queries`, which the legacy body never sets — and `tsconfig.json` includes `test`, so an imported `NoteResultNode` would break `tsc --noEmit` here from Task 2 onward. Declare a local structural copy instead, and annotate the legacy body's assembly step and its output with it:

```ts
interface LegacyNoteResultNode {
  path: string;
  similarity: number;
  blocks: BlockMatch[];
  related: RelatedNote[];
}

export interface RetrievalOutput {
  results: LegacyNoteResultNode[];
  truncated: boolean;
  fallback: boolean;
}
```

This keeps the scratch harness insulated from every type change in Tasks 2–3, so it can keep running as the reference implementation right up to its deletion.

- [ ] **Step 3: Write the differential test**

Create `test/semantic/__scratch__/differential.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { legacyExecuteRetrieval } from './legacy-retrieval.js';
import { executeMultiRetrieval } from '../../../src/modules/semantic/retrieval-policy.js';
import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
} from '../../../src/types.js';

function makeSource(path: string, embedding: number[] = [1, 0]): SmartSource {
  return {
    path,
    embedding,
    blocks: [{ key: `${path}#block`, heading: '#block', lines: [1, 3], embedding }],
  };
}

function makeSources(entries: Array<[string, number[]]>): Map<string, SmartSource> {
  return new Map(entries.map(([path, emb]) => [path, makeSource(path, emb)]));
}

function makeEmbeddingProvider(vector: number[] = [1, 0]): EmbeddingProvider {
  return { initialize: vi.fn(), embed: vi.fn().mockResolvedValue(vector) };
}

// A fresh engine per call: both implementations must see identical mock
// state, so they cannot share a spy whose call history one of them mutates.
function makeEngine(
  neighbors: SearchResult[],
  blocks: BlockSearchResult[] = [],
): SearchEngine {
  return {
    findNeighbors: vi.fn().mockReturnValue([...neighbors]),
    findBlockNeighbors: vi.fn().mockReturnValue([...blocks]),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

const sources = makeSources([
  ['note-a.md', [1, 0]],
  ['note-b.md', [0.8, 0.2]],
  ['note-c.md', [0, 1]],
]);

interface Case {
  name: string;
  mode: SearchMode;
  neighbors: SearchResult[];
  blocks?: BlockSearchResult[];
  threshold?: number;
  limit?: number;
  expansionFloor?: number;
}

const cases: Case[] = [
  {
    name: 'quick mode, three hits',
    mode: 'quick',
    neighbors: [
      { path: 'note-a.md', similarity: 0.9 },
      { path: 'note-b.md', similarity: 0.7 },
      { path: 'note-c.md', similarity: 0.6 },
    ],
    blocks: [{ path: 'note-a.md', heading: '#block', lines: [1, 3], similarity: 0.8 }],
  },
  {
    name: 'deep mode with expansion',
    mode: 'deep',
    neighbors: [
      { path: 'note-a.md', similarity: 0.9 },
      { path: 'note-b.md', similarity: 0.7 },
    ],
    blocks: [{ path: 'note-b.md', heading: '#block', lines: [1, 3], similarity: 0.5 }],
    expansionFloor: 0.35,
  },
  { name: 'zero hits triggers fallback path', mode: 'quick', neighbors: [] },
  {
    name: 'explicit threshold is a hard filter',
    mode: 'quick',
    neighbors: [],
    threshold: 0.95,
  },
  {
    // Ties must be fed in ENGINE order, i.e. already sorted by path asc.
    // The real findNeighbors sorts before returning (search-engine.ts:89)
    // using `similarity desc, path asc` — the same total order
    // mergeNoteResults re-applies — and that invariant is pinned by
    // test/semantic/search-engine.test.ts:61. A mock returning ties in any
    // other order describes an engine that cannot exist, and the two
    // implementations would then disagree for a reason production never
    // reaches: legacy preserves engine order, unified normalizes it.
    name: 'tie on similarity, fed in engine order',
    mode: 'quick',
    neighbors: [
      { path: 'note-a.md', similarity: 0.7 },
      { path: 'note-b.md', similarity: 0.7 },
      { path: 'note-c.md', similarity: 0.7 },
    ],
  },
  {
    name: 'leg pool overflow sets truncated',
    mode: 'quick',
    limit: 2,
    neighbors: [
      { path: 'note-a.md', similarity: 0.9 },
      { path: 'note-b.md', similarity: 0.8 },
      { path: 'note-c.md', similarity: 0.7 },
    ],
  },
  {
    name: 'starved seed gets backfilled block evidence',
    mode: 'quick',
    neighbors: [
      { path: 'note-a.md', similarity: 0.9 },
      { path: 'note-b.md', similarity: 0.7 },
    ],
    blocks: [{ path: 'note-a.md', heading: '#block', lines: [1, 3], similarity: 0.8 }],
  },
];

describe('differential: legacy single-query vs multi pipeline at n=1', () => {
  it.each(cases)('$name', async (c) => {
    const query = 'test query';
    const common = {
      mode: c.mode,
      sources,
      ...(c.threshold !== undefined ? { threshold: c.threshold } : {}),
      ...(c.limit !== undefined ? { limit: c.limit } : {}),
      ...(c.expansionFloor !== undefined ? { expansionFloor: c.expansionFloor } : {}),
    };

    const legacy = await legacyExecuteRetrieval({
      ...common,
      query,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine: makeEngine(c.neighbors, c.blocks),
    });

    const unified = await executeMultiRetrieval({
      ...common,
      queries: [query],
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine: makeEngine(c.neighbors, c.blocks),
    });

    // matched_queries is the one field the unified shape adds; strip it
    // before comparing so the assertion is about retrieval, not shape.
    const stripped = unified.results.map(({ matched_queries: _ignored, ...rest }) => rest);

    expect(stripped).toEqual(legacy.results);
    expect(unified.truncated).toBe(legacy.truncated);
    expect(unified.per_query_fallback[query]).toBe(legacy.fallback);
  });
});
```

- [ ] **Step 4: Run the differential test against unmodified source**

Run: `npx vitest run test/semantic/__scratch__/differential.test.ts`
Expected: **PASS**, all 7 cases.

If any case fails, STOP. The equivalence premise in `design.md` §Context is wrong for that case. Record which case and what differed, and revisit the design before continuing — do not adjust the assertion to make it green.

- [ ] **Step 5: Do NOT commit**

Run: `git status --short`
Expected: no `test/semantic/__scratch__/` entries (Step 1's exclude is working). There is nothing to commit in this task — the harness is scaffolding.

---

## Task 2: Collapse the node types

**Files:**
- Modify: `src/modules/semantic/types.ts:37-46`

**Interfaces:**
- Consumes: nothing.
- Produces: `NoteResultNode { path: string; similarity: number; matched_queries: string[]; blocks: BlockMatch[]; related: RelatedNote[] }`. `MultiNoteResultNode` no longer exists.

- [ ] **Step 1: Widen `NoteResultNode` and delete `MultiNoteResultNode`**

In `src/modules/semantic/types.ts`, replace:

```ts
export interface NoteResultNode {
  path: string;
  similarity: number;
  blocks: BlockMatch[];
  related: RelatedNote[];
}

export interface MultiNoteResultNode extends NoteResultNode {
  matched_queries: string[];
}
```

with:

```ts
export interface NoteResultNode {
  path: string;
  similarity: number;
  // Always populated. For a single-query call this is `[query]` — arity is a
  // surfacing concern in the tool layer, not a retrieval one. Whether it
  // reaches the MCP response is decided by `isMulti` in `assembleUnified`.
  matched_queries: string[];
  blocks: BlockMatch[];
  related: RelatedNote[];
}
```

- [ ] **Step 2: Confirm the breakage is exactly where expected**

Run: `npx tsc --noEmit`
Expected: FAIL, with errors confined to `src/modules/semantic/retrieval-policy.ts` and `src/modules/semantic/tools/search-notes.ts`.

`test/semantic/__scratch__/` must NOT appear in the errors — Task 1 Step 2 gave it a local node type precisely so it stays insulated. If it does error, the scratch copy imported `NoteResultNode` after all; fix the scratch copy, not the widened interface.

If any *other* file errors, `MultiNoteResultNode` had a consumer the design did not account for. Stop and note it before proceeding.

- [ ] **Step 3: Do not commit yet**

The tree does not typecheck. Task 3 restores it.

---

## Task 3: Collapse the policy layer

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts`

**Interfaces:**
- Consumes: `NoteResultNode` (Task 2).
- Produces:
  - `RetrievalInput { queries: string[]; mode: SearchMode; limit?: number; threshold?: number; expansion?: boolean; expansionLimit?: number; expansionFloor?: number; sources: Map<string, SmartSource>; embeddingProvider: EmbeddingProvider; searchEngine: SearchEngine }`
  - `RetrievalOutput { results: NoteResultNode[]; truncated: boolean; per_query_hits: Record<string, number>; per_query_fallback: Record<string, boolean> }`
  - `executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput>`
  - `MultiRetrievalInput`, `MultiRetrievalOutput`, `executeMultiRetrieval`, and the old single-query `executeRetrieval` no longer exist.

- [ ] **Step 1: Rename the old single-query function out of the way**

In `src/modules/semantic/retrieval-policy.ts`, rename the existing single-query `executeRetrieval` (line 94) to `legacyExecuteRetrievalInSitu`, and rename its `RetrievalInput`/`RetrievalOutput` to `LegacyRetrievalInput`/`LegacyRetrievalOutput`. Keep them exported for now — Task 5 deletes them. Fix the `results: NoteResultNode[]` annotation on the legacy body's assembly step (line 201) to a local inline type so it stops depending on the widened `NoteResultNode`:

```ts
interface LegacyNoteResultNode {
  path: string;
  similarity: number;
  blocks: BlockMatch[];
  related: RelatedNote[];
}

export interface LegacyRetrievalOutput {
  results: LegacyNoteResultNode[];
  truncated: boolean;
  fallback: boolean;
}
```

- [ ] **Step 2: Promote the multi pipeline to the primary name**

Rename `MultiRetrievalInput` → `RetrievalInput`, `MultiRetrievalOutput` → `RetrievalOutput`, and `executeMultiRetrieval` → `executeRetrieval`. `RetrievalInput` no longer extends anything — spell it out in full, since the `Omit<RetrievalInput, 'query'>` it used is now self-referential:

```ts
export interface RetrievalInput {
  queries: string[];
  mode: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  expansionFloor?: number;
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
}

export interface RetrievalOutput {
  results: NoteResultNode[];
  // True when candidates were dropped either by the cross-query merge cap
  // (`limit`) or by any single query's own per-query pool cap. For one query
  // the merge cap can never bind — `neighbors` was already sliced to `limit`
  // — so this reduces exactly to that query's pool overflow.
  truncated: boolean;
  per_query_hits: Record<string, number>;
  per_query_fallback: Record<string, boolean>;
}
```

Change the assembly step's annotation from `MultiNoteResultNode[]` to `NoteResultNode[]`. The body is otherwise untouched.

- [ ] **Step 3: Point the differential test at the renamed pair**

In `test/semantic/__scratch__/differential.test.ts`, change the import from `executeMultiRetrieval` to `executeRetrieval` and update the two call sites.

- [ ] **Step 4: Run the differential test**

Run: `npx vitest run test/semantic/__scratch__/differential.test.ts`
Expected: **PASS**, all 7 cases. The rename is pure — a failure here means something other than a rename happened.

- [ ] **Step 5: Do not commit yet**

`search-notes.ts` still calls the old names. Task 4 fixes it.

---

## Task 4: Collapse the caller

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` — the `isMultiNode` guard (:154), `buildQueryStats` (:167-193), `assembleUnified`'s `matchedQueries` (:241-248), and the retrieval call site (:400-437)

**Interfaces:**
- Consumes: `executeRetrieval`, `RetrievalOutput` (Task 3); `NoteResultNode` (Task 2).
- Produces: no new exports. `SearchNotesOutput` is unchanged — this is the contract-preservation boundary.

- [ ] **Step 1: Delete the `isMultiNode` type guard**

Remove `search-notes.ts:154-156` entirely:

```ts
function isMultiNode(node: NoteResultNode | MultiNoteResultNode): node is MultiNoteResultNode {
  return 'matched_queries' in node;
}
```

- [ ] **Step 2: Simplify `assembleUnified`**

Change the `semanticNodes` field type in the `assembleUnified` args from `(NoteResultNode | MultiNoteResultNode)[]` to `NoteResultNode[]`, and replace the `matchedQueries` computation (:241-248):

```ts
    const matchedQueries = isMulti
      ? [...new Set([...(sem?.matched_queries ?? []), ...(lex?.matchedQueries ?? [])])]
      : undefined;
```

The `isMulti` gate stays. This is the line that keeps the MCP contract still: every node now carries `matched_queries`, and this is the only place that decides whether it reaches the response.

- [ ] **Step 3: Collapse the retrieval call site**

Replace `search-notes.ts:400-437` (the `try {` opener through the end of the `isMulti` branch) with:

```ts
  try {
    // `limit` is deliberately NOT forwarded here — it bounds only the final
    // fused list (via `cap` below), never either leg's internal pool size.
    // `executeRetrieval` surfaces its own `truncated` (a leg-level pool-cap
    // overflow, independent of `cap`), folded into `legTruncated` below so
    // every leg's pool overflow is surfaced, not just lexical's.
    const semantic = await executeRetrieval({
      queries,
      mode: effort,
      threshold,
      expansionFloor,
      sources: effectiveSources,
      embeddingProvider,
      searchEngine,
    });
    const rawSemanticNodes = semantic.results;
```

Then rewrite the three downstream references: `rawSemanticNodes` is already bound above; `semanticLegTruncated` becomes `semantic.truncated` (:474); `semanticPerQueryHits`/`semanticPerQueryFallback` become `semantic.per_query_hits`/`semantic.per_query_fallback` (:462-463). Four `let` declarations and one branch disappear.

- [ ] **Step 4: Tighten `buildQueryStats`**

The unified pipeline always produces both records when the semantic leg runs, so the two parameters stop being optional-when-present. Change the signature (:172-173) from:

```ts
  semanticPerQueryHits: Record<string, number> | undefined,
  semanticPerQueryFallback: Record<string, boolean> | undefined,
```

to:

```ts
  semanticPerQueryHits: Record<string, number>,
  semanticPerQueryFallback: Record<string, boolean>,
```

and simplify the two reads inside (:183, :186) from `semanticPerQueryHits?.[q] ?? 0` to `semanticPerQueryHits[q] ?? 0`, and from `semanticPerQueryFallback?.[q]` to `semanticPerQueryFallback[q]`.

Keep the `semanticRan` parameter. There are exactly three call sites (`:335`, `:364`, `:457`); the two that pass `semanticRan: false` — the empty-filter early return (`:335`) and the combined lexical-only / no-corpus path (`:364`) — currently pass `undefined, undefined` for the two records. Only `:335` already passes `{}, {}` for the lexical pair, so mirror that: both of these call sites must pass `{}, {}` for the semantic pair too. The third (`:457`) already passes real records and needs no change.

- [ ] **Step 5: Remove the now-stale import**

`MultiNoteResultNode` is no longer referenced in `search-notes.ts`. Drop it from the type import at the top of the file.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: **clean**. The legacy body still exists but is unreferenced outside `__scratch__`.

- [ ] **Step 7: Run the existing suite**

Run: `npm test`
Expected: `test/semantic/retrieval-policy.test.ts` FAILS — it still imports `executeMultiRetrieval` and calls `executeRetrieval` with `query:`. Every other file passes.

If any *other* test file fails, that is a real regression in the caller collapse. Fix it before continuing.

- [ ] **Step 8: Do not commit yet**

The suite is red by construction. Task 5 makes it green.

---

## Task 5: Lock the MCP contract

Pins the arity-invariance requirement from `specs/hybrid-search/spec.md` through the SDK gate, **before** the legacy body is deleted — so the safety net is in the committed suite, not just in scratch.

**Files:**
- Modify: `test/semantic/tools/search-notes-hybrid.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `buildSearchNotesTool`, `registerTool`, `makeLexicalVault`, `engineReturning`, `sourcesWithEmbeddingFor` — all already imported by this file.
- Produces: nothing.

- [ ] **Step 1: Write the arity-invariance tests**

Append to `test/semantic/tools/search-notes-hybrid.test.ts`:

```ts
describe('arity invariance (SDK gate)', () => {
  // Spec: "Semantic retrieval is arity-invariant" — a string query and a
  // one-element array query differ only in which fields surface.
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
    const { deps, cleanup } = await makeArityVault();
    try {
      const tool = buildSearchNotesTool(deps);
      const asString = (await tool.handler({ query: 'alpha' })) as SearchNotesOutput;
      const asArray = (await tool.handler({ query: ['alpha'] })) as SearchNotesOutput;

      expect(asArray.matches.map((m) => m.path)).toEqual(asString.matches.map((m) => m.path));
      expect(asArray.truncated).toBe(asString.truncated);
      expect(asArray.matches.map((m) => m.similarity)).toEqual(
        asString.matches.map((m) => m.similarity),
      );
      expect(asArray.matches.map((m) => m.blocks)).toEqual(asString.matches.map((m) => m.blocks));
      expect(asArray.matches.map((m) => m.expansion_similarity)).toEqual(
        asString.matches.map((m) => m.expansion_similarity),
      );
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
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts -t "arity invariance"`
Expected: **PASS**, 3 tests.

A failure on "arity changes only which fields surface" means `matched_queries` is leaking into single-query output — the `isMulti` gate in Task 4 Step 2 was dropped. Fix the gate, not the test.

- [ ] **Step 3: Commit the caller collapse and its contract tests**

The suite is still red in `retrieval-policy.test.ts` (Task 6 fixes that), so hold the commit until **Task 6 Step 7**, which commits the source collapse and these contract tests together. Nothing to commit in this task.

---

## Task 6: Delete the legacy body and reorganize the suite

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (delete the legacy body)
- Modify: `test/semantic/retrieval-policy.test.ts` (reorganize)
- Delete: `test/semantic/__scratch__/`

**Interfaces:**
- Consumes: `executeRetrieval`, `RetrievalInput`, `RetrievalOutput` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Delete the legacy implementation**

Remove `legacyExecuteRetrievalInSitu`, `LegacyRetrievalInput`, `LegacyRetrievalOutput`, and `LegacyNoteResultNode` from `src/modules/semantic/retrieval-policy.ts`. `computeRelatedPerSeed`, `MODE_DEFAULTS`, `ModeConfig`, the four constants, `MergedSeed`, and `mergeNoteResults` all stay — they are used by the surviving pipeline.

- [ ] **Step 2: Delete the scratch harness**

```bash
rm -rf test/semantic/__scratch__
```

Its job is done: it proved equivalence during the fold, and Task 5's committed tests carry the guarantee forward. Keeping it would mean keeping a copy of the deleted implementation in the repo.

- [ ] **Step 3: Reorganize the retrieval-policy suite**

In `test/semantic/retrieval-policy.test.ts`, replace the two top-level blocks — `describe('executeRetrieval')` (:57) and `describe('executeMultiRetrieval')` (:624) — with invariant-named blocks parameterized over arity. The shape:

```ts
const arities: Array<[label: string, queries: string[]]> = [
  ['single query', ['test query']],
  ['query array', ['test query', 'друга']],
];

describe.each(arities)('mode defaults (%s)', (_label, queries) => {
  it('quick mode calls findNeighbors with threshold 0.5 and limit 4', async () => {
    const searchEngine = makeSearchEngine();
    const embeddingProvider = makeEmbeddingProvider();

    await executeRetrieval({
      queries,
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });

    // Called once per query — assert the shape of every call, not just the first.
    expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const call of vi.mocked(searchEngine.findNeighbors).mock.calls) {
      expect(call[0]).toMatchObject({ threshold: 0.5, limit: 4 });
    }
  });
});
```

Move these invariant groups into the parameterized table, one assertion each instead of two: quick-mode defaults, deep-mode defaults, fallback-to-lower-threshold, explicit-threshold-is-a-hard-filter, per-seed expansion (deep only), expansion floor and block decoupling, per-seed block backfill, shape invariants, final limit, user-supplied limit, and leg-level pool truncation.

- [ ] **Step 4: Keep the genuinely arity-specific assertions separate**

These four have no single-query meaning and stay in their own non-parameterized `describe`:

- cross-query seed merging (`mergeNoteResults` picking max similarity per path)
- `matched_queries` as the union across queries that hit a note
- per-query fallback independence (one query rescued, another not)
- cross-query block-key dedup (same block reached by two query vectors, max similarity kept)

- [ ] **Step 5: Verify coverage was preserved**

Walk the old file's `describe`/`it` names as a checklist against the new ones. Every invariant the old file asserted must appear exactly once in the new file. Record any deliberate drop with a reason — an invariant that silently vanishes during a "no behaviour change" refactor is the failure mode this step exists to catch.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: **all green.**

- [ ] **Step 7: Commit**

```bash
git add src/modules/semantic/types.ts src/modules/semantic/retrieval-policy.ts src/modules/semantic/tools/search-notes.ts test/semantic/retrieval-policy.test.ts test/semantic/tools/search-notes-hybrid.test.ts
git commit -m "refactor(semantic): fold executeRetrieval into the multi-query pipeline

One entry point taking queries: string[]; the single query is the
degenerate case. Deletes MultiNoteResultNode, the isMultiNode type
guard, and the caller's four-let dispatch branch. MCP contract
unchanged — matched_queries and query_stats stay array-query-only,
gated in the tool layer."
```

- [ ] **Step 8: Confirm no scratch files leaked**

Run: `git status --short && git log -1 --stat`
Expected: no `__scratch__` path anywhere in the commit or the working tree.

---

## Task 7: Documentation sweep

Sweeps all of `docs/`, not only `docs/architecture/` — an architecture-scoped grep misses the model-facing guide layer.

**Files:**
- Modify: `docs/architecture/retrieval-policy.md`
- Modify (as the sweep finds): `docs/guide/finding-notes.md`, `docs/architecture/rank-fusion.md`, `docs/architecture/README.md`, `docs/architecture/obsidian-lib.md`

**Interfaces:**
- Consumes: the shipped source from Task 6.
- Produces: nothing.

- [ ] **Step 1: Find every stale reference**

```bash
grep -rn "executeMultiRetrieval\|MultiNoteResultNode\|MultiRetrievalOutput\|MultiRetrievalInput" docs/
```

Hits under `docs/superpowers/` are the frozen pre-OpenSpec record — **leave them alone**. Every other hit must be updated.

- [ ] **Step 2: Rewrite `docs/architecture/retrieval-policy.md`**

Remove the two-entry-point framing. The doc must state: one pipeline takes `queries: string[]`; a single query is the degenerate case with no special path; `matched_queries` is always computed and conditionally surfaced by the tool layer; `truncated` covers both the cross-query merge cap and any single query's pool cap, which coincide at n=1.

- [ ] **Step 3: Sweep the remaining files**

Fix each non-frozen hit from Step 1. In `docs/guide/finding-notes.md`, check specifically that nothing tells the model that array queries take a different retrieval path — arity is a surfacing difference now, and the guide is the layer a model actually reads.

- [ ] **Step 4: Verify every code claim you wrote**

For each factual assertion in the rewritten architecture doc ("every X does Y", "the only caller is Z"), grep the symbol and confirm it. A claim carried over from `design.md` is not evidence — `design.md` described intent, and the code is what shipped.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(semantic): describe one retrieval pipeline, not two"
```

---

## Task 8: Acceptance and PR

- [ ] **Step 1: Full check**

```bash
npm test && npm run lint && npx tsc --noEmit
```

Expected: all three clean. `npx tsc --noEmit` is authoritative — a passing `tsup` build does not substitute for it.

- [ ] **Step 2: Validate the OpenSpec change**

```bash
npx openspec validate --all
```

Expected: clean.

- [ ] **Step 3: Confirm the deletion actually happened**

```bash
git diff --stat main -- src/modules/semantic/retrieval-policy.ts
```

Expected: roughly 150–180 lines removed. A materially smaller delta means the duplication was not actually collapsed — investigate before opening the PR rather than shipping a rename that claims to be a deduplication.

- [ ] **Step 4: Confirm the contract did not move**

```bash
git diff main -- src/modules/semantic/tools/search-notes.ts | grep -E "^\+.*(SearchNotesOutput|inputSchema|z\.)" 
```

Expected: no output. Any hit means an input schema or output type changed, which this change forbids.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
```

Then `gh pr create --base main` with a body covering: the two-pipeline problem, the arity-invariance guarantee now pinned in `openspec/specs/hybrid-search`, the line-count delta, and an explicit "MCP contract unchanged" note with the SDK-gate tests as evidence. Never push directly to `main`.

---

## Self-Review

**Spec coverage.** `specs/hybrid-search/spec.md` adds one requirement with four scenarios:

| Scenario | Covered by |
| --- | --- |
| a one-element array matches the equivalent string query | Task 5 Step 1, test 1 |
| arity changes only which fields surface | Task 5 Step 1, test 2 |
| the fallback threshold behaves identically at both arities | Task 6 Step 3 (parameterized fallback group) |
| leg-level pool truncation is reported identically at both arities | Task 6 Step 3 (parameterized truncation group) |

**Type consistency.** `executeRetrieval` / `RetrievalInput` / `RetrievalOutput` are named identically in Tasks 3, 4, 5, 6. `legacyExecuteRetrieval` (Task 1, in `__scratch__`) and `legacyExecuteRetrievalInSitu` (Task 3, in source) are deliberately distinct names for two distinct copies with different lifetimes — both are deleted in Task 6.

**Ordering.** The legacy body is deleted (Task 6) only after the contract tests are committed-ready (Task 5), so the safety net never has a gap.
