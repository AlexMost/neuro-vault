# split-leg-thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `search_notes`' `threshold` an honest semantic-leg hard filter (fallback only for defaults, surfaced in `query_stats`), give the expansion leg its own `expansion_floor` contract parameter, and decouple deep block filtering from the user threshold.

**Architecture:** All retrieval changes live in `src/modules/semantic/retrieval-policy.ts` (symmetric `executeRetrieval` / `executeMultiRetrieval` paths); the contract surface (schema, coercion, `query_stats`, description text) lives in `src/modules/semantic/tools/search-notes.ts`. A synthetic-corpus calibration fixture (real cosine engine, engineered similarities) locks default behavior byte-for-byte before any change and then pins the acceptance matrix from the delta spec.

**Tech Stack:** TypeScript (strict, ESM), zod schemas, vitest, MCP SDK tool registration.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must pass before every commit. `npx tsc --noEmit` is authoritative for types — a tsup build is not (isolatedModules).
- Tool-contract tests assert via the SDK gate: `registerTool(tool).spec.inputSchema` (advertisement + pre-validation + tolerant coercion), not only `tool.handler` (repo testing convention).
- MCP parameter names are permanent (ADR-0005). The new parameter name is `expansion_floor` — snake_case on the contract, `expansionFloor` internally (mirrors `expansionLimit`).
- Commit messages: Conventional Commits (commitlint runs in CI). Trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` (or omit) — regardless of executing model.
- Work lands via PR to `main` (`gh pr create`), never a direct push. In a worktree, trust `npx tsc --noEmit` over IDE diagnostics (stale-LSP false positives are common there).
- Do not renumber or rewrite existing tests unless an assertion encodes the old (buggy) behavior — those get updated in the task that changes that behavior, with a comment-free minimal diff.

---

### Task 1: Calibration fixture + default-behavior baseline lock

**Files:**
- Create: `test/semantic/tools/_calibration-fixture.ts`
- Create: `test/semantic/calibration-curve.test.ts`

**Interfaces:**
- Produces: `makeCalibrationFixture(): { sources: Map<string, SmartSource>, searchEngine: SearchEngine, embeddingProvider: EmbeddingProvider }` — 8 "band" notes with query-similarities spread over ~0.775–0.796 (each with one block), plus 4 "neighbour" notes clustered near the band in embedding space (seed↔neighbour similarity ~0.92–0.935, query-similarity ~0.5 so they rank below the 8 seeds and enter results only through expansion). Real engine functions, no mocks.
- Produces: baseline inline snapshots that Tasks 2–5 must keep green for default calls.

- [ ] **Step 1: Write the fixture helper**

```typescript
// test/semantic/tools/_calibration-fixture.ts
import { vi } from 'vitest';

