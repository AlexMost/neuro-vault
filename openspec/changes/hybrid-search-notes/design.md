# Design — hybrid-search-notes

## Context

`search_notes` is semantic-only: an in-memory cosine search over a read-only
Smart Connections corpus (ADR-0006). Its worst failure mode is *silent noise* —
on exact terms, names, codes, or a cold corpus it returns plausible-looking
weak matches, and agents escape to `grep`, losing `filter`, `backlink_count`,
and multi-vault fan-out. The server has no lexical channel: `query_notes`
evaluates sift filters against `NoteRecord` (no `content`), and nothing
matches note bodies literally.

Constraints: strict TS/ESM (ADR-0002), structured tool errors (ADR-0003), one
parameter dictionary — a rename costs a major (ADR-0005), corpus is read-only
(ADR-0006), batch reads go straight to disk (ADR-0007). Vault scale grounding:
~700 notes, < 15 MB of markdown. Precedent: `query_notes` already reads the
whole vault per request — per-request freshness with zero invalidation is an
accepted envelope in this codebase.

Full decision log: `brainstorm.md` (Q1–Q12). Origin: vault task note
`Tasks/neuro-vault/Add lexical leg to search_notes (hybrid)`.

## Goals / Non-Goals

**Goals:**

- One search entry point returning both legs: `{ semantic_matches, lexical_matches }`.
- Lexical leg over title + headings + body, fully independent of embeddings
  (works on cold/absent corpus; never touches the corpus loader).
- Deterministic, byte-for-byte testable lexical ranking.
- `filter`, multi-vault fan-out, and multi-query behave identically across legs.
- Docs regrouped by intent so the tool surface reads truthfully.

**Non-Goals:**

- Standalone `search_text`/`search_semantic` tools (rejected — see D2).
- Search-index library / persistent index (rejected — see D5; revisit ≥100k notes).
- Tolerant aliases for the old `mode` values (clean major break — D4).
- `mode: "semantic"`, frontmatter `aliases` in the title tier, regex/word-boundary
  mode, exhaustive body regex in `query_notes` — all deferred, all non-breaking additions later.

## Decisions

### D1: Hybrid inside `search_notes`, not a second tool

- **Choice**: one tool, symmetric response `{ semantic_matches, lexical_matches }` in all modes.
- **Why**: intersection signal (a note hitting both legs is the strongest
  relevance evidence, and the LLM fuses side-by-side lists for free); silent
  semantic noise is cured without the agent deciding to re-query; no ×2
  scaffolding (filter, fan-out, multi-query, docs).
- **Alternative considered**: `search_semantic` + `search_text` — honest
  per-tool schemas and a deeply-trained grep affordance, but loses the
  intersection signal, leaves silent noise uncured, and doubles the scaffolding.

### D2: Two orthogonal input axes

- **Choice**: `mode: "hybrid" | "lexical"` (default `hybrid`) × `effort:
  "quick" | "deep"` (default `quick`; old `mode` values move here unchanged).
  `limit` steers the semantic tree in `hybrid`, the lexical list in `lexical`;
  `threshold` is semantic-only and documented as such.
- **Why**: intent (how much work) and channel (which legs) are independent
  concerns; a merged enum (`quick|deep|lexical`) silently drops the depth
  choice for lexical; a `legs: []` array makes the agent think in mechanisms.
- **Alternatives considered**: merged `mode` enum; `legs` array — both rejected above.

### D3: Grouped lexical result shape

- **Choice**: `lexical_matches[]` item = `{ path, backlink_count, vault,
  matched_queries?, matches: [{ matched_in: "title"|"heading"|"body", snippet,
  lines?, heading? }] }`, `matches` capped ~3/note. No numeric score on lexical
  items — `similarity` stays semantic-only; order + `matched_in` carry the info.
- **Why**: mirrors semantic `results[].blocks[]`; per-note cap is natural; the
  agent sees one note with all its evidence.
- **Alternative considered**: flat one-location-per-item list — duplicates
  `path`, scatters evidence, makes per-note caps awkward.

### D4: Clean breaking major, no migration shims

- **Choice**: `results` → `semantic_matches` and `mode` → `mode`+`effort` ship
  in one major release; old `mode: "quick"/"deep"` fails schema validation.
- **Why**: consumers are a handful of agents that re-read the tool description
  on next call; a tolerant alias would carry the old semantics as a shadow forever.
- **Alternative considered**: tolerant-arguments-style alias for old `mode`
  values — rejected by the user explicitly.

### D5: Hand-rolled matcher over markdown AST blocks; no search index

- **Choice**: per-request matching over block-level markdown AST (paragraph,
  heading, list item, code) with line positions; no FlexSearch/MiniSearch/FTS5.
- **Why**: verified against FlexSearch 0.8 docs — no match positions (snippets
  manual anyway), no phrase adjacency (our top tier), no numeric scores,
  Cyrillic gets only universal normalize (≈ the function we write ourselves).
  Candidate selection over <15 MB is ms-range; an index adds lifecycle and
  staleness against live Obsidian edits. AST blocks (vs raw lines) match
  phrases across hard-wrapped lines, make code fences unconfusable with
  headings, and give `lines` + section-heading context from node positions.
