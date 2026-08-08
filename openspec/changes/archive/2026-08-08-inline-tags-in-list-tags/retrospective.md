# Retrospective: inline-tags-in-list-tags

> Written: 2026-08-08 (after verify passed)
> Commit range: `a2604ed..f26b113`
> Worktree: `.claude/worktrees/inline-tags-in-list-tags` (branch `worktree-inline-tags-in-list-tags`, pre-PR)

---

## 0. Evidence

- **Commit range**: `a2604ed..f26b113` (8 commits)
- **Diff size**: +966 / −9 lines across 16 files (excluding change artifacts: +225 / −9 across 9 files)
- **Tasks done**: 9/9 (`grep -cE '^\s*- \[x\]' tasks.md` → 9)
- **Active hours**: ~1.5 h wall-clock for the full propose → apply → verify cycle (single session, 2026-08-08)
- **Subagent dispatches**: 12 (5 implementers, 5 task reviewers incl. 1 re-review, 1 fix round via resumed implementer, 1 final whole-branch reviewer) + 1 planning-phase Explore agent
- **New external dependencies**: none (`mdast-util-from-markdown` and `@types/mdast` already present)
- **Bugs encountered post-merge**: none (pre-merge; 1 pre-merge defect caught by task review — see §1)
- **OpenSpec validate state at archive**: pass (9/9 items)
- **Test coverage signal**: vitest 841/841 passing at head (819 at base; +22 tests: 15 extractor unit, 7 provider/overview disk-integration)

Commit chain (時序):

```
a2604ed chore(release): 13.0.1                                            (base, main)
6f5628d docs(openspec): add inline-tags-in-list-tags change artifacts
54742f7 feat(tags): add inline #tag extractor over mdast
6d2576f fix(tags): enforce tag boundary across mdast text-node splits
f2d0f52 feat(tags): count inline body #tags in list_tags, dedup per note
e3533c8 test(overview): pin inline-only tags flowing into top_tags
4f52357 docs(tools): state list_tags counting vs tags-filter asymmetry
26348ca docs: record inline-tag counting follow-up in ADR-0009 and query notes
f26b113 docs(openspec): check off completed tasks for inline-tags-in-list-tags
```

---

## 1. Wins

- The per-task review gate caught a real correctness bug the plan itself shipped (§0: `6d2576f`). The plan's reference regex used a per-text-node `(?<=^|\s)` lookbehind; the Task 1 reviewer empirically demonstrated false positives for `*bold*#glued` / `[text](url)#glued` (mdast splits text at markup boundaries, so `^` matches mid-line). One fix round replaced it with a document-offset boundary check + 2 pinning tests. This is the review loop doing exactly what it exists for — the 13 planned unit tests all passed while the bug was live.
- Planning-phase exploration (single Explore agent) surfaced the memory constraint (`vault-reader.ts:144-146` deliberately drops bodies) and the guarded shared helper (`extractTags` pinned by three contract surfaces) before design, so D1 (separate extractor, filters untouched) and D4 (batched scan) were locked pre-implementation and survived contact with the code unchanged.
- Complete-code-in-plan made 3 of 5 implementer dispatches viable on the cheapest model tier; the whole cycle ran 12 subagents with only one fix round total.
- Per-note dedup fix for duplicated frontmatter entries (`tags: [alpha, alpha]` → 1) rode along inside the same requirement instead of becoming a second change; pinned by an explicit spec scenario (§0: `f2d0f52`).
- The originating vault task note's own smoke repro (frontmatter `ttag` + inline `#fsprovider-smoke`) was executed as the final acceptance check and passed (Task 5 report), closing the loop with the exact failure that motivated the change.

## 2. Misses

