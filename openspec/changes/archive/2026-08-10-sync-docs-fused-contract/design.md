## Context

Release 14.0.0 (2026-08-10) replaced the `search_notes` two-list response (`{ semantic_matches, lexical_matches }`) with a single RRF-ranked `matches[]` list carrying per-entry `found_in` provenance, per-source evidence (`similarity`/`blocks[]`, `lexical[]`, `expansion_similarity`), and `query_stats` for array queries. The release verification run confirmed code, tests, build, and the live `hybrid-search` spec are aligned, and identified four documentation locations still describing the old contract or pointing at nonexistent paths. A private vault task note is the source of record; this session re-verified all four against current state (see brainstorm.md).

Constraints: `openspec/changes/archive/` and `docs/superpowers/` are historical records and intentionally keep old wording; main-spec edits must go through a delta spec and `/opsx:sync`; the vault `AGENTS.md` lives outside the repo's edit roots.

## Goals / Non-Goals

**Goals:**
- Every living document (main specs, `docs/architecture/`, vault agent instructions) describes the fused `matches[]` contract, and only that
- Cross-references in living docs resolve in a fresh clone
- `openspec/changes/` contains no untracked directories that diverge from committed archive copies

**Non-Goals:**
- No code, schema, or test changes — the implementation already conforms
- No rewriting of historical records (`openspec/changes/archive/`, `docs/superpowers/`)
- No restructuring of the vault AGENTS.md beyond the retrieval-vocabulary sentences (mode/effort axes, decision table, UA+EN advice stay as-is)
- No release — docs-only, nothing published to npm changes

## Decisions

### D1: Generalize the leftover-directory cleanup to the failure mode, not the four named dirs
- **Choice**: delete any untracked pre-archive change directory diverging from a committed archive copy — today exactly `polish-fused-response-contract/`
- **Rationale**: the four dirs the note names are already gone; the same condition recurred with a newer change. The note's intent is corpus hygiene, not a literal list.
- **Alternative considered**: declare item 3 done (dirs gone) — rejected: leaves the same bug live under a different name
- Tracked `restore-list-properties/` (active change) and this change's own directory are untouched.

### D2: Keep the vault-side AGENTS.md edit inside this change, as a flagged task
- **Choice**: one task explicitly marked vault-side, executed from the main session via vault MCP (`edit_note` on path `AGENTS.md`) or direct file edit — not inside a worktree
- **Rationale**: the four items are one coherent unit found by one verification run; splitting orphans the vault half
- **Alternative considered**: separate vault chore — rejected as ceremony without benefit
- Follow-up baked into the task: live MCP sessions must reconnect the server after the edit, since running processes hold the old instructions.

### D3: Rewrite the mcp-tool-surface scenario by mirroring hybrid-search phrasing
- **Choice**: THEN-clause asserts `matches[]` entries whose `found_in` contains only `lexical:*` values, with `lexical[]` evidence present — phrasing borrowed from hybrid-search's own lexical-mode scenarios
- **Rationale**: two main specs describing one response must use one vocabulary; inventing parallel phrasing reintroduces drift
- **Alternative considered**: delete the scenario (redundant with hybrid-search) — rejected: it guards a different requirement (no standalone lexical tool; `search_notes` is the single entry point)
- Mechanics: delta spec under `specs/mcp-tool-surface/` in this change, with the identical text applied to the main spec in-branch; the archive-time sync (`/opsx:sync`) is then a byte-identical no-op, matching how polish-fused-response-contract handled hybrid-search.

### D4: AGENTS.md — targeted sentence rewrite, not a section rework
- **Choice**: replace only the sentences naming the old shape; describe `matches[]`, `found_in` provenance, per-entry `lexical[]` evidence, and `query_stats` (with `lexical_tokens` on zero-hit multi-token queries)
- **Rationale**: the section's structure (engines, table, anti-patterns) is sound; only the response vocabulary is stale
- **Alternative considered**: full retrieval-section rewrite — rejected: churn without information gain, and the vault file is user-facing config where diffs should stay reviewable
- Semantic translations: "hit in BOTH legs = strong signal" → "`found_in` containing both `semantic` and `lexical:*`"; "lexical items carry no score, order + `matched_in` is the ranking" → superseded by RRF ranking; "read `lexical_matches` before reformulating" → "check `found_in` provenance and `query_stats` before reformulating".

## Risks / Trade-offs

- [Risk] Grep sweep for stale vocabulary flags historical records → Mitigation: exclude `openspec/changes/archive/` and `docs/superpowers/` explicitly; they are correct as history
- [Risk] Vault AGENTS.md edit propagates only after server restart; sessions started before the edit keep teaching the old shape → Mitigation: the task ends with an explicit "reconnect MCP in live sessions" step surfaced to the user
- [Risk] Deleting `polish-fused-response-contract/` loses local-only content → Mitigation: verified divergence direction first — the committed archive is the superset (has `retrospective.md`, `verify.md`); diff before delete is part of the task
- [Trade-off] Scenario rewrite goes through the full delta-spec + sync machinery for a few lines → accepted: main-spec text is contract record; the machinery is what keeps it authoritative

## Migration Plan

N/A — docs-only; no deployment, no release. Rollback is `git revert` for repo files and vault file history (Obsidian sync) for `AGENTS.md`. Acceptance: `npm test`, `npm run lint`, `npm run typecheck` green; `openspec validate --all` passes; grep for `semantic_matches|lexical_matches` over living docs/specs (excluding archive + superpowers) returns no hits outside negative assertions (spec sentences forbidding those keys); the rank-fusion D3 link resolves in a fresh clone; `git status` shows no untracked pre-archive change dirs.

## Open Questions

None — all forks resolved in brainstorm (Q1-Q4).
