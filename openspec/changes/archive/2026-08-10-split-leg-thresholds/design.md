# Design — split-leg-thresholds

## Context

`search_notes` runs up to three similarity-scored retrieval passes per request, all in `src/modules/semantic/retrieval-policy.ts` (symmetric single-query and multi-query paths):

1. **Semantic leg** — query↔note cosine (`findNeighbors`, Step 1). Observed band on the calibration query: 0.77–0.80.
2. **Block evidence (deep)** — query↔block cosine (`findBlockNeighbors`, Step 4), band ~0.60–0.85, with a 1-block-per-seed backfill at threshold 0 (Step 4b).
3. **Expansion leg (deep)** — seed-note↔note cosine (`computeRelatedPerSeed`, Step 5), band ~0.89–0.985.

Today one `threshold` value (user input or mode default 0.5 quick / 0.35 deep) is passed to all three, and Step 2 silently retries the semantic search at `FALLBACK_THRESHOLD = 0.3` whenever the threshold filtered out everything. Net effect: an explicit threshold above the semantic band is a no-op on the semantic leg (fallback cancels it) while visibly cutting the expansion leg — the exact opposite of the advertised "SEMANTIC LEG ONLY". The current `hybrid-search` spec already requires semantic-only threshold semantics; the implementation violates it.

Constraints: MCP parameter dictionary (ADR-0005 — a parameter name is permanent, renames cost a major); tolerant-arguments coercion applies to numeric inputs; SDK-gate testing convention (assert against `reg.spec.inputSchema`, not handler-direct).

## Goals / Non-Goals

**Goals:**

- An explicitly passed `threshold` is a hard filter on the semantic note score — enforceable, no silent rescue.
- The expansion leg is bounded by its own named contract parameter on its own scale, defaulting to current behavior.
- The user `threshold` stops reaching the block pass; the block-evidence guarantee is unchanged.
- The default-threshold fallback, when it engages, is visible in the response.
- Default calls (no `threshold`, no `expansion_floor`) produce identical output before and after.

**Non-Goals:**

- Semantic ranking quality (note score is anti-discriminative on the calibration data) — Retrieval eval harness.
- Recalibrating the 0.5/0.35 defaults — they keep their fallback-backed behavior; measurement belongs to the eval harness.
- `truncated` granularity, short-token lexical junk, reranker — separate tasks.

## Decisions

### D1: Fallback only for default thresholds

- **Choice**: The Step-2 retry at `FALLBACK_THRESHOLD = 0.3` runs only when `input.threshold === undefined` (both retrieval paths). An explicit threshold that filters everything returns zero semantic hits.
- **Rationale**: A filter the caller asked for must filter; the silent rescue is why the bug was invisible since the parameter's introduction. Restricting (rather than removing) the fallback keeps default behavior — and its usefulness on sparse corpora — untouched.
- **Alternatives**: Remove the fallback entirely (changes default behavior, out of scope); keep it always but surface it (contract "hard filter" still unenforceable — rejected by user decision).

### D2: `expansion_floor` — new optional contract parameter

- **Choice**: `expansion_floor?: number` (0–1), passed through the same tolerant-arguments coercion as `threshold`, replacing `threshold` as the `computeRelatedPerSeed` floor. Default: the deep mode-default threshold value (0.35), which is what default calls effectively used — byte-for-byte behavior-preserving. Quick effort has no expansion leg; the parameter is accepted but inert there (consistent with `threshold` being inert in `mode: "lexical"`).
- **Rationale**: The scales are incomparable (query↔note ~0.3–0.8 vs note↔note 0.89–0.985); sharing one knob produced the bug. Exposing the floor (vs an internal constant) was the user's call: transparency, and the 2026-08-10 calibration curve becomes reproducible through the API.
- **Alternatives**: Internal constant (opaque safeguard again — rejected); reusing `threshold` with per-leg interpretation (the disease itself).

### D3: Block pass uses the internal mode default, not the user threshold

- **Choice**: Deep block filtering (`findBlockNeighbors`, Step 4) uses the fixed internal default (0.35) regardless of user `threshold`; quick stays at threshold 0; the Step-4b backfill guarantee ("1 best block per starved seed, block-less only when no block embeddings") is unchanged.
- **Rationale**: Removes the third incomparable scale (query↔block) from under the same knob. A user threshold inside the note band would otherwise silently degrade evidence to backfill minimum.
- **Alternatives**: Keep user threshold on blocks (fewer changed lines, but perpetuates the multi-scale coupling — rejected by user decision).

### D4: Fallback visibility via `query_stats`

- **Choice**: When the default-threshold fallback produced a query's semantic hits, that query's `query_stats` entry carries `semantic_fallback: true`; the field is absent otherwise. Single-string queries keep the existing rule (`query_stats` omitted), so single-query fallback remains unsurfaced for now.
- **Rationale**: Reuses the existing per-query diagnostics surface with per-query precision (multi-query requests can fall back on some queries only). After D1, explicit thresholds are honest, so the signal only concerns default-threshold calls — array queries are where retrieval diagnosis happens in practice.
- **Alternatives**: Top-level `semantic_fallback` field on every response shape (covers single queries but adds a second mechanism and a new top-level contract field — deferred; see Open Questions).

## Risks / Trade-offs

- [Risk] Callers who pass explicit `threshold` and today get fallback-rescued results will start seeing zero semantic hits. → Mitigation: this restores the documented contract (spec already promised semantic-only hard filtering); the lexical leg still returns matches; release notes call it out.
- [Risk] `expansion_floor` default of 0.35 is far below the observed note↔note band (0.89+) — effectively no floor in practice. → Accepted: that is exactly today's behavior; picking a "meaningful" default is calibration work that belongs to the eval harness.
- [Trade-off] Single-query fallback stays invisible (D4). → Accepted to avoid growing the top-level response contract for a default-only diagnostic; revisit if it ever misleads in practice.
- [Risk] Behavior-preservation claim ("byte-for-byte for default calls") could be violated by a subtle plumbing mistake. → Mitigation: regression test locks default-call output on a fixture corpus before/after.

## Migration Plan

Single PR to `main`. No deployment or data migration — the corpus is read-only and the change is request-scoped. Release as a minor (`feat`: new `expansion_floor` parameter; explicit-threshold behavior change is a `fix` toward the already-documented contract). Rollback = revert the PR. Acceptance: `npm test`, `npm run lint`, `npm run typecheck` green; calibration-curve tests (see specs) pass; parameter dictionary and docs (including the model-facing guide layer) updated in the same PR.

## Open Questions

- None blocking. Deferred: whether single-string queries should ever surface the fallback signal (would require either relaxing the `query_stats` omission rule or a top-level field) — wait for a real case where its absence misleads.