- 🟡 [painful | evidence: task-1 review round, `6d2576f`] The plan embedded a subtly wrong reference implementation, and the plan's own test list couldn't catch it (all 13 cases exercised single-text-node inputs). Complete-code-in-plan is a transcription accelerant but concentrates correctness risk in the plan author; the mdast text-node-splitting behavior was knowable at planning time.
- 📌 [nit | evidence: final review Minor 1] Escaped `\#tag` counts as a tag — outside the spec's exclusion list, rare in real vaults, but a fidelity edge the grammar decision (D2) didn't consider. Follow-up.
- 📌 [nit | evidence: final review Minor 2] `search_notes`'s `tags` pre-filter description doesn't say "frontmatter only"; the spec scenario only mandated `list_tags` + `query_notes` wording, leaving the third tag-filter surface without the asymmetry note. Follow-up.
- 📌 [nit | evidence: final review Minor 3] No single end-to-end test pairs "`list_tags` reports X" with "`query_notes {tags: X}` matches nothing" — the asymmetry scenario is covered compositionally by two suites rather than pinned in one place.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 1 (extractor) | Boundary check redesigned: plain-regex lookbehind → document-offset preceding-character check; +2 tests beyond the plan's 13; redundant empty-body fast-path removed | Reviewer-demonstrated false positives at mdast text-node boundaries (D2 grammar violation); plan's Global Constraints govern over its reference code |
| Task 3 (overview test) | Setup shape copied from the file's first test rather than the adjacent third test | Both shapes coexist in the file; stylistic judgment call, flagged by reviewer as no-action |
| All others | Executed as written | — |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (adapted to opsx one-shot: single AskUserQuestion resolved the task note's one open question; decision log captured in brainstorm.md) |
| superpowers:writing-plans                        | ✓ (output redirected to change plan.md per bridge schema) |
| superpowers:using-git-worktrees                  | ✓ (native EnterWorktree; baseline 819 tests green before Task 1) |
| superpowers:subagent-driven-development          | ✓ (5 tasks, fresh implementer + task reviewer each, ledger in `.superpowers/sdd/progress.md`) |
| (transitive) superpowers:test-driven-development | ✓ (RED→GREEN evidence in every implementer report; Task 3's pin-test RED waived by plan design — wiring already existed) |
| (transitive) superpowers:requesting-code-review  | ✓ (per-task reviews + final whole-branch review on most capable model: "Ready to merge: Yes") |
| superpowers:finishing-a-development-branch       | ✓ (invoked after archive; PR to `main`) |

### Deliberately Skipped Skills

(none — 整節空白,全綠)

## 5. Surprises

- mdast splits paragraph text into separate `text` nodes at every inline-markup boundary, and the markup characters appear in **no** text node's value — so "start of text node" is routinely mid-line. Any per-node regex anchor is wrong by construction; boundary decisions need document offsets (`node.position.start.offset`).
- The overview wiring pin-test passed first-run with zero production changes — `top_tags` delegation through `provider.listTags()` meant the whole `get_vault_overview` half of the task note's ask was free once `listTags` changed.
- `npm test` count moved 819 → 841 with only 22 added tests and zero collateral failures — the frontmatter-only contract turned out to be pinned in exactly one test (`'counts frontmatter tags only, ignoring inline #tags'`), not scattered.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Complete-code-in-plan needs an adversarial-input test row** → **Promote to memory** (type: feedback)
  > **Why**: This cycle's plan embedded a boundary bug (`6d2576f`) that its own 13 planned tests couldn't catch, because plan-authored tests share the plan author's mental model; only the reviewer's out-of-model inputs (`*bold*#glued`) exposed it.
  > **How to apply**: When writing plan.md with full reference code for parser/extractor-like logic, add test cases derived from the *underlying library's* segmentation/tokenization behavior (not just the feature spec), or explicitly note the input class the tests don't cover.

- [ ] 📌 **Tag-asymmetry text lives in three places** → **One-off** (記錄即可,不 promote)
  > **Why**: `list-tags.ts`, `query-notes.ts`, and the spec each now state the counting-vs-filtering asymmetry; a future change extending filters to inline tags must update all three (final review flagged this as the checklist for that future change).
  > **How to apply**: Recorded in the archived change (this retro + final review); the future D1-alternative change's proposal should cite it.

- [ ] 📌 **Follow-up bundle: `\#` escape edge, `search_notes` wording, asymmetry e2e test, read-error logging parity** → **One-off** (spawned as a background task suggestion at cycle end; direct-PR scope, no opsx)
  > **Why**: Four shippable-as-is Minors from reviews (§2) — none violates a spec scenario, together they're one small polish PR.
  > **How to apply**: Next touch of `inline-tags.ts` / tool descriptions, or the spawned follow-up task.
