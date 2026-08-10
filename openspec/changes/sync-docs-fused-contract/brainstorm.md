<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — sync-docs-fused-contract

## Background

Release 14.0.0 (2026-08-10) shipped the unified `search_notes` response contract:
one RRF-ranked `matches[]` list with per-entry `found_in` provenance and
`query_stats` for array queries, replacing the old two-list
`{ semantic_matches, lexical_matches }` shape. The release verification run
(workflow + skeptic agents, 2026-08-10) confirmed code, tests, build, and the
live `hybrid-search` spec all agree on `matches[]` — and found four documentation
tails that still describe the old contract or point at paths that no longer
exist. The source of record for this change is the vault task note
`Tasks/neuro-vault/Синхронізувати документацію з fused-контрактом.md`.

This brainstorm was not an open design exploration: the vault note arrived with
scope, exact file locations, and exact fixes already converged (it is itself the
distilled output of the verification run). The session's job was to re-verify
each item against current repo/vault state and resolve the one point where state
had moved since the note was written.

## Verification of the four scope items (2026-08-10, this session)

1. **`openspec/specs/mcp-tool-surface/spec.md:95-98`** — CONFIRMED. The scenario
   "lexical-only search is reachable through search_notes" still asserts
   "the response's `lexical_matches` provides the exact-match results … with
   `semantic_matches: []`", contradicting the live hybrid-search spec
   (`spec.md:151`: "The response SHALL NOT contain `semantic_matches`,
   `lexical_matches`, or nested `related[]`"; `:166` scenario asserts absence of
   those keys).
2. **`docs/architecture/rank-fusion.md:39`** — CONFIRMED. Links design decision
   D3 to `openspec/changes/search-notes-unified-rank/design.md`, a pre-archive
   path that no longer exists in the working tree (and was never committed); the
   committed copy lives at
   `openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md`.
3. **Untracked pre-archive leftovers in `openspec/changes/`** — DRIFTED. The four
   directories the note names (search-notes-unified-rank,
   compact-tool-response-contract, inline-tags-in-list-tags,
   migrate-off-obsidian-cli) are already gone. But the same failure mode has
   recurred since the note was written: `openspec/changes/polish-fused-response-contract/`
   is untracked and diverges from its committed archive
   (`archive/2026-08-10-polish-fused-response-contract/` additionally has
   `retrospective.md` + `verify.md`, and `specs/hybrid-search/spec.md` +
   `tasks.md` differ). Decision Q1 below.
4. **Vault-side `AGENTS.md` retrieval section** — CONFIRMED. Four spots still
   teach the old contract: "Returns `{ semantic_matches, lexical_matches }`"
   (Search bullet), "or just read `lexical_matches` off the hybrid response"
   (mode/axis bullet), the anti-pattern "read `lexical_matches` BEFORE
   reformulating … Lexical items carry no score — order and `matched_in` … are
   the ranking", and the session-start step "also surface in `lexical_matches`".

## Decision chain

### Q1 — Item 3 drifted: what does "delete the leftovers" mean now?

Options considered:
- (a) Do nothing — the four named dirs are already gone, call the item done.
- (b) Generalize the item to its failure mode: remove any untracked pre-archive
  change directory that diverges from a committed archive copy — today that is
  exactly `polish-fused-response-contract/`.

**Decision: (b).** The note's intent is corpus hygiene ("pre-archive dirs
diverging from committed archive versions"), not the four literal names; the
same condition has simply recurred with a newer change. `restore-list-properties/`
is tracked (an active change) and stays; the in-flight `sync-docs-fused-contract/`
(this change) obviously stays.

### Q2 — Is the vault-side AGENTS.md edit in scope for a repo-local opsx change?

The change's `allowedEditRoots` is the repo, and the vault file lives outside
it. Options: split item 4 into a separate vault chore, or keep it as an
explicit task flagged as vault-side (executed via the vault MCP / direct edit
from the main session, not inside a worktree).

**Decision: keep it in this change as a flagged task.** The four items are one
coherent unit ("docs caught up with the fused contract") found by one
verification run; splitting would orphan the vault half. The task must state
that it edits the vault's `AGENTS.md` (the Obsidian vault root file, reachable
via `mcp__neuro-vault__read_notes`/`edit_note` on path `AGENTS.md`), and that
after the edit live MCP sessions need the server reconnected, because running
server processes hold the old contract description.

### Q3 — What replaces the old text in the mcp-tool-surface scenario?

Rewrite the scenario THEN-clause against the live fused contract: lexical-mode
response returns `matches[]` where every entry carries lexical-only provenance
(`found_in` containing only `lexical:*` values, no `semantic` source since that
leg did not run), with `lexical[]` evidence per entry — mirroring
hybrid-search's own lexical-mode scenarios rather than inventing new phrasing.
This is a spec-file edit, so it goes through a delta spec (`specs/mcp-tool-surface/`)
and an `/opsx:sync` at archive time, same as the polish-fused-response-contract
change did for hybrid-search.

### Q4 — AGENTS.md rewrite: minimal token swap or retrieval-section rework?

The section's guidance is structurally sound (engines, decision table,
anti-patterns); what is wrong is the response-shape vocabulary. **Decision:
targeted rewrite of the affected sentences only** — describe `matches[]` +
`found_in` provenance + per-entry `lexical[]` evidence + `query_stats` (with
`lexical_tokens` on zero-hit multi-token queries) where the old two-list
vocabulary appears, keep everything else (mode/effort axes, UA+EN multi-query
advice, table) untouched. The "both legs hit = strong signal" advice translates
cleanly to "`found_in` containing both `semantic` and `lexical:*` = strong
signal". The "no score on lexical items" caveat is superseded: fused entries
are RRF-ranked, so the guidance becomes "check `found_in` / `query_stats` before
reformulating".

## Design trade-offs

- **Why opsx and not a direct PR:** item 1 edits a main capability spec
  (`openspec/specs/mcp-tool-surface/`) — contract-record territory per
  `.claude/rules/opsx-routing.md` — and the user explicitly invoked
  `/opsx:propose`. The rest rides along as one coherent docs-sync unit.
- **No code changes anywhere.** Code/tests/build already conform (verified at
  release). Acceptance is documentation consistency: `npm test`, `npm run lint`,
  `npm run typecheck` stay green (they never touched these files), grep sweeps
  for `semantic_matches`/`lexical_matches` in docs/specs come back clean
  (excluding archive/ and the frozen `docs/superpowers/` record, which are
  historical), `openspec validate --all` passes, and the rank-fusion.md link
  resolves in a fresh clone.
- **Archive dirs are historical record** — `openspec/changes/archive/` and
  `docs/superpowers/` intentionally keep the old contract wording; sweeps must
  exclude them.

## Promotion criteria check (all 5 hold)

1. Scope locked — four items, one sentence each, verified above.
2. Design forks resolved — Q1-Q4 decided; no open TBDs.
3. Cross-system deps mapped — repo (ready), vault via MCP (ready), no unknowns.
4. Acceptance criteria stateable — see trade-offs bullet above.
5. Converging — the source note is itself the converged record; this session
   only re-verified and resolved drift.
