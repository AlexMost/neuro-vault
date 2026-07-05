# Verification Report

> This file is produced by the verification step after apply completes, to
> confirm the implementation matches specs / design / tasks. Failed checks
> must be fixed in the corresponding artifact and verify re-run.

**Change**: `hybrid-search-notes`
**Verified at**: `2026-07-06`
**Verifier**: subagent-driven-development controller (opsx apply)

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result:**

```text
baseline                  spec    valid=True
hybrid-search-notes       change  valid=True
mcp-tool-surface          spec    valid=True
read-notes-content-modes  spec    valid=True
tolerant-arguments        spec    valid=True
```

One issue was found and fixed during verification: the `filter applies
identically to both legs` requirement in `specs/hybrid-search/spec.md` had its
`SHALL` on the second body line, but `openspec validate` inspects only the
first body line after the `### Requirement:` header (`validator.js`
`getRequirementText`). Reworded to lead the body with `SHALL` (meaning
unchanged) in commit `7386fe5`. Re-validation is clean.

| Item | Type | Issues |
|---|---|---|
| — | — | none (after fix) |

---

## 2. Task Completion (`tasks.md`)

- [x] All `- [ ]` are now `- [x]` (20/20)

**Incomplete tasks:** none.

| Task | Reason | Blocks archive? |
|---|---|---|
| — | — | — |

Note: tasks.md item 2.4 mentions an optional *lazy tier-cascade with early
exit + output-equivalence test*. Per design D8 and the spec ("An
implementation MAY evaluate tiers lazily"), this is an optional optimization,
deliberately **not** implemented — the full `rankNotes` evaluation is the
reference semantics. The determinism and tiering requirements the checkbox
covers are satisfied. Not a coverage gap.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
|---|---|---|
| hybrid-search | ✗ Needs sync | New capability; `openspec/specs/hybrid-search/` does not exist yet — `openspec archive` will create it. |
| mcp-tool-surface | ✗ Needs sync | Existing `openspec/specs/mcp-tool-surface/spec.md`; the ADDED delta requirement will be merged by `openspec archive`. |

Both are expected to be unsynced at verify time — sync is an archive-step
action, not a blocker.

---

## 4. Design / Specs Coherence Spot Check

| Sample | design.md | specs mapping | Drift |
|---|---|---|---|
| D2 orthogonal axes | `mode: hybrid\|lexical` × `effort: quick\|deep`, old values rejected | Req "Input axes mode and effort are orthogonal" + scenarios | none |
| D5/D7 hand-rolled matcher, 6 tiers | tiers → density → backlink → path, deterministic | Req "Lexical ranking is deterministic and tiered" | none |
| D3 grouped result shape | `{ path, backlink_count, vault, matched_queries?, matches[] }`, no score | Req "Lexical results are grouped per note…" | none |
| D9 mtime cache freshness | per-request scan + mtime cache, no index | Req "Lexical corpus freshness without an index" | none |
| D1 single tool, symmetric response | both legs in one response | Req "search_notes returns a symmetric hybrid response" | none |

**Drift warnings (non-blocking):** none.

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [x] All related commits are on the branch

**Commit range:** `27034dc..7386fe5` (branch `worktree-hybrid-search-notes`,
14 commits: OpenSpec artifacts, 11 plan tasks, a determinism refactor, and the
spec-validation fix). Full gates green at HEAD: `npm test` 758 passed,
`npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` OK.

---

## 6. Front-Door Routing Leak Detector (warning, non-blocking)

- [x] Files exist in `docs/superpowers/specs/` but are legitimate
      pre-schema-install content.

**Leak list:**

| File(s) | Content captured in change? | Suggested action |
|---|---|---|
| `docs/superpowers/specs/*.md` (36 files, dated 2026-04…) | N/A — frozen pre-OpenSpec record | Leave as-is |

These 36 files are the repo's **frozen pre-OpenSpec record** (project context:
"`docs/superpowers/specs/` + `plans/` — FROZEN pre-OpenSpec record (do not add
to it)"). They predate this change and this schema install. This cycle's
brainstorm/design correctly live in `openspec/changes/hybrid-search-notes/`
(`brainstorm.md`, `design.md`) — no leak from this cycle. Non-blocking.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains **no** `[~]` deferred rows — every task ran and committed.
The end-to-end sanity checks the plan called for (Task 11) were implemented as
automated tests (`test/semantic/tools/search-notes-e2e.test.ts`: intersection,
Ukrainian apostrophe/case, filter-binds-both-legs, lexical-only cold corpus),
not deferred manual dogfood. Section is N/A (blank = PASS).

| Deferred dogfood | Equivalent automated test | Coverage | Real gap? |
|---|---|---|---|
| — (none) | — | — | — |

---

## Overall Decision

- [x] ⚠️ PASS WITH WARNINGS — may proceed to finishing-a-development-branch
      and archive.

**Warnings (all non-blocking):**

1. `docs/superpowers/specs/` holds 36 frozen pre-OpenSpec files — legitimate,
   predates this change; leave as-is.
2. Delta specs not yet synced into `openspec/specs/` — this is the archive
   step's job; run `openspec archive` next.

**Next step:** write `retrospective.md`, then `openspec archive -y`, then open
the PR via `finishing-a-development-branch`.
