## 1. Repo docs and spec

- [x] 1.1 Rewrite the "lexical-only search is reachable through search_notes" scenario in `openspec/specs/mcp-tool-surface/spec.md` (lines ~95-98) per the delta spec in this change: `matches[]` with lexical-only `found_in` (`lexical:*` values only) and `lexical[]` evidence; drop the `lexical_matches`/`semantic_matches: []` wording. Run `openspec validate --all` after.
- [x] 1.2 Fix the D3 link in `docs/architecture/rank-fusion.md` (line ~39): `openspec/changes/search-notes-unified-rank/design.md` → `openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md`. Verify the target file exists.
- [x] 1.3 Sweep living docs for stale contract vocabulary: `grep -rn "semantic_matches\|lexical_matches" docs/ openspec/specs/ README.md --exclude-dir=superpowers` (archive dirs are historical and stay). Fix any hit that isn't in this task list already; record a clean result.

## 2. Pre-archive leftover cleanup

- [x] 2.1 Confirm divergence direction, then delete the untracked `openspec/changes/polish-fused-response-contract/` directory (committed archive `openspec/changes/archive/2026-08-10-polish-fused-response-contract/` is the superset: it adds `retrospective.md` + `verify.md`). Afterwards `git status` must show no untracked pre-archive change dirs other than this change's own directory.

## 3. Vault-side AGENTS.md (outside repo — run from main session, NOT in a worktree)

- [x] 3.1 Rewrite the stale retrieval sentences in the Obsidian vault's root `AGENTS.md` (via `mcp__neuro-vault__edit_note` on path `AGENTS.md`, or direct file edit): (a) Search bullet "Returns `{ semantic_matches, lexical_matches }`" → returns `{ matches, truncated }` (+ `query_stats` for array queries), one RRF-ranked list with per-entry `found_in` provenance; (b) mode bullet "read `lexical_matches` off the hybrid response" → filter `matches[]` by `found_in` containing `lexical:*`; "note landing in BOTH legs" → `found_in` containing both `semantic` and `lexical:*`; (c) anti-pattern "read `lexical_matches` BEFORE reformulating … no score … `matched_in`" → check `found_in` provenance and `query_stats` (incl. `lexical_tokens` on zero-hit multi-token queries) before reformulating; entries are RRF-ranked, lexical evidence sits in per-entry `lexical[]` with `matched_in`; (d) session-start "also surface in `lexical_matches`" → also carry `lexical:*` provenance in `found_in`. Touch nothing else in the file.
- [x] 3.2 Tell the user to reconnect the neuro-vault MCP server in live sessions (running server processes and already-primed sessions hold the old instructions).

## 4. Verification

- [x] 4.1 Run `npm test && npm run lint && npm run typecheck` (must stay green — no code touched) and `openspec validate --all`.
- [x] 4.2 Re-run the grep sweep from 1.3 plus vault-side check (`grep -n "semantic_matches\|lexical_matches"` on the vault `AGENTS.md`) — all clean; confirm the rank-fusion D3 link path exists on disk.
