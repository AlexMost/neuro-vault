## Why

The 2026-08-10 field report against 14.0.0 surfaced three honesty gaps in the `search_notes` fused response: `query_stats.semantic: 0` is reported even when the semantic leg never ran (lexical mode, no corpus, empty filter), semantic hits can ship with `blocks: []` (no evidence, including a rank-2 hit at similarity 0.642), and `lexical: 0` cannot distinguish "term absent from the vault" from "multi-word AND semantics killed the match". Each misleads an LLM caller deciding whether to rephrase, drop a query variant, or trust a hit.

## What Changes

**query_stats semantic count on degradation paths**
- From: `semantic: 0` whenever the semantic leg did not run (lexical mode, corpus unavailable, empty-filter early return) — indistinguishable from "searched, found nothing"
- To: `semantic: null` when the leg did not execute; a number always means the leg ran and counted
- Reason: `0` must be a real observation, not a placeholder
- Impact: breaking (field type widens to `number | null`) — next release is a major

**Semantic block evidence**
- From: a seed whose blocks were starved by the global quick-mode block cap or the deep-mode threshold ships `blocks: []`
- To: each evidence-less seed is backfilled with its own best block (per-seed top-1, threshold 0); if the note has no block embeddings at all, the `blocks` key is omitted — empty arrays never ship
- Reason: a semantic hit should always carry evidence when evidence exists
- Impact: non-breaking enrichment (more evidence, no key ever `[]`)

**AND-kill diagnostic**
- From: a dead multi-token query reports bare `lexical: 0`
- To: it additionally reports `lexical_tokens: { "<token>": <note count> }` (only when `lexical === 0` and the query has ≥2 tokens), pinpointing which token killed the AND
- Reason: reporting-only diagnosis; matching semantics unchanged
- Impact: non-breaking additive field, zero bytes on the happy path

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `hybrid-search`: the query_stats requirement changes (`semantic` nullable with defined null-semantics; `lexical_tokens` diagnostic on dead multi-token queries) and the unified-matches requirement changes (`blocks` presence guarantee: backfilled best block or omitted key, never an empty array).

## Impact

- `src/modules/semantic/retrieval-policy.ts` — per-seed block backfill in `executeRetrieval` and `executeMultiRetrieval` (sole consumer: search_notes).
- `src/modules/semantic/tools/search-notes.ts` — `buildQueryStats` null-semantics, `SearchNotesOutput` type, `assembleUnified` blocks-key omission, `SEARCH_NOTES_DESCRIPTION` contract text.
- `src/lib/obsidian/lexical/rank.ts` (+ `lexical-index.ts` plumbing) — per-token note counts for dead multi-token queries.
- Tests: `test/semantic/retrieval-policy.test.ts`, `test/semantic/tools/search-notes-e2e.test.ts`, lexical rank tests — including existing assertions that expect `semantic: 0` on degradation paths.
- Docs describing the touched fields: `docs/architecture/retrieval-policy.md`, `docs/architecture/lexical-search.md`, `docs/guide/finding-notes.md`.
- Release: major version bump (response contract change on `semantic`).
