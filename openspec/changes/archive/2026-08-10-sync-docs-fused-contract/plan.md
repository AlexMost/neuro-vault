# sync-docs-fused-contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every living document — the mcp-tool-surface main spec, `docs/architecture/rank-fusion.md`, and the vault's `AGENTS.md` — in line with the fused `search_notes` contract (`matches[]` + `found_in` + `query_stats`), and remove the stale untracked pre-archive change directory.

**Architecture:** Docs-only change; no code, tests, or build output are touched. The main-spec edit is governed by the delta spec at `openspec/changes/sync-docs-fused-contract/specs/mcp-tool-surface/spec.md`. Tasks 1–2 are repo edits (worktree-safe). Task 3 edits a file OUTSIDE the repo (the Obsidian vault root `AGENTS.md`) and MUST run from the main session, not a worktree.

**Tech Stack:** Markdown, OpenSpec CLI, `grep`, vault MCP (`mcp__neuro-vault__read_notes` / `edit_note`).

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must stay green (they never read these files; any failure means an unrelated regression — stop and report).
- `openspec/changes/archive/` and `docs/superpowers/` are historical records — NEVER edit them, and exclude them from sweeps.
- Commits follow Conventional Commits; PR to `main` via `gh pr create`, never a direct push.
- Vault notes are Ukrainian; the vault `AGENTS.md` is English — keep each file's existing language.

---

### Task 1: Rewrite the lexical-only scenario in the mcp-tool-surface spec

**Files:**
- Modify: `openspec/specs/mcp-tool-surface/spec.md:95-98`
- Reference: `openspec/changes/sync-docs-fused-contract/specs/mcp-tool-surface/spec.md` (delta spec — the target wording)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: a main spec consistent with `openspec/specs/hybrid-search/spec.md:151` ("SHALL NOT contain `semantic_matches`, `lexical_matches`")

- [ ] **Step 1: Replace the scenario THEN-clause**

In `openspec/specs/mcp-tool-surface/spec.md`, replace exactly:

```markdown
#### Scenario: lexical-only search is reachable through search_notes

- **WHEN** a caller needs exact text matches only and calls `search_notes` with `{ query: "<term>", mode: "lexical" }`
- **THEN** the response's `lexical_matches` provides the exact-match results a standalone tool would have returned, with `semantic_matches: []`
```

with:

```markdown
#### Scenario: lexical-only search is reachable through search_notes

- **WHEN** a caller needs exact text matches only and calls `search_notes` with `{ query: "<term>", mode: "lexical" }`
- **THEN** the response's `matches[]` provides the exact-match results a standalone tool would have returned — every entry's `found_in` contains only `lexical:*` values and the entry carries `lexical[]` evidence, per the hybrid-search response contract (no `semantic_matches` or `lexical_matches` keys)
```

- [ ] **Step 2: Validate**

Run: `npx openspec validate --all`
Expected: every spec and change reports valid.

- [ ] **Step 3: Sweep for other stale vocabulary in living docs**

Run: `grep -rn "semantic_matches\|lexical_matches" docs/ openspec/specs/ README.md --exclude-dir=superpowers`
Expected: no output. If a hit appears outside `openspec/changes/archive/`, fix it with the same `matches[]`/`found_in` vocabulary and re-run until clean; report each extra fix in the task summary.

- [ ] **Step 4: Commit**

```bash
git add openspec/specs/mcp-tool-surface/spec.md
git commit -m "docs(spec): restate lexical-only search_notes scenario against fused matches[] contract"
```

---

### Task 2: Fix the rank-fusion D3 link and delete the stale pre-archive directory

**Files:**
- Modify: `docs/architecture/rank-fusion.md:39`
- Delete: `openspec/changes/polish-fused-response-contract/` (untracked)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: a D3 link that resolves in a fresh clone; a clean `git status`

- [ ] **Step 1: Fix the link**

In `docs/architecture/rank-fusion.md` line 39, replace the substring:

```
openspec/changes/search-notes-unified-rank/design.md
```

with:

```
openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md
```

- [ ] **Step 2: Verify the target exists**

Run: `ls openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md`
Expected: the path is listed (no "No such file" error).

- [ ] **Step 3: Confirm divergence direction, then delete the leftover directory**

Run: `diff -rq openspec/changes/polish-fused-response-contract openspec/changes/archive/2026-08-10-polish-fused-response-contract`
Expected: differences exist only as archive-side additions (`retrospective.md`, `verify.md`) and drifted copies of `specs/hybrid-search/spec.md` / `tasks.md` — i.e. the committed archive is the superset/newer record. If the untracked dir contains a file the archive lacks, STOP and surface it to the user instead of deleting.

Then: `rm -rf openspec/changes/polish-fused-response-contract`

- [ ] **Step 4: Verify git status**

