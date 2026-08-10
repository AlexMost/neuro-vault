## Context

Release 14.0.0 (`search-notes-unified-rank`) unified `search_notes` into one RRF-ranked `matches[]` list with `query_stats` for array queries. A field report against it identified three places where the response shape is *technically populated* but *semantically dishonest*. This change fixes the reporting contract only; ranking and matching semantics are untouched.

Current mechanics (confirmed in code):

- `buildQueryStats` (`search-notes.ts:157-170`) coalesces `semanticPerQueryHits?.[q] ?? 0` — and `semanticPerQueryHits` is `undefined` on every degradation path (lexical mode, corpus cold/absent, empty-filter early return). The `0` is a documented, deliberate placeholder.
- Block evidence (`retrieval-policy.ts`, Step 4): quick mode fetches the global top-5 blocks across *all* seed sources at threshold 0; deep mode applies the note-level threshold to blocks. Both can leave a legitimate seed with `blocks: []`.
- Lexical matching is AND-over-tokens (`rank.ts` + `match.ts`): a multi-token query with one vault-absent token reports `lexical: 0`, indistinguishable from a fully absent term.

Constraints: strict TS + `tsc --noEmit` authoritative; one concept = one parameter name (ADR-0005); response contract changes ride the major-version train; `executeRetrieval`/`executeMultiRetrieval` have exactly one consumer (search_notes), so the backfill has no cross-tool blast radius.

## Goals / Non-Goals

**Goals:**

- `query_stats[q].semantic` is `null` iff the semantic leg did not execute; any number means "leg ran, counted over its candidate set".
- No `search_notes` response ever contains `blocks: []` — a semantic hit carries ≥1 block whenever the note has block embeddings, else the key is absent.
- A dead multi-token query (`lexical === 0`, ≥2 tokens) carries `lexical_tokens: { token → note count }` so the caller sees which token killed the AND.
- Tool description (`SEARCH_NOTES_DESCRIPTION`) states all three semantics; hybrid-search spec updated via delta.

**Non-Goals:**

- No OR-fallback or any change to lexical matching semantics (separate decision, explicitly out of scope in the source task).
- No change to expansion weighting or fusion (shipped separately in `weighted-rrf-expansion`).
- No `query_stats` for single-string queries (stays array-only).
- No sweep of docs drift predating this change (separate vault task «Синхронізувати документацію з fused-контрактом»).

## Decisions

### D1: `semantic: null` for a leg that did not execute

- **Choice**: widen the field to `number | null`; `buildQueryStats` takes an explicit "semantic leg ran?" signal instead of coalescing `undefined → 0`. All three degradation paths emit `null`.
- **Rationale**: user's call — `null` is self-announcing for LLM consumers, where an absent key could silently read as 0.
- **Alternative considered**: omitting the key (consistent with the evidence-fields idiom) — rejected for readability by the caller.
- **Edge rule**: on the empty-filter early return, `semantic: null` (query never embedded) but `lexical: 0` (the count is defined over the empty filter set — a true observation). Rule: `null` = leg did not execute; number = leg's count over its candidate set.

### D2: Per-seed best-block backfill, then key omission

- **Choice**: after the existing block pass in both `executeRetrieval` and `executeMultiRetrieval`, every seed with zero blocks gets a per-seed lookup: `findBlockNeighbors({ sources: [that seed's source], threshold: 0, limit: 1 })`; in the multi-query variant, run per query vector and keep the max-similarity block. If still empty (note has no block embeddings), `assembleUnified` omits the `blocks` key from the entry.
- **Rationale**: user's call — evidence when evidence exists beats documenting its absence. Cost is at most one single-source block search per starving seed.
- **Alternatives considered**: (a) omit-and-document only — leaves rank-2 hits evidence-less; (b) `blocks_omitted` reason field — more contract surface for less value.
- **Contract invariant update**: `blocks[]`, when present, is non-empty; `similarity` may appear without `blocks` (note-level embedding only).

### D3: `lexical_tokens` per-token note counts, failure-path only

- **Choice**: `query_stats[q].lexical_tokens: Record<token, noteCount>`, emitted only when `lexical === 0 && tokens.length >= 2`. Computed in the lexical leg (`rankNotes` or a sibling pass) as a second pass over the already-parsed notes, testing each token individually with the same normalized-substring `matchUnit` rules, over the same filter set. Returned alongside `perQueryCounts` (e.g. `perQueryTokenCounts`), threaded through `LexicalIndex.search` to `buildQueryStats`.
- **Rationale**: user's call — pinpoints the killer token (directly actionable: drop/replace it), zero bytes on the happy path.
- **Alternatives considered**: (a) boolean `lexical_and_partial` — caller can't tell which token to fix; (b) always-on token counts — bloats every multi-word response against the compact-contract direction.
- **Note**: tokens are the normalized tokens the leg actually matched with (post `tokenizeQuery`), keyed by their normalized form.

### D4: Major release

- **Choice**: ship as the next major (15.0.0).
- **Rationale**: D1 changes an existing field's type/meaning (`number` → `number | null`, and `0` no longer appears on degradation paths). D2/D3 are additive but ride the same release.

## Risks / Trade-offs

- [Risk] Existing tests and downstream prompts assume `semantic: 0` on degradation paths → Mitigation: the delta spec makes `null` normative; test sweep is an explicit task; description text spells out the null-semantics.
- [Risk] Backfilled blocks at `threshold: 0` may carry low similarity and read as weak evidence → accepted: the block still shows *where* the note matched best; its `similarity` field makes the weakness visible rather than hidden.
- [Trade-off] `lexical` stays `0` (not `null`) on the empty-filter path while `semantic` is `null` → accepted per D1's edge rule; asymmetry is real (counting over an empty set is defined; embedding that never happened is not).
- [Trade-off] Extra per-seed block lookups → accepted: bounded by seed count (≤3 quick / ≤8 deep), each scoped to one source.

## Migration Plan

1. Implement legs bottom-up (rank.ts token counts → retrieval-policy backfill → search-notes assembly/stats/description), tests alongside per TDD.
2. `npm test && npm run lint && npm run typecheck` green; update the three touched docs.
3. PR to `main` via `gh pr create`; after merge, `npm run release` on `main` as a major (15.0.0).
4. Rollback: revert the PR — no persisted state, no data migration.

## Open Questions

(none — all forks resolved in brainstorm Q1–Q3)
