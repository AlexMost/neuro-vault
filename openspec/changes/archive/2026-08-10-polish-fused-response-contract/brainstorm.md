<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — polish-fused-response-contract

## Background

Source: a private vault task note on polishing the fused response contract —
a collection of small contract burrs from the 2026-08-10 field report against
release 14.0.0 (`search-notes-unified-rank`). Explicitly NOT about ranking —
about honesty of the response fields.

Code exploration confirmed all three burrs:

1. **`query_stats.semantic: 0` on degradation paths.** `buildQueryStats`
   (`src/modules/semantic/tools/search-notes.ts:157-170`) receives
   `semanticPerQueryHits: undefined` on every path where the semantic leg never
   ran — `mode: "lexical"`, corpus unavailable/absent, and the empty-filter
   early return — and coalesces to `0`. The in-code comment (lines 149-156)
   documents this as a conscious decision. Net effect: `0` means both "searched,
   found nothing" and "never searched", which are opposite signals for an LLM
   caller deciding whether to rephrase.

2. **`blocks: []` on semantic hits.** In the field report, 5 occurrences,
   including a rank-2 hit at similarity 0.642 with zero evidence. Root causes
   confirmed in `src/modules/semantic/retrieval-policy.ts`:
   - quick mode: `findBlockNeighbors` runs with `threshold: 0, limit: 5`
     *globally across all seed sources* — the top-5 blocks can all belong to
     other seeds, starving a lower-ranked seed;
   - deep mode: block search uses the note-level `threshold` — a seed whose
     note-level embedding clears the threshold can have every block fall below
     it.

3. **`lexical: 0` is ambiguous.** The lexical leg is AND-over-tokens
   (`src/lib/obsidian/lexical/rank.ts`, `matchUnit`): a multi-word query like
   «ретеншн алертів» reports 0 even when «алертів» alone matches notes
   («Копірайт-ревізія алертів»). `query_stats` cannot distinguish "term absent
   from vault" from "AND semantics killed the match". Task scope: the
   *reporting half only* — no OR-fallback, no matching-semantics change.

Blast radius: `executeRetrieval`/`executeMultiRetrieval` are consumed only by
`search-notes.ts`. Governing spec: `openspec/specs/hybrid-search/spec.md`
(requirements "query_stats reports pre-cap per-query hit counts" and
"search_notes returns one RRF-ranked matches list").

## Decision chain

### Q1 — How should query_stats represent a semantic leg that never ran?

Options: (a) omit the `semantic` key; (b) explicit `null`.

**Decision (user): explicit `null`.** `{ semantic: null, lexical: 3 }`.
Rationale: absence could be misread as 0 by LLM consumers; `null` is
self-announcing — "we thought about it, the leg did not execute". Cost: the
field type widens to `number | null`.

Follow-on call (assistant judgment, momentum): on the empty-filter early
return, `semantic` is also `null` (the query was never embedded), while
`lexical` stays `0` — the lexical count is defined over the (empty) filter
set, so "0 notes matched" is a true statement there. Rule of thumb:
`null` = the leg did not execute; a number = the leg's count over its
candidate set.

### Q2 — What to do about semantic hits with `blocks: []`?

Options: (a) backfill each evidence-less seed with its own best block;
(b) no behavior change, omit the empty key + document; (c) keep `[]` plus a
machine-readable reason field.

**Decision (user): backfill best block (recommended option).** Every semantic
seed that ends the block pass with zero blocks gets a per-seed top-1 block
lookup at `threshold: 0`. If the note genuinely has no block embeddings, the
`blocks` key is omitted entirely (empty arrays never ship). Result invariant:
a semantic hit always carries block evidence when block evidence exists.

Implementation shape: a backfill step after Step 4 in both `executeRetrieval`
and `executeMultiRetrieval`, scoped per starving seed
(`findBlockNeighbors({ sources: [thatSeed], threshold: 0, limit: 1 })`); in the
multi-query variant, take the best block across all query vectors. Omission of
the empty key happens at assembly (`assembleUnified`).

### Q3 — Shape of the AND-kill diagnostic in query_stats?

Options: (a) per-token counts only when a query's lexical count is 0 and it
has ≥2 tokens; (b) a boolean flag; (c) always emit per-token counts.

**Decision (user): per-token counts on 0 (recommended option).**
`query_stats[q].lexical_tokens: { "<token>": <note count>, ... }`, present
only when `lexical === 0 && tokens.length >= 2`. Pinpoints which token killed
the AND — directly actionable for rephrasing — and adds zero bytes on the
happy path. Token counts are per-token *note* counts within the same filter
set the leg searched (a token counts a note if it matches title or any unit
by the same normalized-substring rules).

## Trade-offs & boundaries

- **Breaking change**: `semantic: number` → `number | null` is a response
  contract change on top of 14.0.0 → next release is a major (15.0.0), per the
  repo's contract-stability posture (ADR-0005 spirit).
- **Cost of backfill**: at most one extra `findBlockNeighbors` call per
  starving seed, each scoped to a single source — negligible.
- **`lexical_tokens` scope**: array queries only (query_stats itself is
  array-only; widening to single-string queries is a separate discussion, not
  taken here).
- **Out of scope** (per task note): OR-fallback / lexical matching-semantics
  change; expansion weight (separate change, shipped); docs drift from the
  14.0.0 verification report (separate vault task «Синхронізувати документацію
  з fused-контрактом»). Docs updated here are only those describing the fields
  this change touches (`docs/architecture/retrieval-policy.md`,
  `docs/architecture/lexical-search.md`, `docs/guide/finding-notes.md`).

## Acceptance criteria

- `npm test && npm run lint && npm run typecheck` pass.
- Lexical mode / no-corpus / empty-filter responses report
  `semantic: null` in query_stats; hybrid runs keep numeric counts.
- No response ever contains `blocks: []` — either ≥1 block or no key.
- A dead multi-token query reports `lexical_tokens` with per-token counts;
  single-token dead queries and non-zero queries do not.
- `search_notes` tool description updated to match all three field semantics;
  hybrid-search spec deltas validate via `openspec validate --all`.