import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import type {
  EmbeddingProvider,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';

// 2-D unit vectors: query = [1, 0]; a note whose query-similarity should be
// `s` sits at angle acos(s). A neighbour at seed-angle + acos(t) has
// seed-similarity t and a query-similarity around cos(acos(s) + acos(t)).
const vec = (angle: number): number[] => [Math.cos(angle), Math.sin(angle)];
const angleFor = (sim: number): number => Math.acos(sim);

// Query-similarities for the 8 semantic "band" notes (mirrors the
// 2026-08-10 report's 0.7749–0.7964 band).
const BAND_SIMS = [0.7964, 0.794, 0.791, 0.788, 0.785, 0.781, 0.778, 0.7749];
// Seed↔neighbour similarities for the 4 expansion candidates.
export const NEIGHBOUR_SIMS = [0.9341, 0.9272, 0.9259, 0.9206];

function bandNote(index: number, querySim: number): SmartSource {
  const a = angleFor(querySim);
  return {
    path: `band-${index}.md`,
    embedding: vec(a),
    blocks: [
      {
        key: `band-${index}.md#b0`,
        heading: '#b0',
        lines: [1, 3] as [number, number],
        // Block query-similarity deliberately BELOW the note's, inside
        // (0.35, band): lets Task 3 prove blocks are not thinned by an
        // explicit note threshold.
        embedding: vec(angleFor(querySim - 0.2)),
      },
    ],
  };
}

function neighbourNote(index: number, seedSim: number): SmartSource {
  // Anchored to the top band note's angle; sits "past" the band so its
  // query-similarity (~0.5) clears the deep default 0.35 but always ranks
  // below all 8 band notes — it can only surface via expansion.
  const a = angleFor(BAND_SIMS[0]!) + angleFor(seedSim);
  return {
    path: `neighbour-${index}.md`,
    embedding: vec(a),
    blocks: [],
  };
}

export function makeCalibrationFixture(): {
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  embeddingProvider: EmbeddingProvider;
} {
  const notes = [
    ...BAND_SIMS.map((s, i) => bandNote(i, s)),
    ...NEIGHBOUR_SIMS.map((s, i) => neighbourNote(i, s)),
  ];
  return {
    sources: new Map(notes.map((n) => [n.path, n])),
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
    embeddingProvider: {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue(vec(0)),
    },
  };
}
```

- [ ] **Step 2: Write the baseline test (defaults, single + multi query, quick + deep)**

```typescript
// test/semantic/calibration-curve.test.ts
import { describe, expect, it } from 'vitest';

import {
  executeMultiRetrieval,
  executeRetrieval,
} from '../../src/modules/semantic/retrieval-policy.js';
import { makeCalibrationFixture } from './tools/_calibration-fixture.js';

describe('calibration fixture baseline (default inputs)', () => {
  it('deep defaults: 8 seeds, expansion populated, truncated', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q',
      mode: 'deep',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(8);
    expect(output.truncated).toBe(true);
    expect(output.results.map((r) => r.path)).toMatchInlineSnapshot();
    expect(
      output.results.map((r) => r.related.map((n) => n.path)),
    ).toMatchInlineSnapshot();
    // Full-precision similarity lock — the byte-for-byte default guarantee.
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot();
  });

  it('quick defaults: 3 seeds, no expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(3);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot();
  });

  it('multi-query deep defaults keep the same shape', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'deep',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(8);
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot();
  });
});
```

- [ ] **Step 3: Run once to fill snapshots, then verify green and sane**

Run: `npx vitest run test/semantic/calibration-curve.test.ts -u` then `npx vitest run test/semantic/calibration-curve.test.ts`
Expected: PASS. Sanity-check the filled snapshots by eye: 8 `band-*.md` seeds ordered by similarity descending; each seed's `related[]` non-empty containing `neighbour-*.md` paths; no neighbour appears as a seed. If neighbours leak into seeds, lower their query-similarity by anchoring `neighbourNote` further out (increase the added angle) — do NOT change band sims.

- [ ] **Step 4: Full suite + commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

```bash
git add test/semantic/tools/_calibration-fixture.ts test/semantic/calibration-curve.test.ts
git commit -m "test(semantic): lock default retrieval behavior on a calibration fixture"
```

---

### Task 2: Fallback only for default thresholds (+ fallback reporting)

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (Step 2 in both paths, output interfaces)
- Test: `test/semantic/retrieval-policy.test.ts`

**Interfaces:**
- Produces: `RetrievalOutput` gains `fallback: boolean`; `MultiRetrievalOutput` gains `per_query_fallback: Record<string, boolean>` (keyed by query string, `true` only when that query's hits came from the 0.3 retry). Task 4 consumes `per_query_fallback`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `test/semantic/retrieval-policy.test.ts` (reuse the file's existing `makeSources` / `makeSearchEngine` / `makeEmbeddingProvider` / `makeSearchResult` helpers):

```typescript
describe('explicit threshold is a hard filter', () => {
  const sources = makeSources([['note-a.md', [1, 0]]]);

  it('does not retry at 0.3 when an explicit threshold filters everything', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.99,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(output.results).toEqual([]);
    expect(findNeighbors).toHaveBeenCalledTimes(1);
    expect(findNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.99 }),
    );
    expect(output.fallback).toBe(false);
  });

  it('retries at 0.3 for the default threshold and reports fallback: true', async () => {
    const findNeighbors = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([makeSearchResult('note-a.md', 0.4)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findNeighbors).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threshold: 0.3 }),
    );
    expect(output.results.map((r) => r.path)).toEqual(['note-a.md']);
    expect(output.fallback).toBe(true);
  });

  it('reports fallback: false when the first pass already had hits', async () => {
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
    });
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(output.fallback).toBe(false);
  });
});

