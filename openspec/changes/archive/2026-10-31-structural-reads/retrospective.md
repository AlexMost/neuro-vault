# Retrospective: structural-reads

> Written: 2026-10-31, after verify passed with warnings
> Commit range: `fa7b6e1..HEAD`, plus the archive commit
> Worktree: `.claude/worktrees/structural-reads-1`. PRs 1–3 are merged to main; PR 4 is on
> `feat/structural-reads-4`.

---

## 0. Evidence

- **Commit range:** `fa7b6e1..HEAD`. That is four squash commits on main (#256–#259) plus this
  branch's commits. Inside them were 36 commits before squash, plus 5 on this branch before the archive.
- **Diff size:** +6,449 / −302 lines across 56 files, before the archive commit.
- **Tasks done:** 21 of 23 at verify time. 4.3 and 4.4 close with the archive commit and PR 4.
- **Active hours:** about 7, on one day. PRs 2–4 ran without the user, under a `/goal`.
- **Subagent dispatches:** about 45.
  - Implementers, one per task or per two-task batch.
  - Task reviewers, fix rounds and scoped re-reviews.
  - Fresh whole-PR reviewers for #258 and #259, and then for this PR.
  - Three Haiku probe runs and a grader.
  - PR 1's review ran in a separate session.
- **New external dependencies:** none.
- **Bugs encountered post-merge:** none so far. CI was green on main after each merge.
- **OpenSpec validate state at archive:** pass (27/27 before archive).
- **Test coverage signal:** vitest. 2,993 tests after PR 1, 3,211 at verify.

Commit chain:

```
fa7b6e1 feat(tools): advertise MCP annotations on every tool (#250)   ← base
9050dd4 feat(corpus): real-line spans with a one-time corpus rebuild, a heading projection (1/4) (#256)
c4e9ac8 fix(corpus): review follow-ups for the heading projection (#257)
f9d3826 feat(read-notes): outline mode (2/4) (#258)
c9df2fa feat(read-notes): heading and line selections (3/4) (#259)
0ac73e1 feat(read-notes): preview carries the note's outline
dc8f960 docs: the structured preview in the description and guide
95e3c40 docs(read-notes): state the preview cut and drop the re-read clause
49a64b2 docs(read-notes): wording fixes from the Haiku probe
<archive> docs(openspec): verify, retrospective and archive structural-reads
```

---

## 1. Wins

- **Shared heading model.** One heading model (`headingBlocks`, PR 1) serves both the chunker
  and the read-time projection. Search evidence therefore reads back with no translation.
  `read-notes-round-trip.test.ts` pins this for every body block, for every non-empty heading,
  for lexical matches including an unclosed fence, and for the frontmatter hand-off.
- **Per-task review caught real defects early.**
  - 3.1+3.2: the coercion recursion silently changed how `search_notes.filter` was parsed.
    Ruling R18 fixed it, and a 2,600-case fuzz over all 14 tool schemas confirmed only
    `read_notes.paths` differs from `f9d3826`.
  - 2.2: the plan's `hidden` rule contradicted its own test (R15).
- **Fresh whole-PR reviewers found what task reviews could not.**
  - PR 2: a squash body line over 100 characters, which would have failed commitlint on main.
  - PR 3: a SHALL scenario (`content` inside an item named in the error) that a green test did
    not actually assert. Fixed in `69550dc`.
- **The Haiku probe paid off.** It scored 17/17 in all three runs, and still surfaced four
  wordings that every run tripped on. All four were fixed before archive (`49a64b2`).

## 2. Misses

- 🟡 [painful | `9050dd4` → `c4e9ac8`] PR 1 was merged before its review landed. The review's
  deferrals then lived only in a follow-up PR body until a re-check moved them into the
  spec, D11 and the plan.
- 🟡 [painful | `a6d6baa`, R21] The plan asked for two `search_notes` lines without checking the
  main hybrid-search spec. That spec caps the description at 3,800 characters and forbids
  enumerating `matches[]` fields. It took a mid-apply delta, with the cap raised to 4,050 for
  one line.
- 🟡 [painful | PR 3 I1] The batch 3.1+3.2 review read the generic union message as out of
  scope (M1). The content-modes spec had a SHALL scenario for it. Deferring it would have
  archived a false scenario.
- 📌 [nit | `0ac73e1`, PR 4 review M1] A bare preview of a note with unparseable YAML returns the
  raw prefix but echoes the body span, which the preview requirement's "starts at the body's
  first line" did not allow. The main spec now carves this case out.
- 📌 [nit | worktree guard] Compound shell commands and a second worktree were refused. That
  cost a few retries, and one wedged cwd recovered with `EnterWorktree`.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 2.2 | `hidden` counts toward the nearest kept ancestor only | The plan's sentence contradicted its own 12×10 test and the spec (R15) |
| 3.1 | Nested coercion only beneath an array, and only for numeric strings | The generic recursion changed `search_notes.filter` (R18) |
| 3.3 | A range inside frontmatter names the frontmatter retry; an unparseable fence points to `full` | Review R2 on #257, and PR 3 review M3 |
| 3.6 | Added the frontmatter-block hand-off and an unclosed fence; CRLF compared minus a trailing `\r` | F1, PR 1 review Minor 5, and R19 |
| 3.7 | One `search_notes` line instead of two, under a hybrid-search delta | The main spec's budget and enumeration rule (R21) |
| 3.x | Tasks dispatched in two-task batches, each with one review | Turn count (R17) |
| PR 3 | `formatZodError` flattens an object item's union issue | The content-modes SHALL scenario (R22) |
| 4.3 | Four description fixes after the probe | Shared confusions across all three runs |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (wayfinder grilling, brainstorm.md) |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN in every implementer report) |
| (transitive) superpowers:requesting-code-review  | ✓ (task reviews and whole-PR reviews) |
| superpowers:finishing-a-development-branch       | ✓ (one PR per group; PR 4 after archive) |

