# Retrospective: own-backend-integration

> Written: 2026-08-25 (after verify passed)
> Commit range: `da67af3..63d1c32`
> Worktree: `.claude/worktrees/own-backend-integration` (branch `worktree-own-backend-integration`, not yet merged)

---

## 0. Evidence

- **Commit range**: `da67af3..63d1c32` (24 commits, 2026-08-25 17:29 → 22:33)
- **Diff size**: 113 files changed, +6471 / −1965
- **Tasks done**: 21/22 in `tasks.md`. The one open box is 7.3, deliberately sequenced _after_ `openspec archive` syncs the delta specs — delta specs carry Requirements only, so `corpus-staleness-filtering`'s Purpose prose cannot be rewritten until the main spec exists in its post-archive form (verify.md §2).
- **Active hours**: ~5.1 h wall clock, single session
- **Subagent dispatches**: 41 fresh (implementer + reviewer + re-reviewer per task, plus the smoke, the final whole-branch review and the verify pass), plus 9 resumes of live implementers for fix rounds. 7 tasks needed a fix round; every one converged in round 1 of 5 — the cap was never approached.
- **New external dependencies**: `chokidar@^4.0.3` (MIT), runtime. Sole transitive dependency `readdirp`; pure JS, no native component — which is why ADR-0013's npx-distribution constraint survives (Task 12 ruling).
- **Bugs encountered post-merge**: none — not merged at write time.
- **OpenSpec validate state at archive**: `openspec validate --all` → 18 passed, 0 failed (run at `3817474`).
- **Test coverage signal**: 1220 vitest at fork → **1266 at head**. Not monotonic: 1220 → 1277 by Task 10, then Task 11 deliberately deleted 22 with Smart Connections (13 loader + 7 corpus-index + 1 corpus-refresh integration + 1 sc eval) → 1255, then 1257 (Task 15) → 1266 (Task 16).
- **Gates at head**: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all clean, run first-hand by the controller.
- **verify.md decision**: ⚠️ PASS WITH WARNINGS — 16/16 requirements mapped to committed implementation with named tests; ~54 of 55 scenarios covered (the uncovered one is promotion atomicity, structural rather than tested).

Commit chain (時序):

```
394a5af docs(openspec): plan the own-backend integration
a80b3af refactor(semantic): give the backend contract a home of its own
1cb4480 feat(config): one owner for the per-vault config file
8ed6362 feat(semantic): queue embeddings process-wide, queries first
93b3de4 feat(corpus): load a ranking snapshot from the owned shards
01699e3 feat(semantic): a per-vault corpus backend with live promotion
5e1044a fix(semantic): keep a disabled vault inert and never report ready over an unloaded snapshot
c1e368d feat(semantic): watch each vault and reconcile after a quiet period
e4d617f fix(semantic): scope the vault watcher's ignore rule to vault-relative paths
a307ca6 refactor(vault): entries carry a semantic backend, not a corpus and two flags
63197bc test(server): observe the empty-corpus mapping instead of asserting it
a6f440b feat(server): serve semantic search from the vault's own corpus
e2c912d fix(server): shut down cleanly when a vault's disposal fails
b77b9e5 feat(semantic): tell the caller why the index cannot answer yet
407d5e0 feat(search): report the vault's semantic index state on every response
7b74eca fix(search): stop re-reading backend.status() in the leg-decision branch
c97c8d1 feat(semantic)!: remove Smart Connections
e334250 docs(adr): record background corpus freshness (ADR-0014)
eafb520 docs: describe the server's own embedding index honestly
2c11fd6 docs(research): fix dead link to deleted architecture doc
9486bef fix(server): dispose backends when the client closes stdin
8c7ac36 docs(openspec): mark the own-backend integration tasks complete
3817474 fix(semantic): report a failed index as unavailable and degrade search_notes
63d1c32 docs(openspec): verify the own-backend integration
```

---

## 1. Wins

