# Retrospective: daemon-lexical-search

> Written: 2026-10-18 (after verify passed with warnings, `verify.md`).
> Commit range of the change: `ac0df5d..HEAD` on branch `claude/modest-cerf-28c63a`, one PR (#184): the propose commit `ac0df5d` plus the implementation, verify and this retrospective.
> Worktree: `.claude/worktrees/per-model-corpus-apply-720f9d` (the checkout the propose session pushed; no new worktree was made).

The change moved `search_notes`' lexical cache out of every stdio session into the shared daemon's vault entry, behind a new `lexical.search` method. Sessions read the leg through `ILexicalReader` (daemon, in-process entry, standalone), share one attachment per vault between the semantic backend and the lexical reader, and attach every registered vault at startup. It is change 2 of 2 of epic #158.

---

## 0. Evidence

- **Commit range**: `ac0df5d..HEAD`, 19 commits before this retrospective: 1 propose, 4 `feat`, 4 `fix`, 3 `refactor`, 2 `test`, 4 `docs`, 1 `chore`.
- **Diff size**: 77 files, +4493 / −479 (`git diff --shortstat ac0df5d..HEAD`, before this file). `src/` 23 files (+1044 / −235 at `807e3cc`), `test/` 29 files (+2831 / −135), `docs/` 14 files, `eval/` 2, `README.md` 1. The large `test/` share is the frozen oracle, the parity suite and the reader tests.
- **Tasks done**: 13/16 before this retrospective (`grep -c '^- \[x\]' tasks.md`); ticking 9.2 makes 14/16. Open: 9.3 (archive and push), 9.4 (footprint, after the merge by design).
- **Active hours**: about 2 h of implementation (first task commit 18:15, last code commit 20:02, 2026-10-18), plus about 45 min of verify, the independent spec read and this retrospective. Planning was a separate session.
- **Subagent dispatches**: 35, counted as:
  - 11 implementers and 11 task reviewers (Tasks 1–11);
  - 6 for three fix rounds (Tasks 1, 7, 11), each a fix and a scoped re-review;
  - 3 for the final whole-branch review, its one fix wave and the re-review;
  - 1 for the verify scenario mapping;
  - 3 for the independent spec-against-code read, its fix and the re-review.
- **New external dependencies**: none (`git diff ac0df5d..HEAD -- package.json package-lock.json` is empty).
- **Bugs encountered post-merge**: not merged yet.
- **OpenSpec validate state at archive**: `npx openspec validate --all --strict` 24 passed / 0 failed before archive (`verify.md` section 0); re-run after archive in task 9.3.
- **Test coverage signal**: 2482 passed / 4 skipped at `5c0c374`, against 2368 after Task 1. 67 scenarios in 7 delta specs: 62 covered by tests, 3 by code only, 2 by hand, none uncovered. Eval delta 0 on every metric and identical per-query rankings, both pipelines.
- **Owner HITL**: none during apply. Spec decisions F1 and F2 were taken in the propose session. The owner switched the session model to Opus 5.5 mid-run (`/model`), which settled the commit trailer.
- **Footprint**: not measured yet (task 9.4, after the merge, on #158).

Commit chain (in time order):

```
ac0df5d docs(openspec): propose daemon-lexical-search                                      [propose]
72673e5 refactor(lexical): refresh the whole scope serially and never evict on allowed       [T1]
9dde4ef test(lexical): pin non-overlap of serialised refreshes                               [T1 fix round]
50a94b7 fix(vault-entry): watch the vault only while a corpus is attached                     [T2]
6b63ad9 feat(vault-entry): hold the lexical cache and its tie-break graph in the entry        [T3]
1328c84 feat(daemon): lexical.search over the vault entry's cache                             [T4]
6eee302 feat(daemon): report the lexical cache in daemon status                               [T5]
7ba774a refactor(search): read the lexical leg through a per-vault reader                     [T6]
1efde40 refactor(semantic): one attachment per vault, shared by the daemon facades           [T7]
bc84bdf fix(semantic): read a live status once another facade attached                        [T7 fix round]
dcc44ab feat(semantic): lexical readers over the daemon and the in-process entry              [T8]
ee98a72 feat(server): attach every vault at startup and serve the lexical leg through the daemon [T9]
83bd7cf test(lexical): pin parity across the three readers and the daemon round trip          [T10]
73083b8 docs: the lexical cache lives in the daemon's vault entry                            [T11]
32195ff docs: tighten the lexical-cache sweep                                                [T11 fix round]
d6e8d53 fix(search): log why a lexical leg failed                                            [final review]
807e3cc chore: tidy the lexical-cache change after review                                    [final review]
179b58a fix(vault-entry): warm the tie-break graph with the lexical cache                     [spec read]
5c0c374 docs(openspec): amend daemon-lexical-search specs to what the code does              [spec read]
90a0355 docs(openspec): add verify report for daemon-lexical-search
```

---

## 1. Wins

- **The frozen oracle made "rank exactly as before" checkable at every layer.** `test/lib/obsidian/lexical/_legacy-lexical-index.ts` is a verbatim copy of the pre-change index. The new refresh rule (`72673e5`), each of the three readers and the real daemon over a socket (`83bd7cf`) are compared to it with and without `allowed`. The owner's-vault eval then came out identical, per query, on both pipelines (`verify.md` section 0).
- **The pre-flight scan caught six plan-vs-code conflicts before any dispatch.** They became rulings R1–R6 in the ledger: no `readFile` seam through the reader (R2), the plan's "three refreshes" off-by-one against design D2 (R3), the attachment's shape (R4), `warm()` after the switch flips (R5), and an infeasible "the session reads no note" test (R6). No implementer stalled on any of them.
- **A per-task review caught a latent defect one task before it would have bitten.** The Task 7 reviewer (on a stronger model, by choice) found that a semantic backend could serve a minutes-old recorded attach status once another facade had attached first. Nothing exercised that until Task 9 made the lexical reader attach at startup. The fix (`bc84bdf`, ruling R9) landed with tests for both backends before Task 8 started.
- **Carrying the change 1 candidate forward paid off at once.** The independent spec-against-code read, run before archive as change 1's retrospective proposed, found three spec sentences that would have become false canonical text. One of them was a real gap: the spec promised a background warm of the entry's graph and the code built it lazily. Neither the per-task reviews nor the final review nor the 67-row scenario mapping had caught it (`179b58a`, `5c0c374`).
- **By-hand checks used real processes, including an unresponsive daemon.** On the owner's vault: three shared sessions on one entry with one `lexical ready` line, an opted-out scratch vault, `--no-semantic` and `--no-shared` with no daemon, a SIGKILL and a SIGSTOP. Only the SIGSTOP reproduced the spec's timeout path (`verify.md` section 7).
- **One PR, as the owner decided (F2), with no dark intermediate state.** The daemon side and the session switch landed together; the final review read the whole cycle at once.

## 2. Misses

- 🟡 [painful | evidence: `verify.md` 4.3, `5c0c374`] **Spec sentences about timing and failure were false again, the same class of defect as in change 1.**
  - "A call during a cold start does not wait" survived as a scenario title, although the lexical leg now awaits the daemon's locate-or-start.
  - "Unreachable … SHALL NOT switch" contradicted the canonical one-way switch.
  - "Within 30 seconds" read as a daemon deadline but is the session's request timeout.
  - Change 1's candidate 1 ("a spec sentence about timing must have a test or be softened") was still unchecked, so the propose session had no rule to follow. The independent read caught all three before archive.
- 🟡 [painful | evidence: `task-3-brief.md`, `179b58a`] **A spec sentence never reached the plan, so no brief asked for it.** The spec says the graph is "warmed in the background when the entry is created". Plan Task 3 said "warmed" only for the `LexicalIndex`, so the implementer and reviewer, each checking the brief, built and accepted a lazy graph. The consequence is that the first `lexical.search` on an entry read every note twice on the request path.
- 🟡 [painful | evidence: `1efde40`, `bc84bdf`, ruling R9] **The plan's attachment interface could not express "did my call attach".** `IVaultAttachment` as planned (`key`, `forget`, `attaching`, `statusOf`) let each backend guess from its own state. The backend returned a stale recorded status once a second facade existed. It cost one fix round and an interface addition (`attached`).
- 🟡 [painful | evidence: plan Task 12 step 1, `verify.md` W1] **The plan's killed-daemon expectation was wrong.** "Kill the daemon → the next `search_notes` fails with `DEPENDENCY_ERROR`" ignores change 1's reconnect rule: the connection notices a closed socket and reconnects transparently. The planned check would have "failed" on correct code. A SIGSTOP longer than the status and lexical timeouts reproduced the intended path.
- 📌 [nit | evidence: rulings R3, R6, R8] **Three plan steps could not be executed as written.**
  - R3: a refresh count that contradicted design D2.
  - R6: "the session reads no note" ignored the session graph that `backlink_count` still needs.
  - R8: `npm run eval` inside an implementation task needs the owner's private golden set.
  Each became a ledger ruling before dispatch, so none cost a round.
- 📌 [nit | evidence: ledger, 22 `minor (deferred` lines] **The deferred-minors list again reached 22 lines.** The final review triaged them: three were fixed before merge (a `waitFor` timeout, a Mermaid label, changelog-style history in two docs). The rest stay, recorded in `verify.md` suggestions.
- 📌 [nit | evidence: implementer reports for Tasks 2, 4, 5, 7, 8] **Every implementer flagged the commit trailer.** Their harness named their own model (Sonnet 5.5) while the constraints file said Opus 5.5. The constraints file was right (memory: the session's primary model, never the subagent's), but each report spent a concern on it.

## 3. Plan deviations

Controller rulings from the ledger, each with its cost if wrong recorded there:

| Plan task | What changed | Why |
| --- | --- | --- |
| all | Tasks ran sequentially, the parallel-safe groups included (R1). | One checkout: a shared git index and full-suite gates would see each other's half-done work. |
| 1 | `LexicalIndex` gained an optional `readFile` injection; re-parse counts come from it and `info().lastRefresh.parsed` (R2). Each refresh hands its callers a snapshot. | The index reads files with `fs`, not through the reader. The snapshot keeps a waiting caller on the state of the refresh that served it. |
| 1 | B and C arriving during A share one follow-up: two refreshes, not the plan's "three" (R3). | Design D2: at most two refreshes per burst. |
| 3 | The warm runs in `createVaultEntry` and after `setScope`, not in `VaultEntries.attach`. | Same effect, since attach is what creates an entry. |
| 6, 12 | `npm run eval` moved from Task 6 to verify, run on the owner's vault at the merge base and at HEAD (R8). | The golden set is private to the owner's vault. |
| 7 | `IVaultAttachment` takes the plan's shape (R4) plus `attached` (R9); `CORPUS_TIMEOUTS` and `isStatus` moved to `backend/corpus-wire.ts`. | The backends must tell a live status from a recorded one once another facade attached first. |
| 8 | The daemon reader's `warm()` calls `local().warm()` once the switch went `local` (R5), where the plan said "nothing". | An opted-out vault has no semantic backend to attach it after a failed daemon start. |
| 10 | "A daemon-served session reads no note" is tested on a second lexical call within the graph TTL, with a standalone contrast (R6). | `search_notes` still builds the session's own graph for `backlink_count`. |
| final | A lexical failure now writes its cause to stderr (`d6e8d53`). | The final review found that the new failure mode left no trace. |
| final | No rewording of the two `fix(...)` commits for defects that never shipped (R10). | The repo squash-merges PRs, so branch commit types never reach the CHANGELOG. |
| spec read | The entry warms its graph in the background (`179b58a`); three spec sentences and six wordings amended; a new `daemon-embedding-provider` delta names lexical reads as a third switch facade (R11). | The spec is the binding authority; each amendment states what the code does under design D6/D8. |

Tasks removed or added: none. 9.4 (footprint) stays after the merge, by design D11.

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ◐ |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ◐ |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review | ✓ |
| superpowers:finishing-a-development-branch | ✗ (not reached: task 9.3 follows this commit) |

Notes: `subagent-driven-development` ran with a pre-flight conflict scan, an implementer and a task review per task, three fix rounds, and a final whole-branch review on the most capable model with one fix wave. On top of that came the independent spec-against-code read that the schema does not name yet. TDD evidence (RED, then GREEN) is in every implementer report under `.superpowers/sdd/plan/`.

### Deliberately Skipped Skills

- **`superpowers:brainstorming`** (partial)
  - **What was skipped**: the interactive round. `brainstorm.md` is a decision log of choices made on the wayfinder map (#160, #163, #165) and in change 1, plus forks F1 and F2 settled by the owner on 2026-10-18.
  - **Why this cycle**: every design fork had an owner decision before `/opsx:propose`, and the session that ran propose recorded them.
  - **How to prevent recurrence**: `scope-judgment rule`, as in change 1: when a map settles every fork, the brainstorm is a log. The remaining risk is spec wording, not decisions, and the independent spec read covers it (candidate 6 in section 6).
- **`superpowers:using-git-worktrees`** (partial)
  - **What was skipped**: creating a fresh worktree.
  - **Why this cycle**: the owner's instruction was to commit into the existing PR #184, from the checkout the propose session had already pushed (`ac0df5d`). A new worktree would have meant a new branch.
  - **How to prevent recurrence**: `one-off — schema boundary case`. The schema assumes apply opens a new branch. When the owner puts propose and implementation in one PR, the existing checkout is already the isolated workspace the skill exists to provide.
- **`superpowers:finishing-a-development-branch`**: pending, not skipped. It follows this commit (task 9.3: archive, push, PR body rewrite after the owner's review).

## 5. Surprises

- **A killed daemon costs no call at all.** The session's connection noticed the closed socket before the next request and reconnected, respawning the daemon and re-attaching once for both legs. The design's "a killed daemon fails the next search" was pessimistic; only an unresponsive daemon (SIGSTOP past 40 s) fails a call.
- **The entry's graph was lazy by construction.** `WikilinkGraphIndex` builds on the first `ensureFresh()`. "Warm the entry" therefore meant two calls, and the plan named one.
- **Three readers turned out to be the right count.** `--no-semantic` (standalone), `--no-shared` and a failed daemon start (in-process entry), and the daemon. Each needed its own attach and warm rule, and the parity suite shows that all three rank identically.
- **The cold-start title survived an amendment.** Change 1's independent review amended the cold-start requirement; this change's delta restated it and kept the title. The title then became false when the lexical leg started waiting on the daemon. Restated text is new text.
- **A spec sentence can be true of every task and false of the whole.** "One attach serves both facades" held per facade until two facades shared one attachment. The stale-status defect lived exactly in the seam between Task 7 and Task 9.

## 6. Promote candidates → long-term learning

Carried forward from change 1 (`openspec/changes/archive/2026-10-18-daemon-vault-registry/retrospective.md` section 6), re-evaluated, then new ones.

- [ ] 🟡 **A spec sentence about timing, reconnect or startup must have a test, or be softened to what the code promises, and a ruling that overrides it must edit it in the same task.** → **Promote to** schema (`specs` artifact instruction in `openspec/schemas/superpowers-bridge/schema.yaml`) and memory (feedback)
  > **Why**: recurred in this change. "A call during a cold start does not wait", "unreachable … SHALL NOT switch" and "within 30 seconds" were all false or ambiguous against the code (`verify.md` 4.3, `5c0c374`), after the same pattern in change 1 (`3b293e0`). Two cycles in a row make this a schema fix, not a reminder.
  > **How to apply**: when writing or restating a delta requirement, phrase every SHALL with a duration, ordering or retry rule so a test can assert it. Re-read restated scenario titles as new claims. Write "the session waits at most N" rather than "answers within N".
- [ ] 🟡 **Before a task deletes an in-process mechanism, list the behaviours it provided implicitly and give each an end-state test.** → **Promote to** memory (feedback; extends `opsx plan authoring`)
  > **Why**: no new instance this cycle. The removed per-session `LexicalIndex` map had no hidden consumers; the parity suite checked its one behaviour. Kept for the next deletion.
  > **How to apply**: in the plan task that deletes or moves a loop, watcher or cache, add a "behaviours that came for free" list and one test per row.
- [ ] 🟡 **Route a code regression found by a docs-task reviewer to the code, not the docs task, and credit it as a code finding.** → **Promote to** skill (SDD reviewer instructions)
  > **Why**: not triggered this cycle. The Task 11 reviewer's Important finding was a genuinely stale doc sentence, checked against `vault-entry.ts`.
  > **How to apply**: reviewer instructions for a docs task say "a mismatch between a behaviour claim and the code is code-side Important unless the code is right".
- [ ] 🟡 **For a memory-saving change, derive the expected saving from the code, report the total with the shared process, and sample the shared process past +300 s.** → **Promote to** memory (feedback; extends `perf measurement is manual`)
  > **Why**: applies to this change's task 9.4. Design D11 already writes it into the method: per run, daemon included, one run to +900 s. The expected saving is "about the cache's heap for the vault" (~19–47 MB by #177).
  > **How to apply**: when posting 9.4 on #158, report each run with the daemon, and say whether the cache's heap moved from the sessions to the daemon as derived.
- [ ] 🟡 **Treat a checkable repo rule (naming prefix, file placement) as a fix-round item when first flagged, not a deferred minor.** → **Promote to** skill (SDD reviewer instructions)
  > **Why**: no violation this cycle. Every new interface carried the `I` prefix, and the constraints file every implementer read stated the rule. That suggests the constraints file, not the reviewer, is the cheaper place for it.
  > **How to apply**: put repo rules verbatim in the constraints file handed to every implementer, and triage any reviewer minor citing one as a fix-round item.
- [ ] 🟡 **Run an independent read of the spec against the code before archive, for any change whose delta specs become canonical.** → **Promote to** schema (`docs/workflow.md` and the apply instruction, between the final review's fix wave and verify)
  > **Why**: run this cycle as a carried-forward candidate. It found 3 Important (one a missing background warm in code, two false sentences) that the per-task reviews, the final review and a 67-row scenario mapping all missed (`verify.md` 4.3). Three for three across change 1's two PRs and this change. Ready to promote.
  > **How to apply**: after the final review's fix wave, dispatch a reviewer with the delta specs and the code, not the ledger or the plan. Ask for each SHALL sentence read literally, with timing, ordering, counting and negative claims singled out. Fix code findings with a red-then-green test; amend sentences in the change.
- [ ] 📌 **A controller ruling that rests on how old code behaved gets a grep or a read of that code before it is written down.** → **Promote to** memory (extends `verify code claims in durable docs`)
  > **Why**: followed this cycle. R10 cites the `origin/main` merge titles; R6 and R2 cite the lines they rest on.
  > **How to apply**: any `Ruling:` line that says "as before" or "the old X did Y" cites the file and line it checked.
- [ ] 📌 **A teardown handle with a lifecycle gets an explicit "final" state, a test for work that lands after close, and a note in the interface doc.** → **Promote to** one-off (recorded)
  > **Why**: reused this cycle. The entry's members are nulled on dispose and a search after dispose rejects (Task 3 test); `localEntries()` still throws after dispose, and both `warm()` paths swallow that. The template worked.
  > **How to apply**: reuse for the graph move (#172).
- [ ] 🟡 **Every SHALL sentence of a task's requirement is transcribed into that task's brief, word for word, before the plan is accepted.** → **Promote to** memory (feedback; extends `opsx plan authoring`)
  > **Why**: the spec said the graph is warmed in the background, plan Task 3 said only the index is, and two careful readers of the brief accepted the lazy graph (`179b58a`).
  > **How to apply**: while writing a plan task, list the requirement sentences it implements under the task's Interfaces block. The reviewer's brief then carries them, and an unimplemented sentence becomes a spec finding at task time.
- [ ] 🟡 **By-hand failure checks are derived from the existing reconnect and timeout rules, and cover both a dead and an unresponsive dependency.** → **Promote to** memory (feedback)
  > **Why**: plan Task 12 expected a SIGKILL to fail the next call; change 1's reconnect rule makes it transparent. Only a SIGSTOP past the status and request timeouts exercised the spec's failure path (`verify.md` W1).
  > **How to apply**: when a plan writes a by-hand failure check, name the rule that predicts the outcome. Include both a SIGKILL (the reconnect path) and a SIGSTOP longer than the sum of the timeouts on the call path (the timeout path).
- [ ] 📌 **A shared attachment or handle used by several facades exposes "attached on this epoch", not only "attaching".** → **Promote to** one-off (recorded)
  > **Why**: the stale-status defect (`bc84bdf`) came from a facade inferring the attach state from its own history.
  > **How to apply**: reuse the "a first status after another facade attached reads the live status" tests for any later facade on the same attachment (#172's graph service).
