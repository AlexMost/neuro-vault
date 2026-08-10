# Weighted RRF Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Down-weight the expansion leg in `search_notes` RRF fusion (w=0.85) and drop `backlink_count` from the tie-break so expansion hubs can no longer outrank direct hits.

**Architecture:** All ranking changes live in the pure function `fuseRanks` (`src/modules/semantic/rank-fusion.ts`); its one production call site is `assembleUnified` in `src/modules/semantic/tools/search-notes.ts`. No MCP schema, parameter, or response-shape change — this is fusion-order behavior only, verified by pure unit tests on synthetic rank lists.

**Tech Stack:** TypeScript (strict, ESM), vitest, Node ≥ 20.

## Global Constraints

- `npm test && npm run lint && npm run typecheck` must pass before any commit (typecheck is authoritative — a tsup build is not; in worktrees trust `npx tsc --noEmit` over stale IDE diagnostics).
- Conventional Commits (commitlint enforced in CI). No Co-Authored-By trailer.
- Deliver via `gh pr create` to `main` — never local-merge or push `main` directly.
- Spec contract for this change: `openspec/changes/weighted-rrf-expansion/specs/hybrid-search/spec.md`; design rationale: `design.md` (D1–D4) in the same directory.

---

### Task 1: Expansion weight in `fuseRanks`

**Files:**
- Modify: `src/modules/semantic/rank-fusion.ts:40-62`
- Test: `test/semantic/rank-fusion.test.ts`

**Interfaces:**
- Consumes: existing `fuseRanks(args: { sources: { semantic: string[]; lexical: string[]; expansion: string[] }; totalNotes: number; getBacklinkCount: (path: string) => number })`.
- Produces: `fuseRanks` gains optional `expansionWeight?: number`; exports `const EXPANSION_WEIGHT = 0.85`. `getBacklinkCount` still present after this task (removed in Task 2). `FusedCandidate` unchanged.

- [ ] **Step 1: Write the failing retention-case test**

Append to the `fuseRanks` describe block in `test/semantic/rank-fusion.test.ts`:

```ts
it('keeps equal-rank expansion candidates below primary hits (retention case, 2026-08-10)', () => {
  // Empty lexical leg: under equal weights semantic[i] and expansion[i] tie
  // exactly at every rank and the backlink step decided — expansion hubs
  // (high backlink_count by construction) won every position. With
  // w_expansion < 1 the expansion contribution is strictly smaller at every
  // rank, so no primary hit can lose its slot to its rank-peer hub.
  const out = fuseRanks({
    sources: {
      semantic: ['s1.md', 's2.md', 's3.md'],
      lexical: [],
      expansion: ['hub1.md', 'hub2.md', 'hub3.md'],
    },
    totalNotes: 25,
    getBacklinkCount: (p) => (p.startsWith('hub') ? 50 : 0),
  });
  const order = out.map((c) => c.path);
  for (const [primary, hub] of [
    ['s1.md', 'hub1.md'],
    ['s2.md', 'hub2.md'],
    ['s3.md', 'hub3.md'],
  ] as const) {
    expect(order.indexOf(primary)).toBeLessThan(order.indexOf(hub));
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/rank-fusion.test.ts -t "retention case"`
Expected: FAIL — under equal weights each pair ties on score and the hubs' 50 backlinks put `hub_i` before `s_i`.

- [ ] **Step 3: Fix the exact-tie sourceCount test (it pins equal weights)**

The existing test `breaks an exact score tie by sourceCount before backlinks` builds its tie from `lexical rank 7 + expansion rank 7 = 1/12 + 1/12`; a weighted expansion leg breaks that equality. Rebuild the tie from the two weight-1 legs so the test keeps exercising the sourceCount branch. Replace that test's `sources` block with:

```ts
      sources: {
        semantic: ['X.md', 'l2.md', 'l3.md', 'l4.md', 'l5.md', 'l6.md', 'Y.md'],
        lexical: ['l1.md', 'x2.md', 'x3.md', 'x4.md', 'x5.md', 'x6.md', 'Y.md'],
        expansion: [],
      },
```

and update its arithmetic comment: X: semantic rank 1 → 1/6, sourceCount 1; Y: semantic rank 7 + lexical rank 7 → 1/12 + 1/12 = 1/6 (floating-point-exact), sourceCount 2. Assertions (`y.score === x.score`, Y first) stay as they are.

- [ ] **Step 4: Implement the weight**

In `src/modules/semantic/rank-fusion.ts`, replace the `fuseRanks` implementation (keep the comparator and `getBacklinkCount` untouched for now):