Run: `git status --porcelain`
Expected: no `??` entries under `openspec/changes/` except `openspec/changes/sync-docs-fused-contract/` (this change).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/rank-fusion.md
git commit -m "docs(architecture): point rank-fusion D3 link at committed archive path"
```

(The directory deletion involves only untracked files — nothing to commit for it.)

---

### Task 3: Rewrite the vault AGENTS.md retrieval vocabulary (MAIN SESSION ONLY — outside repo)

**Files:**
- Modify: Obsidian vault root `AGENTS.md` (via `mcp__neuro-vault__edit_note` on path `AGENTS.md`, or direct edit of the vault file; NOT a repo file — do not run in a worktree)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: vault agent instructions that describe `{ matches, truncated }` + `query_stats`

Make exactly these four sentence-level replacements; touch nothing else in the file.

- [ ] **Step 1: Search-bullet response shape**

Replace:

```
- **Search** (`search_notes`) — one hybrid entry, two legs, two axes. Returns `{ semantic_matches, lexical_matches }`.
```

with:

```
- **Search** (`search_notes`) — one hybrid entry, two legs, two axes. Returns `{ matches, truncated }` (+ `query_stats` for array queries): one RRF-ranked list where each entry's `found_in` names every source that surfaced it (`semantic`, `lexical:title|heading|body`, `expansion`).
```

- [ ] **Step 2: Mode-bullet lexical routing + both-legs signal**

Replace:

```
  - Request names a CONCEPT / THEME → default `hybrid`. Request names an EXACT string — a name, code, identifier, term, filename, `SHOPEX`-ish token → still `search_notes`, reach for `mode: "lexical"` (or just read `lexical_matches` off the hybrid response). **Don't escape to `Grep` for exact matches — the lexical leg is that channel.** A note landing in BOTH legs is a strong relevance signal.
```

with:

```
  - Request names a CONCEPT / THEME → default `hybrid`. Request names an EXACT string — a name, code, identifier, term, filename, `SHOPEX`-ish token → still `search_notes`, reach for `mode: "lexical"` (or filter hybrid `matches[]` by `found_in` containing `lexical:*`). **Don't escape to `Grep` for exact matches — the lexical leg is that channel.** An entry whose `found_in` holds both `semantic` and a `lexical:*` value is a strong relevance signal.
```

- [ ] **Step 3: Anti-pattern bullet**

Replace:

```
- Hybrid semantic came back as noise → read `lexical_matches` BEFORE reformulating; exact terms live there. Lexical items carry no score — order and `matched_in` (title > heading > body) are the ranking.
```

with:

```
- Hybrid came back as noise → check `found_in` provenance and `query_stats` BEFORE reformulating; exact-term hits carry `lexical:*` provenance with per-entry `lexical[]` evidence (`matched_in`: title > heading > body). For zero-hit multi-token queries, `query_stats` adds `lexical_tokens` showing which token failed.
```

- [ ] **Step 4: Session-start bullet**

Replace:

```
Named handles (projects, Jira IDs, product names) also surface in `lexical_matches` — a strong signal when they land there too.
```

with:

```
Named handles (projects, Jira IDs, product names) also carry `lexical:*` provenance in `found_in` — a strong signal when they land there too.
```

- [ ] **Step 5: Verify**

Read the file back (`mcp__neuro-vault__read_notes` path `AGENTS.md`) and confirm: zero occurrences of `semantic_matches` or `lexical_matches`; the four new sentences present; no other lines changed.

- [ ] **Step 6: Surface the reconnect requirement**

Tell the user verbatim in the summary: live sessions using the neuro-vault MCP server must reconnect it (old server processes and already-primed sessions still hold the two-list contract description).

---

### Task 4: Final verification

**Files:** none modified

**Interfaces:**
- Consumes: all prior tasks complete
- Produces: evidence block for verify.md

- [ ] **Step 1: Full check suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass (docs-only change; a failure is an unrelated regression — stop and report).

- [ ] **Step 2: OpenSpec validation**

Run: `npx openspec validate --all`
Expected: all valid.

- [ ] **Step 3: Vocabulary + link sweep**

Run:
```bash
grep -rn "semantic_matches\|lexical_matches" docs/ openspec/specs/ README.md --exclude-dir=superpowers; ls openspec/changes/archive/2026-08-08-search-notes-unified-rank/design.md; git status --porcelain
```
Expected: grep prints nothing; `ls` finds the file; git status shows only this change's directory (until committed) and intended modifications.

- [ ] **Step 4: Commit any remaining artifact updates and open the PR**

```bash
git add openspec/changes/sync-docs-fused-contract
git commit -m "docs(openspec): add sync-docs-fused-contract change artifacts"
gh pr create --title "docs: sync living docs with fused search_notes contract" --body "$(cat <<'EOF'
## Summary
- restate mcp-tool-surface lexical-only scenario against the fused matches[] contract (delta spec included)
- fix rank-fusion.md D3 link to the committed archive path
- remove stale untracked pre-archive dir polish-fused-response-contract/
- (vault-side, outside this repo) AGENTS.md retrieval section rewritten to matches[] + found_in + query_stats

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opened against `main`.