- **Alternatives considered**: FlexSearch/MiniSearch (rejected above); raw
  line-based matching (missed hard-wrapped phrases; manual fence tracking).
- **Parser**: requirement is *block nodes with line positions*; candidates
  `mdast-util-from-markdown`/`remark` (ESM-native, leaning) or `markdown-it`
  (`token.map`). Final pick at implementation. First md-parser dependency in
  the repo — a pure text→tree function, unlike a stateful index.

### D6: Normalization pipeline

- **Choice**: `toLowerCase` → NFKD → strip `\p{M}` → apostrophe unification
  (`'`/`ʼ`/`’`/`‘` → one form) → whitespace collapse. Substring matching, not
  word-boundary. Query tokenized on whitespace; punctuation stays in tokens.
- **Why**: Ukrainian declensions make substring the right recall bias
  (`пошук` ⊂ `пошуком`); apostrophe variants are codepoint-distinct and NFKD
  does not unify them (`об'єкт`/`обʼєкт`/`об’єкт`); AND-substring makes
  `tolerant arguments` match `tolerant-arguments` and `tolerant_arguments`.
  NFKD side effect `й`→`и`, `ї`→`і` accepted as recall bias (tested);
  `і`↔`и` NOT merged (distinct letters).

### D7: Six-tier deterministic ranking with density tie-break

- **Choice**: phrase-in-title → tokens-in-title → phrase-in-heading →
  tokens-in-heading → phrase-in-body-block → tokens-within-body-block; within
  a tier: density (Σ token lengths / unit length) desc → `backlink_count` desc
  → `path` asc.
- **Why**: fully deterministic (byte-for-byte testable), no opaque scoring;
  density separates "the note IS about this" from a passing mention in a long
  title.
- **Alternative considered**: BM25-style scoring — needless on this corpus,
  non-deterministic across corpus changes, and requires a library (D5).

### D8: Lazy tier cascade as pure optimization

- **Choice**: tiers may be evaluated title → headings → body with early exit
  once the global cap is filled; output must be byte-identical to full
  ranking. Already-selected notes still collect their full `matches[]`.
- **Why**: tiers are ordinal, so laziness is invisible; bodies are skipped
  when titles suffice.
- **Alternative considered (rejected)**: hard stop on "any title hit" — masks
  body hits in other notes, recreating silent noise inside the lexical leg.

### D9: Freshness via per-request read + mtime cache

- **Choice**: `scan()` per request; cache `path → { mtime, title, blocks }`;
  stat every file, re-parse only changed ones. No watcher, no index lifecycle.
- **Why**: `query_notes` precedent; correctness against live Obsidian edits
  by construction; parse cost amortizes to changed-files-only.

### D10: Caps and snippets

- **Choice**: global note cap by `effort` (~5 quick / ~10 deep; `limit`
  overrides in `mode: "lexical"`); ~3 `matches`/note; snippet = ~150-char
  grapheme-safe window around the first match with `…` ellipses; `lines:
  [start, end]` from AST positions; body matches carry their section `heading`.
- **Why**: markdown paragraphs are single long source lines — whole-line
  snippets don't work; caps keep common-token queries (`agent`) from flooding
  the response; section heading mirrors semantic `blocks[].heading`.

## Risks / Trade-offs

- **[Risk] Breaking change strands stale clients** → Mitigation: major bump,
  CHANGELOG breaking notes, tool description rewritten; consumers are agents
  that re-read descriptions per session.
- **[Risk] Markdown parser handles Obsidian-flavored syntax (wikilinks,
  callouts, dataview) oddly** → Mitigation: matching runs over block *text*
  content; parser choice validated at impl against real vault notes; fallback
  candidate (`markdown-it`) identified.
- **[Risk] Per-request stat of ~700 files adds latency on cold FS cache** →
  Mitigation: same envelope as `query_notes` today; mtime cache bounds parse
  cost; measured before/after at impl.
- **[Trade-off] NFKD folds `й`→`и`, `ї`→`і` (more recall, slightly less
  precision)** → accepted deliberately for the exact-leg's recall-first role;
  pinned by test so it's a decision, not a surprise.
- **[Trade-off] No numeric lexical score in the response** → accepted:
  keeps the `similarity`-is-semantic invariant; ordinal `matched_in` + order
  suffice for an LLM consumer.
- **[Trade-off] Multiword phrase split across two AST blocks doesn't match as
  phrase** → accepted; still matches as tokens if within one block.

## Migration Plan

1. Implement behind the new schema; all changes land in one PR to `main` via
   the standard gates (`npm test`, `npm run lint`, `npx tsc --noEmit`, build).
2. Docs (guide restructure, routing, parameter dictionary) ship in the same PR.
3. Release: `npm run release` on `main` after merge → **major version**
   (breaking: `results` → `semantic_matches`; `mode` redefined + `effort` added).
4. Rollback strategy: revert the release commit / publish previous major from
   tag — the corpus and vault are untouched (read-only leg), so rollback is
   code-only.

## Open Questions

- Parser pick: `mdast-util-from-markdown` — confirmed by spike (block nodes +
  line positions verified; markdown-it fallback not needed).
- Exact cap numbers (5/10 global, 3/note, 150-char window) — tuned at impl;
  spec states them as defaults, not invariants.