```ts
// Expansion answers someone else's hit, not the query — a second-order
// signal. Its RRF contribution is down-weighted so it can reinforce and
// fill thin lists but never outrank an equal-rank primary hit. Hand-picked
// start; re-tuned via the retrieval eval harness (see change
// weighted-rrf-expansion, design D1).
export const EXPANSION_WEIGHT = 0.85;

export function fuseRanks(args: {
  sources: { semantic: string[]; lexical: string[]; expansion: string[] };
  totalNotes: number;
  expansionWeight?: number;
  getBacklinkCount: (path: string) => number;
}): FusedCandidate[] {
  const k = adaptiveK(args.totalNotes);
  const w = args.expansionWeight ?? EXPANSION_WEIGHT;
  const acc = new Map<string, FusedCandidate>();
  const legs: [string[], number][] = [
    [args.sources.semantic, 1],
    [args.sources.lexical, 1],
    [args.sources.expansion, w],
  ];
  for (const [ordered, weight] of legs) {
    ordered.forEach((path, i) => {
      const cand = acc.get(path) ?? { path, score: 0, sourceCount: 0 };
      cand.score += weight / (k + i + 1);
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

- [ ] **Step 5: Run the file's tests, then the full gate**

Run: `npx vitest run test/semantic/rank-fusion.test.ts`
Expected: PASS (retention case now passes; adapted exact-tie test passes; the old `breaks score ties by source count, then backlinks, then path` test still passes because both its candidates sit in weight-1 legs).
Then run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/semantic/rank-fusion.ts test/semantic/rank-fusion.test.ts
git commit -m "feat(semantic): down-weight expansion leg in RRF fusion (w=0.85)"
```

---

### Task 2: Tie-break drops `backlink_count`; `fuseRanks` drops `getBacklinkCount`

**Files:**
- Modify: `src/modules/semantic/rank-fusion.ts` (comparator + signature)
- Modify: `src/modules/semantic/tools/search-notes.ts:196-204` (`assembleUnified` call site)
- Test: `test/semantic/rank-fusion.test.ts`

**Interfaces:**
- Consumes: Task 1's `fuseRanks` with `expansionWeight?` and `EXPANSION_WEIGHT`.
- Produces: final signature `fuseRanks(args: { sources: {...}; totalNotes: number; expansionWeight?: number })` — no `getBacklinkCount`. Comparator: `score desc → sourceCount desc → path asc`. Later tasks and production code rely on exactly this signature.

- [ ] **Step 1: Rewrite the backlink tie-break test to assert path order (failing)**

Replace the test `breaks score ties by source count, then backlinks, then path` in `test/semantic/rank-fusion.test.ts` with:

```ts
it('breaks residual exact ties by path, never by backlinks', () => {
  // a.md and b.md tie exactly (both rank 1 in a weight-1 leg, sourceCount 1).
  // b.md has more backlinks; under the old comparator it won. Backlinks are
  // hub bias (see AGENTS.md anti-pattern) and no longer participate: path
  // ascending is the final, deterministic step.
  const out = fuseRanks({
    sources: { semantic: ['a.md'], lexical: ['b.md'], expansion: [] },
    totalNotes: 25,
    getBacklinkCount: (p) => (p === 'b.md' ? 3 : 0),
  });
  expect(out.map((e) => e.path)).toEqual(['a.md', 'b.md']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/rank-fusion.test.ts -t "residual exact ties"`
Expected: FAIL — current comparator puts `b.md` first via its 3 backlinks.

- [ ] **Step 3: Remove the backlink step and the parameter**

In `src/modules/semantic/rank-fusion.ts`: delete `getBacklinkCount` from the `fuseRanks` args type and replace the comparator with:

```ts
  return [...acc.values()].sort(
    (a, b) => b.score - a.score || b.sourceCount - a.sourceCount || a.path.localeCompare(b.path),
  );
```

In `test/semantic/rank-fusion.test.ts`: remove every `getBacklinkCount` property from `fuseRanks` calls and delete the now-unused `noBacklinks` helper. In the Step-1 test above, drop its `getBacklinkCount` line too (the comment keeps the intent). In the exact-tie test, keep the assertion that Y (sourceCount 2) beats X — that branch is unchanged.

In `src/modules/semantic/tools/search-notes.ts` (`assembleUnified`, lines 196–204): remove the `getBacklinkCount: (p) => entry.graph.getBacklinkCount(p),` line from the `fuseRanks` call. Do NOT touch the `backlink_count: entry.graph.getBacklinkCount(c.path)` response field below it — payload enrichment is independent of ranking.

- [ ] **Step 4: Run the full gate**

