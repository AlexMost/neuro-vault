# Proposal — hybrid-search-notes

## Why

When a query doesn't land on the embedding corpus — exact terms, names, codes, abbreviations — `search_notes` returns plausible-looking noise and the agent escapes to `grep` over the vault, losing `filter`, `backlink_count`, and multi-vault support. The server has no lexical/exact-match channel at all: `query_notes` cannot regex note bodies (`content` is not in `NoteRecord`), and the semantic leg is helpless on a cold or absent corpus. Adding a lexical leg inside the tool the agent already reaches for cures the worst failure mode (silent semantic noise) structurally: exact matches appear next to semantic ones without the agent having to decide to re-query.

## What Changes

**`search_notes` becomes hybrid (dense + lexical)**

- From: semantic-only; returns `{ results, truncated? }`; `mode: "quick" | "deep"` controls depth.
- To: two orthogonal axes — `mode: "hybrid" | "lexical"` (which legs; default `hybrid`) × `effort: "quick" | "deep"` (volume; default `quick`, absorbing the old `mode` values). Returns `{ semantic_matches, lexical_matches, truncated? }` in every mode. The semantic tree is unchanged except the key rename.
- Reason: hybrid retrieval in one entry point preserves the intersection signal and cures silent noise; orthogonal axes keep intent (`effort`) separate from channel (`mode`).
- Impact: **breaking** — `results` → `semantic_matches`; `mode: "quick"/"deep"` rejected by validation (no tolerant aliases; consumers are agents that re-read the tool description). Ships as one major release.

**New lexical leg** — matches note **title + headings + body** as markdown AST blocks: case-/accent-insensitive substring AND over normalized text (incl. apostrophe unification for Ukrainian), six deterministic ranking tiers with density tie-break, results grouped per note (`matches[]` with `matched_in`/`snippet`/`lines`/section `heading`, capped ~3/note). Works with no embedding corpus. `filter` applies to both legs identically; multi-vault fan-out and multi-query keep their shapes.

**Docs reframe** — `docs/guide/` regrouped by intent (Finding notes / Reading & modifying / Routing) instead of mechanism; `routing.md` rewritten around one search entry point.

## Capabilities

### New Capabilities

- `hybrid-search`: the `search_notes` hybrid contract — `mode`×`effort` axes, symmetric `{ semantic_matches, lexical_matches }` response, lexical matching semantics (normalization, AST-block units, tiers, density, caps, snippets), embeddings-independence of the lexical leg, filter/fan-out/multi-query parity.

### Modified Capabilities

- `mcp-tool-surface`: records the deliberate absence of a standalone `search_text`/`search_semantic` tool — exact-match search is served by `search_notes` (`mode: "lexical"`), not by a new tool.

## Impact

- **Code**: `src/modules/semantic/tools/search-notes.ts` (input schema, orchestration), new lexical matcher module (normalize, AST-block extraction, tier ranking, mtime cache), reuse of `listMatchingPaths`, `VaultReader`, wikilink graph for `backlink_count`.
- **New dependency**: a markdown parser with block-level nodes and line positions (`mdast-util-from-markdown`/`remark` or `markdown-it`; first md parser in the repo — chosen at implementation).
- **API**: breaking major — response key rename + `mode`/`effort` axis split; MCP parameter dictionary gains `effort`, redefines `mode` (ADR-0005 satisfied by the major bump).
- **Docs**: `docs/guide/` restructure, `routing.md`, `guide/README.md`, parameter dictionary, CHANGELOG breaking notes.
- **Tests**: SDK-gate (`reg.spec.inputSchema`) coverage for both axes and the new response shape; determinism tests for tier ordering byte-for-byte; normalization tests (Cyrillic NFKD, apostrophes, case).
