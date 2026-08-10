## Why

Release 14.0.0 shipped the unified `search_notes` contract — one RRF-ranked `matches[]` list with `found_in` provenance and `query_stats` — and its verification run confirmed code, tests, build, and the live `hybrid-search` spec all agree. The same run found four documentation tails that still teach the retired two-list `{ semantic_matches, lexical_matches }` shape or point at paths missing from a fresh clone. Every session that reads those docs (including the vault's own agent instructions) is being taught a contract the server no longer returns; the drift compounds with each release, so it gets cleaned up now while the verification evidence is fresh.

## What Changes

**mcp-tool-surface spec — lexical-only scenario**
- From: scenario "lexical-only search is reachable through search_notes" asserts the response's `lexical_matches` provides exact-match results with `semantic_matches: []` (`openspec/specs/mcp-tool-surface/spec.md:95-98`)
- To: the scenario asserts `matches[]` entries with lexical-only provenance — `found_in` containing only `lexical:*` values — carrying `lexical[]` evidence, consistent with the hybrid-search spec's response contract
- Reason: the live hybrid-search spec (`spec.md:151`, `:166`) forbids `semantic_matches`/`lexical_matches` in responses; the two main specs currently contradict each other
- Impact: non-breaking — spec text only; server behavior already conforms

**rank-fusion.md design-decision link**
- From: `docs/architecture/rank-fusion.md:39` links D3 to `openspec/changes/search-notes-unified-rank/design.md`, a pre-archive path absent from a fresh clone
- To: link points to the committed archive copy `openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md`
- Reason: broken pointer in the living architecture record
- Impact: non-breaking, docs only

**Untracked pre-archive leftovers**
- From: `openspec/changes/polish-fused-response-contract/` sits untracked, diverging from its committed archive (`archive/2026-08-10-polish-fused-response-contract/` has `retrospective.md`, `verify.md`, and differing spec/tasks). (The four dirs named in the source vault note are already gone; this is the same failure mode recurred.)
- To: the untracked directory is deleted; the committed archive remains the single record
- Reason: two diverging copies of a change record invite citing the stale one
- Impact: non-breaking — removes untracked files only

**Vault `AGENTS.md` retrieval section (vault-side, outside this repo)**
- From: four spots teach `{ semantic_matches, lexical_matches }`, including "read `lexical_matches` BEFORE reformulating"
- To: retrieval guidance rewritten around `matches[]` + `found_in` + per-entry `lexical[]` evidence + `query_stats`; the cross-leg-agreement signal restated as `found_in` containing both `semantic` and `lexical:*`
- Reason: the vault's agent instructions actively teach every session a response shape the server no longer returns
- Impact: non-breaking; live MCP sessions must reconnect the server after the edit (running processes hold the old contract)

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-tool-surface`: the lexical-only reachability scenario's THEN-clause is restated against the fused `matches[]` response contract (no requirement-level behavior change — the requirement text itself already matches shipped behavior; only the scenario contradicts it)

## Impact

- `openspec/specs/mcp-tool-surface/spec.md` — scenario rewrite (via delta spec + sync at archive)
- `docs/architecture/rank-fusion.md` — one link fix
- `openspec/changes/polish-fused-response-contract/` — deleted (untracked)
- Obsidian vault `AGENTS.md` — retrieval-section rewrite via vault MCP (outside repo; flagged task)
- No code, no tests, no tool behavior, no release required