Run: `npx vitest run test/semantic/rank-fusion.test.ts` → PASS.
Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS (search-notes hybrid/e2e tests exercise the call site; typecheck proves no caller still passes the removed parameter).

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/rank-fusion.ts src/modules/semantic/tools/search-notes.ts test/semantic/rank-fusion.test.ts
git commit -m "feat(semantic): drop backlink_count from RRF tie-break"
```

---

### Task 3: Report-case fixtures — Moby case and RRF-health guard

**Files:**
- Test: `test/semantic/rank-fusion.test.ts`

**Interfaces:**
- Consumes: Task 2's final `fuseRanks(args: { sources; totalNotes; expansionWeight? })`.
- Produces: nothing new — regression coverage only.

- [ ] **Step 1: Add the Moby-case fixture (should pass immediately — regression pin)**

```ts
it('a direct semantic hit outranks an expansion-only hub (Moby case, 2026-08-10)', () => {
  // Live report: the expansion-only "Дата-гігієна фіду" (hub, 72 backlinks)
  // outranked the direct semantic hit whose literal name was in the query.
  // Large-k regime (k = adaptiveK(2500) = 50): 1/51 vs 0.85/51.
  const out = fuseRanks({
    sources: {
      semantic: ['Projects/Moby dick bot.md'],
      lexical: [],
      expansion: ['Tasks/Дата-гігієна фіду.md'],
    },
    totalNotes: 2500,
  });
  expect(out.map((c) => c.path)).toEqual([
    'Projects/Moby dick bot.md',
    'Tasks/Дата-гігієна фіду.md',
  ]);
});
```

- [ ] **Step 2: Re-point the existing two-source lift test as the health guard**

Update the arithmetic comment of `lifts a two-source mid-rank note over a single-source top hit` to the weighted math and keep its assertions — it is the guard that down-weighting did not kill multi-source reinforcement (the report's healthy case):

```ts
    // k = adaptiveK(25) = 5. A: semantic rank 1 → 1/6 ≈ 0.167.
    // B: lexical rank 2 + expansion rank 2 → 1/7 + 0.85/7 ≈ 0.264.
    // Multi-source reinforcement must survive the expansion down-weight —
    // fusion, not raw similarity, is still the strongest relevance signal.
```

- [ ] **Step 3: Run the suite**

Run: `npx vitest run test/semantic/rank-fusion.test.ts`
Expected: PASS (all tests, including both new fixtures).

- [ ] **Step 4: Commit**

```bash
git add test/semantic/rank-fusion.test.ts
git commit -m "test(semantic): pin 2026-08-10 report cases as fusion regressions"
```

---

### Task 4: Docs sweep, full verification, PR

**Files:**
- Possibly modify: `docs/architecture/*.md` (only if a file describes the fusion tie-break or equal weights)

**Interfaces:**
- Consumes: everything above, complete and committed.
- Produces: the delivered PR.

- [ ] **Step 1: Sweep docs for the old fusion contract**

Run: `rg -n -i "backlink|equal.*weight|tie-?break" docs/architecture/`
If any file states the fusion comparator uses `backlink_count` or that sources fuse at equal weights, update that wording to: expansion weighted at `EXPANSION_WEIGHT` (0.85), tie-break `score → sourceCount → path`. If nothing matches, skip — do not add new docs.

- [ ] **Step 2: Full gate + spec validation**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.
Run: `openspec validate --all`
Expected: `weighted-rrf-expansion` (and all others) valid.

- [ ] **Step 3: Commit any doc updates**

Only if Step 1 changed files:

```bash
git add docs/architecture
git commit -m "docs(architecture): reflect weighted RRF fusion and new tie-break"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "feat(semantic): weighted RRF — down-weight expansion leg, drop backlink tie-break" --body "$(cat <<'EOF'
## Why

Expansion competed with primary legs at equal RRF weight and won equal-rank ties via backlink_count — expansion-only hub notes took #1 with `matched_queries: []` (2026-08-10 report: retention, trading, and Moby cases).

## What

- `fuseRanks`: expansion source now contributes `w / (k + rank)` with `EXPANSION_WEIGHT = 0.85` (parameterized for the future eval harness); semantic/lexical stay at 1.
- Tie-break is now `score → sourceCount → path`; `getBacklinkCount` removed from `fuseRanks` (the `backlink_count` response field is untouched).
- The three report cases pinned as fusion regression tests; multi-source reinforcement guarded.
- Delta spec: `openspec/changes/weighted-rrf-expansion/specs/hybrid-search/spec.md`.

No MCP schema, parameter, or response-shape changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Do not merge or release — release is `npm run release` on `main` after merge, per repo policy.