### Deliberately Skipped Skills

None skipped. Two sub-steps were changed:

- **The separate reviewer session for PRs 2–4.**
  - **What was skipped:** the reviewer ran as a fresh-context subagent, not a separate session.
  - **Why this cycle:** these turns were started by a subagent's message. On such a turn the app
    refuses `start_session` with "user_asked", and that refusal was observed on #258.
  - **How to prevent recurrence:** one-off, a harness boundary. The independence is the same,
    since the subagent got no controller context. A session shows up in the sidebar, but it
    cannot be started from an automated turn.
- **Scoped re-review after Minor-only fix rounds.**
  - **What was skipped:** no re-review after some fix rounds that touched only Minors (R14).
  - **Why this cycle:** those rounds had no Important finding, and the implementer had
    mutation-tested them. The whole-PR review covered them next.
  - **How to prevent recurrence:** scope-judgment rule. Re-review every round that touched an
    Important finding, as done for 3.1+3.2 and PR 3.

## 5. Surprises

- The MCP SDK validates arguments against `spec.inputSchema` before our gate runs. Real clients
  get `MCP error -32602` with a zod dump, not the gate's `INVALID_PARAMS` envelope. This
  predates the change, affects every tool, and contradicts `docs/guide/configuration.md`.
- With no required checks, `gh pr merge --auto` merges at once. #257 merged before CI finished,
  and later merges waited on `gh pr checks --watch`.
- zod 4 collapses a failed union over an object to "Invalid input". Naming the bad key needs
  `reportInput` and flattening the union's branch.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A plan that edits a tool description checks that tool's main spec for a budget or
  content rule first** → **Promote to memory** (type: feedback)
  > **Why**: Task 3.7 planned two `search_notes` lines, and the hybrid-search spec's 3,800 cap
  > and its no-enumeration rule surfaced only mid-apply (R21).
  > **How to apply**: during writing-plans, for any task that touches a description, grep
  > `openspec/specs/*/spec.md` for that tool's description requirement.
- [ ] 🟡 **A deferral is valid only if no SHALL scenario in the change's deltas covers it** →
  **Promote to memory** (type: feedback)
  > **Why**: M1 (the generic union message) was deferred while the content-modes delta had a
  > SHALL scenario for it. The PR 3 reviewer caught it.
  > **How to apply**: before ledgering a deferral, grep the change's `specs/` for the behaviour.
- [ ] 📌 **In this repo, wait for CI before a squash merge, because no checks are required**
  → **Promote to memory** (type: project)
  > **Why**: `gh pr merge --auto` merged #257 while CI was pending.
  > **How to apply**: before an autonomous merge, run `gh pr checks <n> --watch` once in the
  > background, then merge with `--match-head-commit`.
- [ ] 🟡 **Route tool validation through the gate for real MCP clients** → **Promote to** a
  follow-up issue
  > **Why**: the SDK's own validation pre-empts the gate's `INVALID_PARAMS` envelope (§5).
  > **How to apply**: as a separate change. Register tools so that SDK validation does not run
  > first, and add an in-process `McpServer` + `Client` test.