- **The pre-flight conflict scan paid for itself.** The 15-row producer→consumer table at the top of `progress.md` predicted the one genuine cross-task dependency before any dispatch — `SmartSource` imported by Task 1 from a module Task 11 deletes — and carried it into Task 11's brief. Task 11 landed with a clean review and the drop of 22 tests fully accounted line by line (`c97c8d1`).
- **TDD held without exception.** Every fix commit carries a RED-verified test. Task 16's guard was proven RED by driving the **real** `reconcileCorpus` against a real `CorpusStore` on a real temp dir with an `embed` that rejects — `expected 'ready' to be 'unavailable'`, twice, with no status hand-set anywhere in the test (`.superpowers/sdd/plan/task-16-report.md`, "TDD evidence"). Others were proven by reverting a single guard or by mutation.
- **Fix rounds converged immediately.** 7 of 16 tasks needed a fix round; all 7 closed in round 1/5 with 0 open findings (Tasks 5, 6, 7, 8, 10, 13, 15 in the ledger). The 5-round cap never came close to binding, which suggests the review→fix loop is correctly sized rather than merely tolerated.
- **A deliberate staging decision was honoured rather than quietly patched.** Task 7's reviewer correctly reported that the startup `await` was gone and the two embeddings-only tools would answer `unavailable: unknown reason`. The controller ruled it plan-mandated, carried the exact string into Task 9 as a required item, and Task 9 (`b77b9e5`) replaced it with `SEMANTIC_INDEX_BUILDING`. The interim under-service never escaped the branch — the change ships as one PR.
- **Two rulings were made against the plan's own text on verified evidence, not on taste.** Task 6's ignore predicate (the reviewer probed real chokidar's `ignored` callback and showed it always receives an absolute path) and Task 12's ADR wording (the implementer read the installed `package.json`/`node_modules` and found chokidar v4 has no native component, contradicting the brief's "optional native dep with a JS fallback"). Both produced durable artifacts that describe the system as it is.
- **Test-count movement was audited, not assumed.** Task 7.1 required the suite count to move only by the tests this change adds; the ledger accounts for the one negative move (Task 11's −22) by suite, and Task 16 states `+8 = exactly the tests added`.

## 2. Misses

- 🔴 **A controller ruling deleted a live guard, and only the final whole-branch review caught it.** At Task 7 the `snap.sources.size === 0` branch was parked as dead code — "the loader throws before ever returning empty" — and died with the adapter in Task 8. That was true of the Smart Connections loader and **false of its replacement**: Task 8 swapped in `loadCorpusSnapshot`, which returns an empty `Map` rather than throwing (`src/lib/obsidian/corpus/snapshot.ts:12-27`). The recorded cost ("a one-task window in which the mapping is unobserved") understated the real one: the mapping did not go unobserved for a task, it went away. Consequence: a cold vault whose every embed fails reported `ready` over an empty corpus. The eval harness had kept its own copy of the same check (`eval/backends.ts:11-16`); the server had none. Fixed in `3817474`. The defect in the _reasoning_ is the durable part: the claim "this branch is unreachable" was tied to the very implementation the branch was being replaced by.
- 🔴 **The first fix for that defect reintroduced it, and the scoped re-review caught it.** The initial guard required all five of `sources.size === 0 && total > 0 && failed > 0 && embedded === 0 && renamed === 0`. But a note below `MIN_CHARS` reaches `embedNote`, calls `embed` **zero** times, writes a shard with `embedding: null`, and still increments `summary.embedded` — while contributing no source. So one stub note in a cold model-less vault yields `embedded:1, failed:2, sources.size:0`, the guard stays silent, and `snapshotLoaded` latches `true` so the load branch never re-runs: `ready` over an empty corpus until something in the vault changes. Corrected to three clauses (`failed > 0` already excludes the healthy all-below-gate vault; `sources.size === 0` already excludes the healthy incremental pass). Shape of the mistake: a guard was built out of counters whose semantics were assumed rather than read.
- 🔴 **A design property the change itself introduced was falsified by its own smoke.** Design D10 exists precisely because "a live chokidar watcher keeps the event loop alive; without this the process outlives its client". Task 14 found that closing the client's stdin did not stop the server — alive at 60 s, needed SIGKILL — because the MCP SDK's `StdioServerTransport` registers only `'data'`/`'error'` on stdin, never `'end'`/`'close'`, so `transport.onclose` never fired. Isolated cleanly: opted-out vault exits in 39 ms, `--no-semantic` in 34 ms, SIGTERM in 24 ms; only the live-watcher config hung. Fixed in `9486bef` (stdin-close exit → 23 ms, exit code 0).
- 🟡 **1255 tests could not see it.** `test/server-modules.test.ts` hand-fired `transport.onclose?.()` on a bare fake object — proving the disposal fan-out works _once called_, and never that anything calls it. Every test in the branch drove the system through an injected seam (fake `CorpusStore`, fake watcher factory, `vi.useFakeTimers()`, stub embedder). The smoke was the only thing running the real model, real chokidar and real disk. That is not an accident of this change; it is the shape of the whole suite.
- 🟡 **Three defects originated in the plan's own text, not in implementer error.**
  - The watcher's ignore regex was supplied verbatim by the plan and tested chokidar's path _as handed to `ignored`_, which is always absolute — so any vault under a hidden directory (`~/.sync/vault`) matched everything and the watcher fired **zero** events, silently, no `error`, no warning (`e4d617f`).
  - Task 8's brief Step 4 snippet assigned `transport.onclose = () => void dispose()` after `server.connect()`, which would have clobbered the MCP SDK's own `onclose` (installed in `Protocol.connect`, `protocol.js:220-223`, where it aborts in-flight handlers and rejects pending responses).
  - The same snippet's `void dispose()` shape over an `await Promise.all(...)` fan-out raises `ERR_UNHANDLED_REJECTION` if any backend's dispose rejects — defeating design D10, the very decision it implemented (`e2c912d`).
- 🟡 **Task 7's brief listed the wrong files.** It explicitly excluded `src/server.ts` ("your job ends at the seam") while mandating an entry-shape change that necessarily breaks it in the same typecheck — 5 failures, all inside `src/server.ts` / `test/server-modules.test.ts`. The implementer had to invent an interim adapter (`createSmartConnectionsBackend`) that Task 8 then deleted. This is the third instance of the same repo memory (_type change ships with its call sites_) and it reached a brief anyway.
- 🟡 **The plan-supplied tests left the load-bearing code uncovered while passing.** In Task 6 every supplied test injected a fake watcher factory, so `isIgnoredPath` and the `.md` filter — both module-private — had zero assertions. A three-line table test would have caught the absolute-path bug immediately; it was added only as part of the fix (`test/semantic/backend/vault-watcher.test.ts`, `describe('isIgnoredPath')`).
- 🟡 **A documentation invariant survived the task whose job was to remove it.** Task 12's review passed clean; the controller then found `openspec/config.yaml:10` still reading "cosine search over a Smart Connections embedding corpus" in the "What this is" blurb. The invariant _below_ it had been correctly updated to ADR-0013/0014 — so the exact same file briefs a fresh session with both the new rule and the superseded fact. Task 6.4 existed to prevent this and did not.
- 📌 **ADR-0014 shipped a claim that was false for four commits.** It stated that `docs/architecture/smart-connections-corpus.md` "is deleted" and ADR-0006 is "marked fully superseded" — neither true at `e334250`; both true at `eafb520`. Ruled acceptable (one PR, adjacent commits, rewording would cost a third edit to an immutable document) and gated on a controller check plus the final review. It held, but the mechanism was a promise rather than a constraint.
- 📌 **A known coverage gap was flagged at Task 11 and never closed.** Deleting the Smart Connections integration test removed the only place a corpus change was observed _through a tool call_; a handler that memoized its snapshot would now pass. The final triage checked all three handlers by hand and confirmed the property holds — so the property is fine and only the guard is missing. Still a hand-check standing in for a test.
- 📌 **Vestigial vocabulary shipped.** `describe('own backend snapshot')` and `eval/run.ts:73`'s comment still say "backend" after the axis retired; `makeVaultFixture` keeps an `.ajson` suffix for a format nothing can read; `SmartSource`/`SmartBlock` keep a `Smart` prefix naming nothing. Brief-mandated to defer — a pure rename touching every ranking file deserves its own change.

## 3. Plan deviations

| Plan task            | What changed                                                                                                                                        | Why                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global Constraint    | "Smart Connections files are not edited or deleted here … #88 removes them" declared **void**; Task 11 deletes them (`c97c8d1`)                      | Stale line from an earlier draft, contradicted by Task 11, `proposal.md` and design D13. The spec is binding; the plan is its argument. Constraint omitted from every implementer brief.       |
| 2.3 (T6)             | Plan-supplied ignore regex replaced with a vault-relative match (`e4d617f`)                                                                          | The verbatim regex made the watcher dead for any vault under a dot-directory. D6's binding requirement is dot-paths **inside** the vault, to stop `.neuro-vault/corpus/` feedback.             |
| 3.1 (T7)             | Brief's file list extended to `src/server.ts` + `test/server-modules.test.ts`; an interim `createSmartConnectionsBackend` adapter added, then deleted | The entry-shape change breaks `server.ts` in the same typecheck. Not optional scope creep — the task is unsatisfiable without it.                                                              |
| 3.3 (T8)             | `transport.onclose` chained onto the SDK's handler instead of assigned (`a6f440b`); `void dispose()` → `allSettled` + `catch` (`e2c912d`)            | The brief's snippet clobbered `Protocol.connect`'s cleanup and could raise `ERR_UNHANDLED_REJECTION` — both against D10's stated purpose.                                                      |
| 6.1 (T12)            | ADR-0014 describes chokidar as pure JS, not "an optional native dep with a JS fallback"                                                              | Installed chokidar v4 has no native component. A durable ADR must describe the dependency the repo actually has.                                                                               |
| 6.3 (T13)            | Acceptance criterion "grep returns only ADR-0006 and its INDEX row" met in spirit, not literally                                                     | ADR-0013/0014 **must** name Smart Connections — they are the records of deciding against it, and ADR-0008 makes ADRs immutable. Reviewer re-ran the grep and classified every hit; 1 was stale. |
| 7.2 (T14)            | Interactive `npm run inspect` inspector → scripted stdio JSON-RPC drive against a scratch vault                                                      | The inspector needs a human at a browser. Same assertions; phase C re-ran the brief's literal `npx tsx` invocation as a cross-check.                                                           |
| — (new Task 15)      | Task added beyond the plan: fix the stdin-close hang the smoke found (`9486bef`)                                                                     | Shipping a change whose own smoke falsifies its own stated design property (D10) is not acceptable, and this branch introduced the watcher that causes it.                                     |
| — (new Task 16)      | Task added beyond the plan: final whole-branch review fix wave, 3 findings (`3817474`)                                                               | None of the three was visible inside any single task's scope. One-fix-wave rule bent once for the residual, on evidence.                                                                       |
| 7.3                  | Left unchecked                                                                                                                                       | Its precondition (delta specs synced into `openspec/specs/`) only holds after `openspec archive`. Sequenced, not skipped.                                                                      |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | ✗    |

Evidence: `brainstorm.md` (152 lines) and `plan.md` (1757 lines) both exist in the change directory; all 24 commits are on `worktree-own-backend-integration` in `.claude/worktrees/own-backend-integration`, never on `main`; the ledger records 16 task dispatches each with an implementer + reviewer (+ re-reviewer where a fix round ran); every fix commit carries RED-verified test evidence in its task report.

### Deliberately Skipped Skills

- **`superpowers:finishing-a-development-branch`**
  - **What was skipped**: the entire skill — nothing skipped by choice, it has simply **not yet run** at write time.
  - **Why this cycle**: the ledger's last line reads "Branch implementation COMPLETE. Remaining: verify.md, retrospective.md, archive (+ task 7.3 spec-prose fix after sync), PR." `verify.md` landed at `63d1c32`; this retrospective is the next artifact, and `openspec archive` + `gh pr create` follow it. Marking this ✓ now would be a prospective claim, which is the one thing this format exists to prevent.
  - **How to prevent recurrence**: `one-off — schema boundary case, no prevention possible`. It is a boundary because the schema's own ordering puts `retrospective` strictly before branch-finishing (`archive` and the PR are downstream of it), so **every** retrospective written in artifact order must record this row as not-yet-run. The honest fix, if any, is a schema graph note that this row is expected `✗ (pending)` rather than a compliance failure — not a change to how this cycle behaved.

## 5. Surprises

- **`StdioServerTransport` never fires `onclose` on stdin end.** It registers `'data'` and `'error'` on stdin and nothing else. Every design and test in the branch assumed transport close was observable; the fix had to install its own stdin handling (`9486bef`). Nothing in the SDK's shape advertises this.
- **`summary.embedded` counts notes that never called `embed`.** A note under `MIN_CHARS` writes a shard with `embedding: null` and increments the counter anyway. A guard was written on the assumption that `embedded > 0` implies "something got embedded"; it does not.
- **chokidar's `ignored` callback always receives an absolute path** — never a path relative to the watch root — so any predicate written against "the path" silently inherits the whole prefix. Only established by probing the real library.
- **chokidar v4 is pure JS.** The plan (and prior mental model) had it as an optional native dependency with a JS fallback. Its only dependency is `readdirp`, which is why the npx-distribution constraint in ADR-0013 survives untouched.
- **Removing a subsystem can lower the test count legitimately.** 1277 → 1255 looked like regression until it was decomposed by suite. A cycle's "tests went up" heuristic is worthless across a deletion task; the per-suite accounting is what carries the signal.
- **A warm restart over a compatible corpus reports `indexing` for ~500 ms before `ready`** (manifest read + snapshot load are async, status starts at `indexing`). A client that searches once on connect and caches would see "still building" for a fully indexed vault. Inherent to D3's "never block startup"; parked as a follow-up.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **A "this branch is unreachable" claim is only valid against the implementation that makes it unreachable — re-derive it when that implementation is being replaced in the same change.** → **Promote to memory** (type: feedback)
  > **Why**: In Task 7 the `snap.sources.size === 0` branch was parked as dead code because the Smart Connections loader threw before ever returning empty. Task 8 swapped in `loadCorpusSnapshot`, which returns an empty Map — the guard was reachable again and was gone, and a cold vault whose every embed failed reported `ready` over an empty corpus (`3817474`). No test caught it; the final whole-branch review did.
  > **How to apply**: when parking or deleting a defensive branch during a migration, name the callee whose behaviour makes it unreachable and check whether that callee is itself in scope for the change. If it is, the branch is a guard, not dead code — carry it forward.

- [ ] 🔴 **A capability whose every test injects a seam is not verified — run it once end-to-end against the real dependency before calling it done.** → **Promote to memory** (type: feedback)
  > **Why**: 1255 tests passed while the server did not exit when its client disconnected. `test/server-modules.test.ts` hand-fired `transport.onclose?.()` on a fake, proving the fan-out works once called but never that anything calls it. The end-to-end smoke — real model, real chokidar, real disk, real wall clock — was the only thing that could find it (`9486bef`). The same shape hid the watcher's dead ignore regex, whose plan-supplied tests all injected a fake watcher factory.
  > **How to apply**: at the end of any change that introduces or wires a real external mechanism (a watcher, a transport, a model, a process lifecycle), before verify: run it once with nothing faked and assert the observable outcome, not the internal call.

- [ ] 🟡 **Code snippets inside a plan are unverified drafts — an implementer or reviewer who contradicts one on probed evidence is doing the job, not deviating.** → **Promote to memory** (type: feedback; extends the existing _opsx plan-authoring pitfalls_ entry, which covers lint-clean snippets but not runtime correctness)
  > **Why**: three defects this cycle came from the plan's own text, not implementer error — a watcher ignore regex written against absolute paths (silently dead watcher, `e4d617f`), a `transport.onclose` assignment that clobbers the MCP SDK's handler, and a `void dispose()` shape over a `Promise.all` fan-out that raises `ERR_UNHANDLED_REJECTION`, defeating the very design decision (D10) it implemented (`e2c912d`).
  > **How to apply**: when a task brief supplies a code snippet touching a third-party API, verify the API's actual contract (probe it, read the installed source) before treating the snippet as binding. Rulings against plan text on probed evidence are the expected outcome, not an escalation.

- [ ] 🟡 **Build a guard from counters you have read the producer of — not from what the counter names imply.** → **Promote to memory** (type: feedback)
  > **Why**: the first fix for the false-`ready` defect included `embedded === 0`, on the assumption that `summary.embedded` counts successful embeds. A note under `MIN_CHARS` calls `embed` zero times, writes `embedding: null`, and increments it anyway — so one stub note masked a wholly failed pass, and `snapshotLoaded` latched so it never re-checked. The fix reproduced the exact defect it was dispatched to fix.
  > **How to apply**: before writing a condition over aggregate counters (`failed`, `embedded`, `renamed`, `total`), open the code that increments each one and enumerate the shapes that increment it without doing the thing its name suggests.

- [ ] 📌 **A durable document that will only become true after a later commit needs a hard gate, not a promise.** → **One-off**
  > **Why**: ADR-0014 asserted that a file "is deleted" and ADR-0006 is "fully superseded" four commits before either was true (`e334250` → `eafb520`). It was ruled acceptable because the branch ships as one PR and rewording an immutable ADR twice is worse — and the controller check plus final review did hold. It doesn't generalise cleanly: the alternative (write the ADR last) conflicts with the parallel-safe documentation group, and the real safeguard here was one PR boundary. Recorded so the next cycle facing it sees the trade already weighed rather than re-deriving it.
