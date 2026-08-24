<!--
Raw capture of the verbal brainstorm (two /opsx:explore sessions, 2026-07-05).
Per opsx-routing.md the brainstorm ran in-chat; this file is its decision log.
Source: a private vault task note on adding a lexical leg to `search_notes`.
-->

# Brainstorm — hybrid-search-notes

## Background

Field observation: when `search_notes` (semantic-only) returns noise — exact
terms, names, codes, abbreviations that don't land on the embedding corpus —
the agent escapes to `grep` over the vault. That escape is a missing
capability, not a semantic-quality problem: the server has no lexical /
exact-match channel at all. The three existing search "legs" are semantic
(`search_notes`), structural (`query_notes` — no `content` in `NoteRecord`,
so no body regex), and… nothing for literal text.

Key reframe discovered mid-session: the grep escape is almost always a **body**
search, and the worst semantic failure mode is **silent noise** — semantics
never returns "nothing", it returns something plausible, and the agent doesn't
know it was lied to.

Vault scale grounding: ~700 notes, < 15 MB of markdown including bodies.

## Decision chain

### Q1 — Off-the-shelf search index (FlexSearch/MiniSearch/Orama/FTS5)?

**Decision: no search-index library; hand-rolled matcher.**
Checked FlexSearch 0.8 docs (context7): no match positions in results
(snippets would be manual anyway; highlighting requires `store: true` =
duplicating all bodies in the index), no phrase adjacency (our top ranking
tier), no numeric scores, Cyrillic gets only the universal `Normalize`
encoder — i.e. the same normalize function we'd write ourselves. Candidate
selection over a <15 MB corpus is trivial (ms-range substring scan); the
library would take only the trivial part and leave us the whole quality
layer plus index lifecycle/invalidation. Revisit boundary: ~100k+ notes.

### Q2 — Body search now or deferred (`include_body` flag)?

**Decision: body in scope from day one.** The originating grep-escape
observation *is* body search; title+heading-only would close half the gap.
Contract absorbs it via `matched_in: "title" | "heading" | "body"`.

### Q3 — One hybrid tool vs. two tools (`search_semantic` / `search_text`)?

**Decision: hybrid inside `search_notes`.** Two-tool arguments were real
(honest schemas, grep affordance is deeply trained into LLMs — the grep
escape itself proves agents can route). But hybrid wins on: intersection
signal (note hitting both legs = gold relevance signal, LLM fuses lists
side-by-side for free), silent-noise cure (exact matches appear without the
agent deciding to re-query), and no ×2 scaffolding (filter, fan-out,
multi-query, docs). Grep-mode lives inside the tool via `mode` instead.

### Q4 — Leg selection API: `legs: []` array vs. `mode` values?

**Decision: two orthogonal enum axes.**
`mode: "hybrid" | "lexical"` (WHAT to search; default `hybrid`) ×
`effort: "quick" | "deep"` (HOW MUCH; default `quick`; the current
`mode: "quick"|"deep"` values migrate to `effort` unchanged).
`limit` steers the semantic tree in `hybrid` and the lexical list in
`lexical`; `threshold` is semantic-only (documented). `mode: "semantic"`
deliberately omitted — adding an enum value later is non-breaking.

### Q5 — Migration shims for renamed params?

**Decision: clean break, single major release, no tolerant aliases** for old
`mode: "quick"/"deep"`. Consumers are a handful of agents that re-read the
tool description; an alias would keep the old semantics as a shadow forever.
Both breaking renames (`results` → `semantic_matches`, `mode` → `mode`+`effort`)
ship in one major.

### Q6 — Lexical result shape: flat items vs. grouped per note?

**Decision: grouped (option B).** `lexical_matches[]` item =
`{ path, backlink_count, vault, matched_queries?, matches: [...] }` with
`matches[]` capped ~3 per note; mirrors the semantic `results[].blocks[]`
shape; per-note cap becomes natural; the agent sees one note with all its
evidence. No numeric score on lexical items — invariant "`similarity` is
semantic-only"; order + `matched_in` carry the information.

### Q7 — Matching unit: raw lines vs. markdown AST blocks?