describe('multi-query fallback tracking', () => {
  const sources = makeSources([['note-a.md', [1, 0]], ['note-b.md', [0, 1]]]);

  it('tracks fallback per query', async () => {
    // Keyed by query vector, not call order — Promise.all interleaving must
    // not matter.
    const embeddingProvider = {
      initialize: vi.fn(),
      embed: vi.fn().mockImplementation(async (q: string) =>
        q === 'q1' ? [1, 0] : [0, 1],
      ),
    };
    const findNeighbors = vi
      .fn()
      .mockImplementation(({ queryVector, threshold }) => {
        if (queryVector[0] === 1) return [makeSearchResult('note-a.md', 0.8)];
        return threshold <= 0.3 ? [makeSearchResult('note-b.md', 0.4)] : [];
      });
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.per_query_fallback).toEqual({ q1: false, q2: true });
  });

  it('never falls back for an explicit threshold in the multi path', async () => {
    const findNeighbors = vi.fn().mockReturnValue([]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    const output = await executeMultiRetrieval({
      queries: ['q1', 'q2'],
      mode: 'deep',
      threshold: 0.99,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findNeighbors).toHaveBeenCalledTimes(2); // one pass per query, no retries
    expect(output.per_query_fallback).toEqual({ q1: false, q2: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/semantic/retrieval-policy.test.ts`
Expected: FAIL — "does not retry" sees 2 `findNeighbors` calls (today's unconditional fallback); `fallback` / `per_query_fallback` are `undefined`.

- [ ] **Step 3: Implement in retrieval-policy.ts**

In `RetrievalOutput` (src/modules/semantic/retrieval-policy.ts:40) add:

```typescript
  // True when the semantic hits came from the default-threshold retry at
  // FALLBACK_THRESHOLD. Never true when the caller passed threshold
  // explicitly — an explicit threshold is a hard filter with no rescue.
  fallback: boolean;
```

In `executeRetrieval` replace the threshold resolution and Step 2:

```typescript
  const explicitThreshold = input.threshold !== undefined;
  const threshold = input.threshold ?? modeConfig.threshold;
```

```typescript
  // Step 2: fallback threshold — default thresholds only. An explicit
  // threshold that filters everything returns an honest zero.
  let fallback = false;
  if (vectorResults.length === 0 && !explicitThreshold && threshold > FALLBACK_THRESHOLD) {
    vectorResults = searchEngine.findNeighbors({
      queryVector,
      sources: sources.values(),
      threshold: FALLBACK_THRESHOLD,
      limit: limit + 1,
    });
    fallback = vectorResults.length > 0;
  }
```

and return `{ results, truncated, fallback }`.

In `MultiRetrievalOutput` add `per_query_fallback: Record<string, boolean>;`. In `executeMultiRetrieval`'s Step 1 apply the same `explicitThreshold` guard inside the per-query closure, carry `fallback` out of each `perQueryOutputs` entry, then:

```typescript
  const per_query_fallback: Record<string, boolean> = {};
  for (const { query, fallback } of perQueryOutputs) per_query_fallback[query] = fallback;
```

and include `per_query_fallback` in the return.

- [ ] **Step 4: Run tests to verify they pass; fix collaterals**

Run: `npx vitest run test/semantic/retrieval-policy.test.ts test/semantic/calibration-curve.test.ts`
Expected: new tests PASS; baseline snapshots untouched. If any pre-existing test asserted the old always-fallback behavior for explicit thresholds, update that assertion to the new contract (it encoded the bug).

- [ ] **Step 5: Full suite + commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/modules/semantic/retrieval-policy.ts test/semantic/retrieval-policy.test.ts
git commit -m "fix(semantic): restrict the 0.3 fallback retry to default thresholds"
```

---

### Task 3: `expansionFloor` in retrieval + block decoupling

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (input interface, `computeRelatedPerSeed`, Step 4 + Step 5 in both paths)
- Test: `test/semantic/retrieval-policy.test.ts`, `test/semantic/calibration-curve.test.ts`

**Interfaces:**
- Produces: `RetrievalInput` (and via inheritance `MultiRetrievalInput`) gains `expansionFloor?: number`; module constant `DEFAULT_EXPANSION_FLOOR = 0.35`. `computeRelatedPerSeed`'s arg renames `threshold` → `floor`. Task 4 passes `expansionFloor` through from the tool.
- Consumes: Task 2's shape (do not disturb `fallback` plumbing).

- [ ] **Step 1: Write the failing mock-engine tests**

Add to `test/semantic/retrieval-policy.test.ts`:

```typescript
describe('expansion floor and block decoupling', () => {
  const sources = makeSources([['note-a.md', [1, 0]]]);

  it('floors the per-seed neighbour lookup at expansionFloor, not threshold', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7, // explicit, must NOT reach expansion
      expansionFloor: 0.93,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    const expansionCalls = findNeighbors.mock.calls.slice(1); // call 0 = Step 1 seeds
    expect(expansionCalls.length).toBeGreaterThan(0);
    for (const [args] of expansionCalls) {
      expect(args.threshold).toBe(0.93);
    }
  });

  it('defaults the floor to 0.35 when expansionFloor is absent', async () => {
    const findNeighbors = vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]);
    const searchEngine = makeSearchEngine({ findNeighbors });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    const expansionCalls = findNeighbors.mock.calls.slice(1);
    for (const [args] of expansionCalls) {
      expect(args.threshold).toBe(0.35);
    }
  });

  it('filters deep blocks at the internal default, not the user threshold', async () => {
    const findBlockNeighbors = vi.fn().mockReturnValue([makeBlockResult('note-a.md', 0.75)]);
    const searchEngine = makeSearchEngine({
      findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
      findBlockNeighbors,
    });
    await executeRetrieval({
      query: 'q',
      mode: 'deep',
      threshold: 0.7,
      sources,
      embeddingProvider: makeEmbeddingProvider(),
      searchEngine,
    });
    expect(findBlockNeighbors).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threshold: 0.35 }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/semantic/retrieval-policy.test.ts`
Expected: FAIL — expansion calls receive `0.7` (the user threshold), block call receives `0.7`, `expansionFloor` is not a known input.

- [ ] **Step 3: Implement**

In `src/modules/semantic/retrieval-policy.ts`:

```typescript
// The expansion leg's similarity floor operates on the seed↔note scale
// (empirically 0.89–0.985 in real corpora) — incomparable with the semantic
// leg's query↔note scale, which is why it is a separate knob. 0.35 matches
// what default calls effectively used before the split (behavior-preserving).
const DEFAULT_EXPANSION_FLOOR = 0.35;
```

- `RetrievalInput` gains `expansionFloor?: number;`
- `computeRelatedPerSeed`: rename the `threshold` arg/field to `floor` (pass `threshold: floor` down to `searchEngine.findNeighbors`).
- Both executors: `const expansionFloor = input.expansionFloor ?? DEFAULT_EXPANSION_FLOOR;` and pass `floor: expansionFloor` at the Step 5 call sites (:177 and :375 today) instead of `threshold`.
- Both executors, Step 4 deep branch: `threshold: MODE_DEFAULTS.deep.threshold` instead of `threshold` (:130 and :312 today). Quick branch stays `threshold: 0`.

- [ ] **Step 4: Extend the calibration test with the acceptance curve**

Append to `test/semantic/calibration-curve.test.ts`:

```typescript
describe('split thresholds on the calibration fixture', () => {
  it('expansionFloor 0.93 keeps only the top neighbour; 0.99 empties expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const at93 = await executeRetrieval({
      query: 'q', mode: 'deep', expansionFloor: 0.93,
      sources, embeddingProvider, searchEngine,
    });
    const survivors93 = new Set(
      at93.results.flatMap((r) => r.related.map((n) => n.path)),
    );
    expect(survivors93.size).toBeGreaterThan(0);
    for (const r of at93.results) {
      for (const n of r.related) expect(n.expansion_similarity).toBeGreaterThanOrEqual(0.93);
    }

    const at99 = await executeRetrieval({
      query: 'q', mode: 'deep', expansionFloor: 0.99,
      sources, embeddingProvider, searchEngine,
    });
    expect(at99.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('an explicit threshold no longer shapes expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    // 0.6: below the band (all 8 seeds survive), far above the old
    // accidental expansion coupling's bite point.
    const output = await executeRetrieval({
      query: 'q', mode: 'deep', threshold: 0.6,
      sources, embeddingProvider, searchEngine,
    });
    const defaults = await executeRetrieval({
      query: 'q', mode: 'deep',
      sources, embeddingProvider, searchEngine,
    });
    expect(output.results.map((r) => r.related)).toEqual(
      defaults.results.map((r) => r.related),
    );
  });

  it('explicit threshold 0.99 yields honest zero seeds (deep)', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q', mode: 'deep', threshold: 0.99,
      sources, embeddingProvider, searchEngine,
    });
    expect(output.results).toEqual([]);
    expect(output.fallback).toBe(false);
  });

  it('an in-band explicit threshold filters partially', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q', mode: 'deep', threshold: 0.787,
      sources, embeddingProvider, searchEngine,
    });
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThan(8);
    for (const r of output.results) expect(r.similarity).toBeGreaterThanOrEqual(0.787);
  });

  it('an explicit note threshold does not thin block evidence', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    // Band blocks sit ~0.2 below their note (inside (0.35, band)); with the
    // old coupling a 0.787 note threshold silently dropped them to backfill.
    const output = await executeRetrieval({
      query: 'q', mode: 'deep', threshold: 0.787,
      sources, embeddingProvider, searchEngine,
    });
    for (const r of output.results) {
      expect(r.blocks.length).toBeGreaterThan(0);
      expect(r.blocks[0]!.similarity).toBeGreaterThan(0.35);
    }
  });
});
```

- [ ] **Step 5: Run to verify pass, baseline intact**

Run: `npx vitest run test/semantic/retrieval-policy.test.ts test/semantic/calibration-curve.test.ts`
Expected: PASS, including Task 1's untouched snapshots (the byte-for-byte default guarantee).

- [ ] **Step 6: Full suite + commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/modules/semantic/retrieval-policy.ts test/semantic/retrieval-policy.test.ts test/semantic/calibration-curve.test.ts
git commit -m "feat(semantic): dedicated expansion floor; decouple blocks from user threshold"
```

---

### Task 4: Tool contract — `expansion_floor`, fallback in `query_stats`, description

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (schema, input type, `runSearchForEntry`, `buildQueryStats`, `SearchNotesOutput`, description)
- Test: `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**
- Consumes: `expansionFloor` input and `per_query_fallback` output from Tasks 2–3.
- Produces: contract parameter `expansion_floor` (0–1, optional, tolerant coercion); `query_stats` entries gain optional `semantic_fallback?: true`.

- [ ] **Step 1: Write the failing SDK-gate schema tests**

Add to `test/semantic/tools/search-notes-hybrid.test.ts` (it already imports `buildSearchNotesTool`; add `import { registerTool } from '../../../src/lib/tool-registry.js';`, and build `deps` with the file's existing `makeLexicalVault` helper):

```typescript
describe('expansion_floor input schema (SDK gate)', () => {
  it('advertises and validates expansion_floor', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'a.md': 'x' });
    try {
      const reg = registerTool(buildSearchNotesTool(deps));
      expect(reg.spec.inputSchema.safeParse({ query: 'x', expansion_floor: 0.93 }).success).toBe(true);
      // tolerant-arguments: numeric strings coerce
      expect(reg.spec.inputSchema.safeParse({ query: 'x', expansion_floor: '0.93' }).success).toBe(true);
      expect(reg.spec.inputSchema.safeParse({ query: 'x', expansion_floor: 1.5 }).success).toBe(false);
      expect(reg.spec.inputSchema.safeParse({ query: 'x', expansion_floor: -0.1 }).success).toBe(false);
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
```

- [ ] **Step 2: Write the failing `semantic_fallback` tests**

Same file:

```typescript
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
      expect(output.query_stats['alpha']!.semantic).toBe(0);
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
Expected: FAIL — `expansion_floor` rejected by schema (`unrecognized key` or strip), description lacks the string, `semantic_fallback` absent.

- [ ] **Step 4: Implement the contract**

In `src/modules/semantic/tools/search-notes.ts`:

1. Schema (after `threshold`): `expansion_floor: z.number().min(0).max(1).optional(),`
2. `SearchNotesInput` gains `expansion_floor?: number;`
3. In `runSearchForEntry` next to the `threshold` read:

```typescript
  const expansionFloor =
    input.expansion_floor !== undefined
      ? readThreshold(input.expansion_floor, input.expansion_floor, 'expansion_floor')
      : undefined;
```

4. Pass `expansionFloor` into both `executeMultiRetrieval` and `executeRetrieval` calls; in the multi branch capture `const semanticPerQueryFallback = output.per_query_fallback;` (declare `let semanticPerQueryFallback: Record<string, boolean> | undefined;` beside `semanticPerQueryHits`).
5. `SearchNotesOutput['query_stats']` value type gains `semantic_fallback?: true;`
6. `buildQueryStats` gains a `semanticPerQueryFallback: Record<string, boolean> | undefined` parameter (after `semanticPerQueryHits`) and per entry adds:

```typescript
          ...(semanticRan && semanticPerQueryFallback?.[q] ? { semantic_fallback: true as const } : {}),
```

Update all three `buildQueryStats` call sites (`:321` and `:350` pass `undefined`; the semantic-path call passes `semanticPerQueryFallback`).
7. Description: replace the `threshold` line and add the floor line:

```typescript
    "- threshold: min similarity 0-1, hard filter on the semantic leg's note scores — an explicit value is enforced with no fallback (zero hits are honest). When omitted, effort defaults apply (0.5 quick / 0.35 deep) with a one-shot retry at 0.3 if nothing passes, flagged per query as `semantic_fallback` in `query_stats`.",
    '- expansion_floor: min seed↔note similarity 0-1 for the expansion leg (deep effort only; this note-to-note scale runs much higher than query scores — 0.9+ is typical). Default 0.35. threshold never affects expansion.',
```

Also extend the `query_stats` RESPONSE SHAPE line: after the `semantic` explanation append `` `semantic_fallback: true` marks a query whose semantic hits came from the default-threshold 0.3 retry (absent otherwise, and never present with an explicit `threshold`). ``

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/semantic/tools/`
Expected: PASS, including pre-existing search-notes suites (none encode the old fallback contract at tool level; if one does, update it — it tested the bug).

- [ ] **Step 6: Full suite + commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/modules/semantic/tools/search-notes.ts test/semantic/tools/search-notes-hybrid.test.ts
git commit -m "feat(semantic): expansion_floor parameter and semantic_fallback query_stats flag"
```

---

### Task 5: Docs — parameter dictionary + full docs sweep

**Files:**
- Modify: `docs/architecture/mcp-parameter-dictionary.md`
- Modify: every `docs/` file the sweep surfaces (architecture + model-facing guide layer)

**Interfaces:**
- Consumes: final contract from Task 4 (`expansion_floor`, `semantic_fallback`, threshold semantics).

- [ ] **Step 1: Add `expansion_floor` to the parameter dictionary**

In `docs/architecture/mcp-parameter-dictionary.md`, add a row/entry next to `threshold`: name `expansion_floor`, type `number 0-1, optional`, tools `search_notes`, meaning "similarity floor for the expansion leg on the seed↔note scale; default 0.35; `threshold` never reaches expansion". Update the `threshold` entry to state: semantic-leg note scores only; explicit values are hard filters; defaults 0.5/0.35 with a 0.3 fallback retry surfaced as `semantic_fallback`.

- [ ] **Step 2: Sweep all of docs/ for stale threshold claims**

Run: `grep -rn "threshold" docs/ --include="*.md"` and `grep -rn "SEMANTIC LEG ONLY\|0\.35\|fallback" docs/ --include="*.md"`
For every hit describing `search_notes` threshold behavior (architecture pages AND the model-facing guide layer — the sweep must not stop at `docs/architecture/`), align the text with: three legs/three scales, explicit-threshold hard filtering, default-only fallback with `query_stats` flag, `expansion_floor` ownership of the expansion scale, blocks on the internal 0.35. Do not touch `docs/adr/` (immutable) or `docs/superpowers/` (frozen).

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: split leg thresholds — expansion_floor, honest threshold, fallback flag"
```

---

### Task 6: Final verification

**Files:**
- Modify: none (verification only; `openspec/changes/split-leg-thresholds/tasks.md` checkboxes updated as tasks complete)

- [ ] **Step 1: Full gate**

Run: `npm test && npm run lint && npm run typecheck && npm run build && npx openspec validate --all`
Expected: all green.

- [ ] **Step 2: Behavior-preservation audit**

Run: `npx vitest run test/semantic/calibration-curve.test.ts`
Expected: PASS with Task 1's snapshots **unmodified since Task 1's commit** (verify: `git log --oneline -- test/semantic/calibration-curve.test.ts` shows snapshot content only added, and `git diff <task1-commit> HEAD -- test/semantic/calibration-curve.test.ts` contains no changes inside the Task 1 `describe` block).

- [ ] **Step 3: Update tasks.md checkboxes and hand off**

Mark completed items in `openspec/changes/split-leg-thresholds/tasks.md`. Then follow `superpowers:finishing-a-development-branch` — push the branch and open a PR to `main` via `gh pr create` (never merge locally or push to `main` directly).
