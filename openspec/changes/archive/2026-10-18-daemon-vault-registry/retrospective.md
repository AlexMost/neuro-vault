# Retrospective: daemon-vault-registry

> Written: 2026-10-18 (after verify passed with warnings, `verify.md`).
> Commit range of the change: `64f8832..HEAD`. PR 1 merged as #181 (`4b7489b`, squash). PR 2 (this cycle, in detail): `4b7489b..ad80f1c`.
> Worktree: `.claude/worktrees/shared-daemon-pr2-6aff26`, branch `claude/daemon-vault-registry-pr2-02068c`.

The change moved per-vault semantic state (scope, watcher, reconcile loop, decoded corpus) out of every session and into one vault entry in the shared daemon. PR 1 added the entry to the daemon, dark: no session attached. PR 2 switched the sessions over and deleted the session-side snapshot, watcher and loop. Where a finding is about the change as a whole, it says so. PR 1 is covered shortly; PR 2 in detail.

---

## 0. Evidence

- **Commit range**: `64f8832..HEAD`.
  - PR 1: `64f8832..4b7489b`, one squash commit on `main` (#181). Its branch history is not reachable from `main`; the PR 1 ledger lists 11 tasks, four fix rounds (Tasks 7, 8, 10, 11a), one final review with a seven-commit fix wave (`9e49a22..a0986c1`), and the owner-requested review of #181 with its fixes (`f13a07b..5e24b69`).
  - PR 2: `4b7489b..HEAD`, 23 commits: 3 `feat`, 6 `fix`, 4 `refactor`, 9 `docs`, 1 `chore`.
- **Diff size**:
  - PR 1: 136 files, +7627 / −866 (`git diff --shortstat 64f8832..4b7489b`).
  - PR 2: 115 files, +6887 / −4191 (`4b7489b..HEAD`). The deletions are the session's snapshot, `SearchEngine`, `createCorpusBackend` and the session watcher. Of that, `src/` is 35 files (+1422 / −1187), `test/` 49 files (+4693 / −2644), `docs/` 20 files (+336 / −273).
- **Tasks done**: 28/31 before this retrospective (`grep -cE '^\s*- \[x\]' tasks.md`). Ticking 12.1 and 12.2 with this commit makes 30/31. Only 12.3 (archive and PR 2) is open.
- **Active hours**: estimate, not a record. PR 2 commits cluster in two windows (17 Oct 17:20 to 18:xx; 18 Oct 14:xx to 16:20). The unattended footprint runs (+300 s, one to +900 s) and the review sessions come on top. About 6 h of controller attention for PR 2.
- **Subagent dispatches (PR 2)**: 25, counted as:
  - 7 implementers (Tasks 12–18) and 7 task reviewers;
  - 2 for the Task 16 fix round and its re-review;
  - 3 for the final whole-branch review, its one fix wave and the re-review;
  - 2 for drafting `verify.md`;
  - 1 independent review session (2 turns, owner-requested, separate session), its fix dispatch, and one ADR-0020 wording dispatch;
  - 1 for this retrospective.
  - PR 1 dispatches were not counted here.
- **New external dependencies**: none in either PR (`git diff 64f8832..HEAD -- package.json package-lock.json` is empty).
- **Bugs encountered post-merge**: PR 1: none known. PR 2: not merged yet.
- **OpenSpec validate state at archive**: `npx openspec validate --all` 22 passed / 0 failed at HEAD (`verify.md` section 0); the archive itself (12.3) has not run.
- **Test coverage signal**: 2341 passed / 4 skipped at HEAD, against 2186 / 4 at PR 1's independent review. 89 scenarios in 7 delta specs: 84 covered by tests, 3 by code only, 2 by hand, none uncovered. Eval delta 0 on every metric, both pipelines (`verify.md` section 0).
- **Owner HITL**: ADR-0020's scope acked in chat on 2026-10-18 before it was written (Task 18); verify results approved in chat before archive. The independent review of PR 2 was the owner's request.
- **Footprint, posted on #158** (PR 2: issuecomment-6251194083; PR 1: issuecomment-6214839367). Settled at +300 s:
  - sessions: −23…−25% against main (N=5 mean 97 MB against 125 MB; −39% against the ~160 MB baseline);
  - daemon: 214 / 218 / 223 MB on main, 368 / 246 / 384 MB on PR 2 (N=1/3/5). Two of four PR 2 runs settled 25–30 MB above main; the other two sat at 368 and 384 MB, unresolved;
  - total with the daemon: +36% / −10% / +2% at N=1/3/5;
  - the startup peak (about 430 MB per session for 60–120 s) did not improve.

Commit chain (PR 2, in time order):

```
33ab10d docs(openspec): tick task 6.2 (PR 1 merged as #181)
6d6ced6 refactor(semantic): one daemon connection and one fallback switch per process        [T12]
7c79732 fix(vault-entry): decide a read's excluded anchors once, before it starts            [T13, PR 1 parked]
d94cdfb fix(daemon): remember a failed model load for 30 s on the documents lane             [T13, PR 1 parked]
80e6aac feat(daemon): corpus.nearest and corpus.nearestBlocks                                [T13]
abb7b50 refactor(retrieval): compose the semantic leg over corpus reads                      [T14]
1eac787 refactor(semantic): similar notes and duplicates over corpus reads                   [T15]
07ac488 feat(semantic): sessions read the corpus through the vault entry                     [T16 swap]
e9001df fix(semantic): nothing reattaches or builds vault entries after teardown             [T16 fix round]
65dcb9e feat(server): attach every vault in the background at startup                        [T17]
ded8664 docs(adr): add ADR-0020 ...                                                          [T18]
d4381dd docs: per-vault state in the daemon's vault entry                                    [T18]
ff26c39 fix(corpus): write a pruned live corpus back from memory                             [final review]
09f784b chore: drop stale comments and the warmup line at hang-up                            [final review]
969b58c docs: qualify when the daemon starts and when vault config is read                   [final review]
3b293e0 docs(openspec): amend attach and reconnect requirements to what the code does        [indep. review]
4fde97f docs(openspec): add verify report for daemon-vault-registry
1313f39 fix(semantic): report a Unicode-equivalent pair once in find_duplicates              [indep. review]
abf19a2 fix(semantic): close a daemon connection that lands after the switch flipped         [indep. review]
2241d55 refactor(semantic): give the shared-services interfaces the I prefix                 [indep. review]
8bec504 docs: stop the daemon before deleting a corpus to force a rebuild                    [indep. review]
2b1f366 docs(adr): state the timeout rule in ADR-0020 as the code has it                     [indep. re-review]
ad80f1c docs(openspec): record gates at HEAD in the daemon-vault-registry verify report
```

---

## 1. Wins

- **The pre-flight scan caught six plan-vs-code conflicts before any implementer was dispatched.** PR 2's ledger table lists the `profile` field on a process-level object, the `UNKNOWN_PROFILE` check order, the parity oracle outliving `snapshot.ts`, `status()` against "attach before the first call", the `semantic: false` vault, and the ripple of the async `status()`. Each got a ruling with a stated cost if wrong (section 3). None came back as a defect in review.
- **Per-session memory fell by a quarter and the sessions hold nothing of the vault.** 97 MB against 125 MB per session at N=5 (`verify.md` section 7). `lsof` showed 0 vault-directory handles in every PR 2 session and 1004 in the daemon (on main it was the reverse), so the watcher exists once.
- **Ranking parity held exactly.** Eval is identical before and after on both pipelines (semantic p@3 0.373, fused 0.440, hit@3 0.920), also right after the swap at `07ac488`. The frozen oracle `test/semantic/_legacy-retrieval.ts` was verified by the independent review against `git show 4b7489b:…` to be the old code, not a rewrite.
- **PR 1's parked blockers were closed first, as the hand-over said.** The mask computed once before the read (`7c79732`) and the 30 s failed-load memo (`d94cdfb`) are the first two PR 2 commits after the plumbing. The dead-inode watcher case went to the docs as agreed (`vault-entry.md:88`).
- **The final whole-branch review earned its keep.** It found the `index --prune` regression (section 2), which no task review, test or manual check had surfaced, and the fix wave of three commits was re-reviewed clean.
- **The independent review read specs against code, which nothing else did.** It found the two spec statements the code deliberately contradicts, a `find_duplicates` pair reported twice for NFC/NFD paths, a socket left open after a concurrent switch flip, and the `I`-prefix gaps. Seven findings, all addressed and re-reviewed in one pass (`3b293e0..2b1f366`). The two code fixes were shown red without the fix and green with it (`indep-fix-report.md`).
- **By-hand checks used real processes.** A real SIGKILL of the daemon, a respawn, a re-attach and a warm load from the shards on disk ran on the owner's vault. The integration test restarts only the socket server over the same in-memory entries, and `verify.md` records that split honestly (section 7).
- **The change was delivered in two PRs, as the tasks file asked.** PR 1 shipped dark and was reviewed and merged alone (#181); PR 2 started from a merged base. The PR 2 ledger cites PR 1's parked list rather than re-deriving it.

## 2. Misses

- 🟡 [painful | evidence: ledger "Task 18", `ff26c39`] **`index --prune` of a model directory a live entry serves broke an end state, and only the docs-task reviewer saw it.**
  - **The regression.** Before PR 2 the next pass of a live session rebuilt a pruned directory. After the swap the entry's memory stayed `ready`, `reconcileOne` called `ensureIdentity` only when the corpus was not loaded, and no shard was rewritten until a reload. A waited pass could even reload empty memory under `ready`.
  - **Why it was missed.** Tasks 12–17 each reviewed their own diff against their own brief. The behaviour was an implicit product of the deleted arrangement (the session reloaded the whole corpus after every changing pass), so no brief or test listed it. The Task 18 reviewer found it while checking that `own-corpus.md:212` was true, which is why it arrived as a docs finding.
  - **How it was handled.** The controller routed it code-side to the final review's fix wave, not into the docs task. `ShardCorpus` now writes memory back when the manifest vanished (ruling in section 3). That fix has a side effect: a hand `rm -rf` of a model directory under a loaded entry is also restored. The independent review found that, and `8bec504` documents it (stop the daemon first).
- 🟡 [painful | evidence: independent review Important 1, `3b293e0`, `2b1f366`] **Spec text contradicted deliberate code, and `verify.md`'s 89-scenario mapping did not catch it.**
  - **(a)** "status reads `indexing` 0/0 until the answer arrives" against `status()` awaiting `services.ensure()` first (up to 10 s while the daemon is located or spawned). The Task 16 controller ruling had reconciled this in the ledger, and `semantic-backend.md` documented it, but the delta spec was never amended.
  - **(b)** "a timeout → the next call reconnects" against `DaemonTimeoutError` deliberately keeping the socket up, because dropping it on a 10 s `vault.status` timeout would also fail a 900 s `embed.initialize` in flight.
  - **The same claim lived in four places** (spec, design D11, `semantic-backend.md`, ADR-0020). The first fix amended the spec and D11; ADR-0020 still carried the old rule until the re-review caught it (`2b1f366`).
  - **Why verify did not catch it.** The mapping checks that a scenario has an implementing path, not that the path has the timing the sentence promises. Archive would have copied both statements into canonical `openspec/specs/`.
- 🟡 [painful | evidence: `verify.md` section 7, W1 and W2] **The memory outcome is smaller than the premise, and the daemon's footprint is unexplained.**
  - **The premise.** The brainstorm and design counted about 93 MB of per-vault semantic state per session (156 MB at N=2+ against a 63 MB `--no-semantic` floor in the #158 baseline).
  - **The measure.** The measured per-session saving is 28–31 MB against main. Main itself already sat at 125 MB, so the −39% against the baseline is mostly not this change.
  - **What is still unexplained.** The remainder over the floor is not attributed. The daemon settled at 368 / 384 MB in two of four runs, with totals of +36% at N=1 and +2% at N=5. The one +900 s run had already settled low by +300 s, so whether the high runs hold a startup decode peak or a real steady state is open. The startup peak did not move. This is a measured outcome rather than a regression of any scenario (W1), but the change's headline claim needs the qualifier.
- 🟡 [painful | evidence: `2241d55`, `181-review.md`] **A repo naming rule (`I` prefix on new interfaces) was deferred as a "minor" twice and came back in review twice.** PR 1's independent review forced a rename wave (`VaultEntry` → `IVaultEntry` and others). In PR 2, Task 12's and Task 16's reviewers deferred `DaemonLink`, and `SharedServicesOptions` slipped by; the independent review made the owner-visible commit `2241d55`. The rule is checkable by grep, and the deferred list treated it as taste.
- 📌 [nit | evidence: `task-16-report.md` "Behaviour not kept identical"] **A controller ruling assumed the old eval snapshot applied the vault scope; it never did.** `eval/backends.ts` called `loadCorpusSnapshot(store)` without `isExcluded`. The implementer checked, kept the ranked set the same (adding `allowed` would have moved scores) and said so, so eval delta 0 is real. The ruling's premise was wrong anyway, and the docstring in `eval/backends.ts` now states it.
- 📌 [nit | evidence: ledger "Task 16", PR 1 ledger] **`DaemonConnection.close()` does not cancel an in-flight connect or poll.** Timers run up to 10 s and a detached respawn is possible after a hang-up during a cold start. It is bounded, idle and pre-existing from PR 1, and was ruled a follow-up issue; it is still open.
- 📌 [nit | evidence: ledger, 24 `minor (deferred` lines for Tasks 12–18] **The deferred-minors list grew to 24 lines.** Most were closed by the final fix wave or accepted. Two came back from outside: `DaemonLink` without the `I` prefix (`2241d55`) and the connect/poll cancel, which is still open. A deferred line with no named owner task tended to survive to the end.
- 📌 [nit | evidence: ledger "Final: parked"] **A failed write-back after a disk error leaves the manifest present, so later passes skip the write-back.** The profile goes unavailable for one backoff, then ready with missing shards until a reload re-embeds them. Accepted (needs an I/O failure, self-heals).
- **PR 1** (for completeness): its final review's Important finding was that there was no reconcile-on-attach and that a removed or disabled profile kept embedding mid-pass. Both were fixed in the wave `9e49a22..a0986c1`. The independent review of #181 found a drop-before-dispose race in `VaultEntries` (two loops, one stale lock), fixed in `f13a07b..5e24b69`. Both were the same family as the PR 2 findings: a lifecycle property in the spec that only a reader of the spec against the code sees.

## 3. Plan deviations

PR 2 rulings in the controller's ledger (each states its cost if wrong), then the outcome:

| Plan task | What changed | Why |
| --- | --- | --- |
| 12 | New interfaces take the `I` prefix: `ISharedServices` (plan `SharedServices`); `SemanticBackend` is renamed `ISemanticBackend` in Task 16 because its shape changes entirely. | `naming-conventions.md`: a new or wholly reshaped interface gets the prefix. Cost if wrong: rename churn in Task 16's diff. |
| 12 | `createSharedServices` takes the process-level subset of `ProviderFactoryOptions` (everything but `profile` and `loader`). | A process has one connection whatever its profiles. Cost if wrong: a type alias rename. |
| 13 | `corpus.*` checks the profile key against `MODEL_PROFILES` before the attachment check. | The spec says an unknown profile is answered `UNKNOWN_PROFILE`; after the attachment check it is unreachable. Cost if wrong: `UNKNOWN_PROFILE` reports where `NOT_ATTACHED` would. Recorded in `verify.md` D9. |
| 13 | The two PR 1 parked items (excluded-anchor mask, failed model load) are folded into Task 13's commits. | Task 13 is the first consumer of `reader()` and touches the daemon's `embed` lane. |
| 14 | `test/semantic/_legacy-retrieval.ts` carries frozen copies of `findNeighbors` and `findBlockNeighbors` and stays as a permanent regression guard; Task 16 switches the parity test's reader from `snapshotReader` to a loaded `ShardCorpus`. | The oracle must outlive `snapshot.ts` and `SearchEngine`. Cost if wrong: one test-only file kept. |
| 14 → 18 | The Important finding that `retrieval-policy.md` is stale is routed to Task 18, not a Task 14 fix round; Task 18's file list gains `docs/architecture/retrieval-policy.md` and its grep gains `findNeighbors`, `findBlockNeighbors`, `findDuplicates`, `narrowSources`, `searchEngine`, `sources Map`. | Docs belong to the docs task by plan; the finding was a scope gap in Task 18. It was honoured. |
| 16 | `search-engine.ts` is deleted once nothing in `src/` or `eval/` uses it; `eval`'s scorers go through `ShardCorpus.nearest`. | Design D3 says its functions become `ShardCorpus` internals. Cost if wrong: eval keeps a duplicate scorer. |
| 16 | `DaemonSemanticBackend.status()`: while this epoch's attach is in flight it reads `indexing 0/0` without waiting; with no attach for the epoch it starts one and awaits it (10 s). | Reconciles "0/0 until answered" with "attach before the first call per epoch". The spec wording was not updated until the independent review (section 2). |
| 16 | A vault with `"semantic": false` gets a constant disabled backend that never attaches. | The spec attaches only semantically enabled vaults. `profiles: []` attach is change 2's (#176). |
| 16 | `services.close()` became **final**: a later `ensure()` rejects, a connect landing afterwards is closed, and the backend's dispose guard and stale-epoch attach are checked (fix round 1, `e9001df`). | A hang-up during startup could otherwise re-attach or build vault entries after teardown. Not in the plan. |
| 18 | ADR-0020 written only after the owner's ack of its scope (chat, 2026-10-18); `docs/adr/INDEX.md` records the partial supersession of ADR-0014. | HITL gate in the plan. |
| final | `ShardCorpus` writes memory back to a store whose manifest vanished (`ensureIdentity`: no manifest, no shards, non-empty loaded memory), and `refresh()` skips the reload when the manifest is null under loaded memory. | Restores the pre-PR 2 end state (a live server rebuilds a pruned directory) without re-embedding, and keeps memory a subset of disk. Cost if wrong: a pruned model directory reappears while a session serves it, as before PR 2. |
| final | Cancelling the poll on `close()` is deferred to a follow-up issue. | Bounded (up to 10 s of timers, idle daemon) and pre-existing in PR 1. |
| final | A failed write-back is accepted, with no second fix wave. | Needs an I/O failure; self-heals on reload. |
| indep. review | The wire types `Corpus*Params` and `Corpus*Result` in `protocol.ts` keep that file's `Embed*Params` naming; `SharedServicesOptions` → `ISharedServicesOptions` and `DaemonLink` → `IDaemonLink` get the prefix. | Consistency inside the wire-contract file over the new-interface rule. Cost if wrong: a later rename of four wire types. |
| indep. review | The optional behaviour change (`status()` returning `ATTACHING` during the first `ensure()`, lexical-mode search skipping the status await) is a follow-up. | The reviewer marked it optional and it needs its own tests. Cost if wrong: lexical-only search waits on a wedged daemon's 10 s status timeout. |

PR 1 rulings that PR 2 inherited: `CorpusWriter.ensureIdentity` in place of design D3's `reset(identity)` (D3 and D4 carry the note; suggestion 3 of `verify.md` asks to fold it into the interface list); no wire `vault.detach` (detach is the connection's close); the server enters `SHUTTING_DOWN` before the entries dispose; `vault.*` rejects unknown param keys; every successful attach requests a coalesced pass; a removed or disabled profile's in-flight pass is aborted.

Tasks removed or added: none. All of tasks.md groups 7–11 landed; 12.1 was the verify with the by-hand checks.

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ◐ |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review | ✓ |
| superpowers:finishing-a-development-branch | ✗ (not reached: task 12.3 follows this commit) |

Notes: `writing-plans` produced `plan.md` (560 lines), and the pre-flight scan ahead of PR 2's dispatches is a controller step on top of it. `subagent-driven-development` ran with implementers, a per-task review and a final review for every task, with fix rounds capped at 5 (one used on Task 16; four used in PR 1). Task 16's fix round (three items: dispose guard with a final `services.close()`, pristine stderr, stale-epoch attach) came from the per-task review, not from the implementer's tests. TDD is evidenced in PR 2 by the red-then-green runs in `indep-fix-report.md` (items 2 and 3); the per-task red steps are in the implementers' reports.

### Deliberately Skipped Skills

- **`superpowers:brainstorming`** (partial)
  - **What was skipped**: the interactive question-by-question round. `brainstorm.md` is a raw decision log of choices the owner made on the wayfinder map (#160, tickets #161–#166, 2026-10-15/16) and says so in its first lines; no fork was open.
  - **Why this cycle**: the change was chartered on a map of resolved tickets. Every design fork (fallback granularity, one loop per vault, entry lifetime, scope re-read, filters in the session) had an owner decision on a ticket before `/opsx:propose`. A round of questions would have re-asked them. The two open items that mattered were found later, not at brainstorm time: the 0/0 versus wait rule and the timeout rule (section 2).
  - **How to prevent recurrence**: `scope-judgment rule`. When a map settles every fork, the brainstorm is a log, and the spec must be written against the behaviours the map is silent on: timing, teardown and reconnect. Candidate 1 in section 6 carries this.
- **`superpowers:finishing-a-development-branch`**: pending, not skipped. It follows this commit (12.3: archive, `gh pr create` with `Refs #158`, `Closes #175`, `Closes #106`).

## 5. Surprises

- **The saving per session was a third of the claimed state.** The ~93 MB "per-vault semantic state" came from comparing a 156 MB semantic session against a 63 MB `--no-semantic` floor, which also holds everything else a semantic session starts (the lexical index, embedding plumbing, startup allocations). Moving the corpus, watcher and loop out removed about 28–31 MB. Main had also moved from the baseline's ~160 MB to 125 MB between the baseline build and PR 1.
- **The daemon's settled footprint is bimodal.** 246 MB in one run, 368 / 384 MB in two others, all at +300 s on the same vault; the +900 s run settled low. A single "daemon RSS" number is not a measurement.
- **The startup peak did not move.** About 430 MB per session for 60–120 s, although a session no longer decodes the corpus. The lexical build is the suspect and nothing was measured; it is for change 2 (#176) and the startup-peak issue.
- **A docs review is a behaviour review.** The Task 18 reviewer read `own-corpus.md:212` against the code to judge whether a sentence was true, and found a regression three tasks earlier.
- **A clean whole-branch review did not catch the spec contradictions.** Reviewers compare diffs with the brief and specs; the independent reviewer compared spec sentences with what a timeout and a cold start actually do.
- **The old eval snapshot never applied the scope** (section 2): a ruling's premise about old behaviour was wrong, and the outcome was still safe because the implementer re-read the code.
- **`services.close()` had to become final.** Not in the plan. Without it, a hang-up during a cold start let a late connect or attach build a vault entry after teardown.
- **A fix can create the next ticket.** The write-back that restores a pruned directory also restores a directory the user removed by hand. The consequence is a one-line guide note, not a code change, but only the independent review thought of it.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A spec sentence about timing, reconnect or startup must have a test, or be softened to what the code promises, and a ruling that overrides it must edit it in the same task.** → **Promote to** schema (`specs` artifact instruction in `openspec/schemas/superpowers-bridge/schema.yaml`) and memory (feedback)
  > **Why**: spec text said "0/0 until the answer arrives" and "a timeout → next call reconnects"; the code (correctly) waited on `ensure()` and kept the socket on a timeout. The Task 16 ruling reconciled the first in the ledger but not in the spec. `verify.md` mapped 89 scenarios as implemented, and only the independent review caught both (`3b293e0`). ADR-0020 restated the old rule and survived the first fix (`2b1f366`).
  > **How to apply**: when writing a delta spec, phrase every SHALL that carries a duration, ordering or retry rule so a test can assert it, or write "waits at most N" rather than "reads X until Y". When a controller ruling or a fix departs from a spec sentence, amend the sentence in that commit, then grep the claim across spec, design, ADR and architecture docs.
- [ ] 🟡 **Before a task deletes an in-process mechanism, list the behaviours it provided implicitly and give each an end-state test.** → **Promote to** memory (feedback; extends `opsx plan authoring`)
  > **Why**: the session's "reload the corpus after every changing pass" made `index --prune` self-heal (the live server rebuilt the pruned directory). The swap in Task 16 dropped that silently; only the Task 18 reviewer found it, via a sentence in `own-corpus.md` (`ff26c39`).
  > **How to apply**: in the plan task that deletes or moves a loop, watcher or cache, add a "behaviours that came for free" list (CLI commands that touch the same files, manual file operations, restarts) and one test per row. Name them in the task brief so the reviewer checks them.
- [ ] 🟡 **Route a code regression found by a docs-task reviewer to the code, not the docs task, and credit it as a code finding.** → **Promote to** skill (SDD reviewer-instructions, `.superpowers/sdd/plan/reviewer-instructions.md` template)
  > **Why**: the Important finding of Task 18 was code-side. The controller's ruling to send it to the final fix wave worked, and a docs-only fix would have documented a regression as truth.
  > **How to apply**: reviewer instructions for a docs task say "for every behaviour claim that you check against the code, mark any mismatch as code-side Important, not as a docs nit".
- [ ] 🟡 **For a memory-saving change, derive the expected saving from the code, report the total with the shared process, and sample the shared process past +300 s.** → **Promote to** memory (feedback; extends `perf measurement is manual`)
  > **Why**: the premise (~93 MB per session) came from a baseline difference (semantic session minus floor). The measured saving was 28–31 MB per session, the daemon landed bimodal (246 vs 368/384 MB) and the total moved +36% / −10% / +2% (`verify.md` section 7).
  > **How to apply**: in `design.md`, state the target as the total across N sessions plus the daemon, with the expected per-session delta traced to named allocations. In the measurement, include one or two runs sampled to +900 s, and report each run, not a mean. Follow-up for this change: sample a high-variance daemon run to +900 s on #158.
- [ ] 🟡 **Treat a checkable repo rule (naming prefix, file placement) as a fix-round item when first flagged, not a deferred minor.** → **Promote to** skill (SDD reviewer-instructions: "a violation of a rule in `docs/architecture/*-conventions.md` is never deferred")
  > **Why**: the `I`-prefix rule came back as a rename wave in PR 1 (`181-review.md`) and again as `2241d55`, after being deferred on Tasks 12 and 16.
  > **How to apply**: the controller's triage of a reviewer "minor" asks one question first: is it a stated repo rule? If yes, send it to the task's fix round.
- [ ] 🟡 **Run an independent read of the spec against the code before archive, for any change whose delta specs become canonical.** → **Promote to** schema (`docs/workflow.md`, between final review and verify) or memory (feedback)
  > **Why**: both PRs' independent reviews found lifecycle and spec-vs-code defects that the per-task and final reviews missed (PR 1: drop-before-dispose race; PR 2: two contradicted requirements, NFC/NFD double report).
  > **How to apply**: after the final review's fix wave and before verify, hand the reviewer the delta specs and the diff, not the ledger. A finding's fix needs a red-then-green test where it is code.
- [ ] 📌 **A controller ruling that rests on how old code behaved gets a grep or a read of that code before it is written down.** → **Promote to** memory (extends `verify code claims in durable docs`)
  > **Why**: the Task 16 ruling assumed the old eval snapshot applied the scope; `eval/backends.ts` never passed `isExcluded`. The implementer's re-read prevented a score change.
  > **How to apply**: any `Ruling:` line that says "as before" or "the old X did Y" cites the file and line it checked.
- [ ] 📌 **A teardown handle with a lifecycle gets an explicit "final" state, a test for a connect or attach that lands after close, and a note in the interface doc.** → **Promote to** one-off (recorded here)
  > **Why**: `services.close()` had to become final in the Task 16 fix round (`e9001df`), and `abf19a2` closed the same race at another seam. It is specific to the connection-and-switch design.
  > **How to apply**: reuse the two tests (`closes a connection that lands after another caller flipped the switch` and the dispose-guard test) as the template for change 2's lexical cache lifecycle.