**Decision: AST blocks.** (User instinct; superseded the earlier line-based
sketch.) Line-based misses phrases across hard-wrapped lines inside a
paragraph. Block-level parsing gives: phrase-through-linewrap, code fences as
`code` nodes (headings inside can't be confused), `lines: [start, end]` from
node positions, and section-heading context for body matches (mirrors
semantic `blocks[].heading`). No canonical "markdown search" library exists;
the ecosystem pattern is parse → match. The parser is a *pure-function*
dependency (text → tree with positions), unlike a search index — the earlier
"no library" argument doesn't apply. Candidates: `mdast-util-from-markdown`/
`remark` (ESM-native, leaning here) or `markdown-it` (`token.map`); final
pick at impl time. First markdown-parser dependency in the repo.

### Q8 — Normalization

**Decision:** `toLowerCase` → NFKD → strip combining marks (`\p{M}`) →
**apostrophe unification** (`'`/`ʼ`/`’`/`‘` → one form; critical for
Ukrainian: `об'єкт`/`обʼєкт`/`об’єкт` are three codepoint-distinct spellings
NFKD does not unify) → whitespace collapse. Case- and accent-insensitive
**substring**, not word-boundary tokenization — Ukrainian declensions
(`пошук`/`пошуку`/`пошуком`); stem is a substring of the inflected form.
NFKD side effect `й`→`и`, `ї`→`і` accepted as deliberate recall bias (test
it). `і`↔`и` NOT merged. Query tokenization: whitespace split, punctuation
stays inside tokens (AND-substring makes `tolerant arguments` match both
`tolerant-arguments` and `tolerant_arguments`).

### Q9 — Ranking

**Decision: six ordinal tiers** — phrase-in-title → tokens-in-title →
phrase-in-heading → tokens-in-heading → phrase-in-body-block →
tokens-within-body-block. Within a tier: **density** (sum of token lengths /
unit length — a query covering the whole title beats a passing mention in a
long one) desc, then `backlink_count` desc, then `path` asc. Fully
deterministic, byte-for-byte testable.

### Q10 — Cascade with early stop ("search titles; only go deeper if nothing")?

**Decision: rejected as hard-stop, adopted as lazy evaluation.** A hard stop
on "any title hit" masks body hits in *other* notes — recreating the silent-
noise failure inside the lexical leg. But since tiers are ordinal, the
implementation may evaluate tier-by-tier and stop early **once the global cap
is filled** — output is byte-identical to full ranking, and bodies are
skipped when titles suffice. Already-selected notes still get their deep
`matches[]` collected.

### Q11 — Caps & snippets

Per-note cap ~3 `matches`; global note cap by `effort` (~5 quick / ~10 deep)
or `limit` in lexical mode. Snippet = ~150-char window around the first
match (grapheme-safe, `…` ellipses) — markdown paragraphs are single long
lines, so whole-line snippets don't work. `lines` stays honest from AST
positions.

### Q12 — Freshness

Per-request read (precedent: `query_notes` reads the whole vault per call) +
mtime-keyed cache `path → { mtime, title, blocks }` — stat is cheap, only
changed files re-parse. No index lifecycle, no staleness vs. live Obsidian
edits.

## Also decided

- Title = filename minus `.md`. Frontmatter `aliases` in the title tier:
  deferred (non-breaking addition later). Path components not matched
  (`filter.path_prefix` covers that). Frontmatter excluded from body matching.
- Lexical leg fully independent of embeddings — `mode: "lexical"` works on a
  cold/absent Smart Connections corpus and must not touch the corpus loader.
- Empty lexical result is an honest `[]` (unlike semantics).
- `filter` applies identically to both legs (reuse `listMatchingPaths`).
- Multi-vault fan-out keeps its shape; multi-query merges lexical matches
  with `matched_queries` like the semantic leg.
- Docs `docs/guide/` restructure by *intent* (Finding notes / Reading &
  modifying / Routing) is part of this change — the mechanism-based
  "Semantic Search" page becomes a lie the moment the tool is hybrid.

## Out of scope (deliberate)

- Separate `search_text` / `search_semantic` tools (rejected — Q3).
- Tolerant aliases for old `mode` values (rejected — Q5).
- `mode: "semantic"` enum value (later, non-breaking).
- `aliases` in title tier (later, non-breaking).
- Regex / word-boundary mode.
- Search-index library (rejected — Q1; revisit at ~100k notes).
- Exhaustive body regex in `query_notes` (`content` in `NoteRecord`) —
  separate potential change.
