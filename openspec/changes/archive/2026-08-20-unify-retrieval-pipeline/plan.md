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

## Task 2: Characterization tests for arity invariance

**Written against the CURRENT, unmodified code.** They must pass before the refactor, and keep passing after it — that is what makes them a safety net rather than a description of whatever the new code happens to do.

This ordering is deliberate. Tests written after a refactor can only confirm the result; tests written before it can contradict the premise. If any of these fail on today's code, the MCP contract already differs by arity, the design's central claim is wrong, and the refactor must stop — report it rather than adjusting the test.

**Files:**
- Modify: `test/semantic/tools/search-notes-hybrid.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: `buildSearchNotesTool`, `registerTool`, `makeLexicalVault`, `engineReturning`, `sourcesWithEmbeddingFor`, `SearchNotesOutput`, `z` — all already imported by this file.
- Produces: nothing.

- [ ] **Step 1: Write the arity-invariance tests**

Append to `test/semantic/tools/search-notes-hybrid.test.ts`:

```ts
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
      // Precondition: the comparison is not vacuous.
      expect(asString.matches.length).toBeGreaterThan(0);
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
    // First call (mode default) finds nothing; the 0.3 retry rescues it.
    const engine = {
      findNeighbors: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([{ path: notePath, similarity: 0.34 }]),
      findBlockNeighbors: vi.fn().mockReturnValue([]),
      findDuplicates: vi.fn().mockReturnValue([]),
    };
    const { deps, cleanup } = await makeLexicalVault(
      { [notePath]: '# Alpha\n\nalpha beta gamma\n' },
      { sources: sourcesWithEmbeddingFor(notePath), engine },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      const asArray = (await tool.handler({ query: ['alpha'] })) as SearchNotesOutput;
      // Precondition: the retry actually fired and rescued the hit.
      expect(asArray.query_stats!['alpha'].semantic_fallback).toBe(true);
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

- [ ] **Step 2: Run them against the unmodified code**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts -t "arity invariance"`
Expected: **PASS**, 4 tests, on the current two-pipeline code.

A failure here is a finding, not a bug to fix in the test. Report which assertion failed and stop — it would mean the contract already differs by arity and the refactor's premise is false.

- [ ] **Step 3: Full suite**

Run: `npm test` — all green. `npx tsc --noEmit` and `npm run lint` — clean.

- [ ] **Step 4: Commit**

```bash
git add test/semantic/tools/search-notes-hybrid.test.ts
git commit -m "test(semantic): pin search_notes arity invariance through the SDK gate

Characterization tests: a string query and a one-element array query
differ only in whether matched_queries and query_stats surface. Written
against the current two-pipeline code so they can guard the fold."
```

---

## Task 3: The fold

One atomic change. The tree does not typecheck partway through — widening a shared type, collapsing the policy layer, and collapsing the caller are one edit, not three, so they land in one commit that ends green.

**Files:**
- Modify: `src/modules/semantic/types.ts:37-46`
- Modify: `src/modules/semantic/retrieval-policy.ts`
- Modify: `src/modules/semantic/tools/search-notes.ts`
- Modify: `test/semantic/retrieval-policy.test.ts`
- Delete: `test/semantic/__scratch__/`

**Interfaces:**
- Consumes: the differential harness in `test/semantic/__scratch__/` (Task 1) as a live check during the work; the arity tests from Task 2 as the contract guard.
- Produces:
  - `NoteResultNode { path: string; similarity: number; matched_queries: string[]; blocks: BlockMatch[]; related: RelatedNote[] }` — `MultiNoteResultNode` deleted.
  - `RetrievalInput { queries: string[]; mode: SearchMode; limit?: number; threshold?: number; expansion?: boolean; expansionLimit?: number; expansionFloor?: number; sources: Map<string, SmartSource>; embeddingProvider: EmbeddingProvider; searchEngine: SearchEngine }`
  - `RetrievalOutput { results: NoteResultNode[]; truncated: boolean; per_query_hits: Record<string, number>; per_query_fallback: Record<string, boolean> }`
  - `executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput>` — `executeMultiRetrieval`, `MultiRetrievalInput`, `MultiRetrievalOutput` deleted.

- [ ] **Step 1: Widen the node type**

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

- [ ] **Step 2: Promote the multi pipeline in `retrieval-policy.ts`**

Delete the single-query `executeRetrieval` (currently lines 94-209) along with its `RetrievalInput`/`RetrievalOutput`. Then rename `MultiRetrievalInput` → `RetrievalInput`, `MultiRetrievalOutput` → `RetrievalOutput`, `executeMultiRetrieval` → `executeRetrieval`.

`RetrievalInput` no longer extends anything — the `Omit<RetrievalInput, 'query'>` it used would now be self-referential, so spell it out:

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

Change the assembly step's annotation from `MultiNoteResultNode[]` to `NoteResultNode[]`, and drop `MultiNoteResultNode` from the type import. The scalar `fallback` field is gone: `per_query_fallback` carries the same bit and no caller ever read the scalar.

`computeRelatedPerSeed`, `MODE_DEFAULTS`, `ModeConfig`, the four constants, `MergedSeed`, and `mergeNoteResults` all stay — the surviving pipeline uses them.

- [ ] **Step 3: Keep the differential harness alive across the rename**

`test/semantic/__scratch__/differential.test.ts` imports `executeMultiRetrieval`. Update that import to `executeRetrieval` and re-run it:

Run: `npx vitest run test/semantic/__scratch__/differential.test.ts`
Expected: **8/8 pass.**

The harness compares the scratch copy of the old single-query body against the surviving pipeline. It must stay green through this step — that is the whole point of having built it. If it goes red, the rename was not a pure rename.

- [ ] **Step 4: Collapse the caller — the type guard**

In `src/modules/semantic/tools/search-notes.ts`, delete lines 154-156:

```ts
function isMultiNode(node: NoteResultNode | MultiNoteResultNode): node is MultiNoteResultNode {
  return 'matched_queries' in node;
}
```

Change `assembleUnified`'s `semanticNodes` arg type from `(NoteResultNode | MultiNoteResultNode)[]` to `NoteResultNode[]`, and replace the `matchedQueries` computation (currently :241-248) with:

```ts
    const matchedQueries = isMulti
      ? [...new Set([...(sem?.matched_queries ?? []), ...(lex?.matchedQueries ?? [])])]
      : undefined;
```

**The `isMulti` gate stays.** This single line is what keeps the MCP contract still: every node now carries `matched_queries`, and this is the only place that decides whether it reaches the response. Removing the gate would leak the field into single-query output — a breaking change.

- [ ] **Step 5: Collapse the caller — the call site**

Replace the retrieval call site (currently :400-437, the `try {` opener through the end of the `isMulti` branch) with:

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

Then rewrite the downstream references: `semanticLegTruncated` becomes `semantic.truncated` (:474), and `semanticPerQueryHits` / `semanticPerQueryFallback` become `semantic.per_query_hits` / `semantic.per_query_fallback` (:462-463). Four `let` declarations and one branch disappear. Drop `MultiNoteResultNode` from the file's type imports.

- [ ] **Step 6: Tighten `buildQueryStats`**

The unified pipeline always produces both records when the semantic leg runs. Change the signature (:172-173) from:

```ts
  semanticPerQueryHits: Record<string, number> | undefined,
  semanticPerQueryFallback: Record<string, boolean> | undefined,
```

to:

```ts
  semanticPerQueryHits: Record<string, number>,
  semanticPerQueryFallback: Record<string, boolean>,
```

and simplify the reads inside from `semanticPerQueryHits?.[q] ?? 0` to `semanticPerQueryHits[q] ?? 0`, and from `semanticPerQueryFallback?.[q]` to `semanticPerQueryFallback[q]`.

Keep the `semanticRan` parameter. There are three call sites (`:335`, `:364`, `:457`); the two that pass `semanticRan: false` — the empty-filter early return (`:335`) and the combined lexical-only / no-corpus path (`:364`) — currently pass `undefined, undefined` for the semantic pair. Both must now pass `{}, {}`. The third (`:457`) already passes real records.

- [ ] **Step 7: Update the stale comment**

The comment block at :401-406 names both `executeRetrieval` and `executeMultiRetrieval`. Only one exists now.

- [ ] **Step 8: Typecheck and run the contract guard**

Run: `npx tsc --noEmit`
Expected: **clean.**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
Expected: **all pass**, including Task 2's four arity tests. These were written against the old code; passing now is the evidence that the MCP contract did not move.

If an arity test fails here, the fold changed observable behaviour. Do not amend the test — it is the specification. Fix the source.

- [ ] **Step 9: Reorganize the retrieval-policy suite**

`test/semantic/retrieval-policy.test.ts` still calls the deleted names, so it is red. Replace the two top-level blocks — `describe('executeRetrieval')` (:57) and `describe('executeMultiRetrieval')` (:624) — with invariant-named blocks parameterized over arity:

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

    // Called once per query — assert every call's shape, not just the first.
    expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(queries.length);
    for (const call of vi.mocked(searchEngine.findNeighbors).mock.calls) {
      expect(call[0]).toMatchObject({ threshold: 0.5, limit: 4 });
    }
  });
});
```

Move these invariant groups into the parameterized table, asserted once instead of twice: quick-mode defaults, deep-mode defaults, fallback-to-lower-threshold, explicit-threshold-is-a-hard-filter, per-seed expansion (deep only), expansion floor and block decoupling, per-seed block backfill, shape invariants, final limit, user-supplied limit, and leg-level pool truncation.

- [ ] **Step 10: Keep the genuinely arity-specific assertions separate**

These four have no single-query meaning and stay in their own non-parameterized `describe`: cross-query seed merging (max similarity per path), `matched_queries` as the union across queries, per-query fallback independence (one query rescued, another not), and cross-query block-key dedup (same block reached by two query vectors, max similarity kept).

- [ ] **Step 11: Verify coverage was preserved**

Walk the old file's `describe`/`it` names as a checklist against the new ones. Every invariant the old file asserted must appear exactly once in the new file. Record any deliberate drop with a reason — an invariant that silently vanishes during a "no behaviour change" refactor is the failure mode this step exists to catch. Put the checklist in your report.

- [ ] **Step 12: Delete the scratch harness**

```bash
rm -rf test/semantic/__scratch__
```

Its job is done. Keeping it would mean keeping a copy of the deleted implementation in the repo, which is the thing being removed.

- [ ] **Step 13: Full green**

Run: `npm test` — all green. `npx tsc --noEmit` — clean. `npm run lint` — clean.

- [ ] **Step 14: Commit**

```bash
git add src/modules/semantic/types.ts src/modules/semantic/retrieval-policy.ts src/modules/semantic/tools/search-notes.ts test/semantic/retrieval-policy.test.ts
git commit -m "refactor(semantic): fold executeRetrieval into the multi-query pipeline

One entry point taking queries: string[]; the single query is the
degenerate case. Deletes MultiNoteResultNode, the isMultiNode type
guard, and the caller's four-let dispatch branch. MCP contract
unchanged - matched_queries and query_stats stay array-query-only,
gated in the tool layer."
```

- [ ] **Step 15: Confirm nothing scratch leaked**

Run: `git status --short && git log -1 --stat`
Expected: no `__scratch__` path in the commit or the working tree.

---

## Task 4: Documentation sweep

Sweeps all of `docs/`, not only `docs/architecture/` — an architecture-scoped grep misses the model-facing guide layer.

A recon pass already mapped the scope; it is recorded below so you do not have to rediscover it, but verify each claim rather than trusting it.

**Files:**
- Modify: `docs/architecture/retrieval-policy.md` — the substantial rewrite. Known stale sites: lines 9, 42, 90, 105, 107, 123, 135, 137, 139, 160.
- Modify: `docs/architecture/rank-fusion.md:68` — one paragraph naming both functions and both output types.
- Verify, likely no change: `docs/architecture/lexical-search.md:127` — calls `matched_queries` "multi-query only", which is a surfacing rule and stays true.
- Verify, expect zero changes: `docs/guide/finding-notes.md` — written entirely at the contract level; nothing there describes an internal pipeline split.

**Interfaces:**
- Consumes: the shipped source from Task 3.
- Produces: nothing.

- [ ] **Step 1: Confirm the scope**

```bash
grep -rn "executeMultiRetrieval\|MultiNoteResultNode\|MultiRetrievalOutput\|MultiRetrievalInput" docs/
```

Hits under `docs/superpowers/` are the frozen pre-OpenSpec record — **leave them alone**. Every other hit must be updated.

- [ ] **Step 2: Rewrite `docs/architecture/retrieval-policy.md`**

Remove the two-entry-point framing. The doc must state: one pipeline takes `queries: string[]`; a single query is the degenerate case with no special path; `matched_queries` is always computed and conditionally surfaced by the tool layer; `truncated` covers both the cross-query merge cap and any single query's pool cap, which coincide at n=1.

Note that line 9 currently claims the module "exports a single function, `executeRetrieval(input)`" — that is already false today, since it exports two. Your rewrite makes the sentence true for the first time rather than changing its meaning.

- [ ] **Step 3: Record the load-bearing invariant**

Add to `docs/architecture/retrieval-policy.md` a short note that the single-query case reduces to the multi-query one **because** `findNeighbors` returns results already sorted by `similarity desc, path asc` (`search-engine.ts:89`, comparator at `:22-28`) — the same total order `mergeNoteResults` re-applies, making the re-sort idempotent. Cite `test/semantic/search-engine.test.ts:61` as the test that pins it.

This is not decoration: without that invariant the fold is unsound, and a future change to engine ordering would break this module silently. See the design doc's "The load-bearing invariant" section.

- [ ] **Step 4: Sweep the remaining files**

Fix each non-frozen hit from Step 1. In `docs/guide/finding-notes.md`, check specifically that nothing tells the model that array queries take a different retrieval path — arity is a surfacing difference, and the guide is the layer a model actually reads.

- [ ] **Step 5: Verify every code claim you wrote**

For each factual assertion in the rewritten doc ("every X does Y", "the only caller is Z"), grep the symbol and confirm it against the shipped source. A claim carried over from the design doc is not evidence — the design described intent; the code is what shipped.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs(semantic): describe one retrieval pipeline, not two"
```

---

## Task 5: Acceptance and PR

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

Expected: roughly 150–180 lines removed. A materially smaller delta means the duplication was not collapsed — investigate before opening the PR rather than shipping a rename that claims to be a deduplication.

- [ ] **Step 4: Confirm the contract did not move**

```bash
git diff main -- src/modules/semantic/tools/search-notes.ts | grep -E "^\+.*(SearchNotesOutput|inputSchema|z\.)"
```

Expected: no output. Any hit means an input schema or output type changed, which this change forbids.

- [ ] **Step 5: Confirm no scratch artifacts survived**

```bash
git log --stat main..HEAD | grep -c "__scratch__" || echo "clean"
```

Expected: `clean`. The differential harness must not appear in any commit on the branch.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin HEAD
```

Then `gh pr create --base main` with a body covering: the two-pipeline problem, the arity-invariance guarantee now pinned in `openspec/specs/hybrid-search`, the line-count delta, and an explicit "MCP contract unchanged" note citing the characterization tests from Task 2 as evidence. Never push directly to `main`.

---

## Self-Review

**Spec coverage.** `specs/hybrid-search/spec.md` adds one requirement with four scenarios:

| Scenario | Covered by |
| --- | --- |
| a one-element array matches the equivalent string query | Task 2 Step 1, test 1 |
| arity changes only which fields surface | Task 2 Step 1, test 2 |
| the fallback threshold behaves identically at both arities | Task 2 Step 1, test 3 + Task 3 Step 9 (parameterized fallback group) |
| leg-level pool truncation is reported identically at both arities | Task 3 Step 9 (parameterized truncation group) |

**Type consistency.** `executeRetrieval` / `RetrievalInput` / `RetrievalOutput` are named identically in Tasks 3, 4, 5. `legacyExecuteRetrieval` exists only inside `test/semantic/__scratch__/` and is deleted in Task 3 Step 12.

**Ordering.** The characterization tests (Task 2) land and commit *before* the fold (Task 3), so the contract guard exists in git history independent of the change it guards. The differential harness (Task 1) stays alive through Task 3 Step 3 and dies only at Step 12, after the fold is proven.

**Task sizing.** Tasks 2-5 each end with a green tree and a commit, so each carries its own test cycle and its own review gate. An earlier draft split the fold into four tasks that each left the tree uncompilable; those are merged into Task 3, because a task that cannot be tested cannot be reviewed.
