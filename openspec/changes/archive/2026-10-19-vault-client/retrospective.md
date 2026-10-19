# Retrospective: vault-client

> Written: 2026-10-19 (after verify passed, `verify.md`).
> Commit range of the change: PR 1, #200, squash-merged to `main` as `70b7ee6` (tasks 1–6); PR 2 on branch
> `claude/cranky-raman-d3c80e` from `bd5823c`: `9004465`, `51376fb`, `40aaffa`, `2875b3d`, then verify, this
> retrospective and the archive.
> Worktree: `.claude/worktrees/unruffled-curie-5a3b22` for PR 2, a session started cold from a hand-over note (the
> PR 1 session was archived).

The change gave every vault root one `IVaultClient` per side, the session's only path to a vault entry, and made the
semantic backend and the lexical reader views over it. The in-process side runs the daemon's own service handlers
over a loopback, so the switch, the attach per epoch, the timeouts and the `NOT_ATTACHED` forget each live in one
place, and the embedding handshake shares the attach's epoch gate. It closes #193.

---

## 0. Evidence

- **Commit range**: PR 1 squashed to `70b7ee6`. PR 2: `9004465` (7.1), `51376fb` (7.2), `40aaffa` (8.1),
  `2875b3d` (9.1), then the verify/retrospective/archive commit.
- **Diff size**: PR 2, 34 files, +792 / −1050 before the openspec artifacts. Three source files and three test
  files deleted; the lexical path lost two facades (171 lines) for one 78-line view.
- **Tasks done**: 18/18 at archive. 9.2 closes with the archive and the PR.
- **Active hours**: PR 2 took about 40 min from the first code edit to the verify report (2026-10-19, 23:05–23:25),
  plus reading the change directory and the PR 1 code first.
- **Subagent dispatches**: PR 2, 1 (a read-only review of the diff before the PR). Every task ran natively.
- **New external dependencies**: none.
- **Bugs encountered post-merge**: none so far. PR 1 merged without a fix commit; its body closed #193 early (see
  §2).
- **OpenSpec validate state at archive**: `openspec validate --all` 25 valid / 0 invalid before archive
  (`verify.md` section 1).
- **Test coverage signal**: 2584 passed / 4 skipped at `2875b3d` (`main` 2586: net −2, 17 deleted with their files,
  15 added). Every scenario of the deleted test files mapped to a counterpart (`verify.md` §4.2). The owner's-vault
  eval was identical before and after on both pipelines (`verify.md` section 0).

Commit chain (in time order):

```
70b7ee6 PR 1 (#200): method table, shared service map, link, epoch gate, attachment, client, semantic view
9004465 refactor(lexical): the lexical reader as a view over the vault client                 [PR 2, 7.1]
51376fb refactor(vault-entry): name the VaultEntries key a client id                           [PR 2, 7.2]
40aaffa refactor(semantic): run the embedding handshake on the epoch gate                      [PR 2, 8.1]
2875b3d docs: the lexical reader as a view, the loopback's own client id                       [PR 2, 9.1]
…       docs(openspec): verify, retrospective and archive vault-client                         [PR 2, 9.2]
```

---

## 1. Wins

- **PR 1's seam made PR 2 small and mechanical.** The lexical view is 78 lines over `client.call('lexical.search')`;
  `createVaultClients` lost its `IVaultSide` pairs and the second factory path. Nothing in the client, its adapters,
  the link or the attachment changed except comments and the loopback's `clientId` option going away, which is the
  D10 cost claim holding for a read that already existed.
- **The in-process lexical path now crosses the same validation as the daemon's.** The `--no-shared` end-to-end
  test in `vault-client/factory.test.ts` drives both views over real `VaultEntries` with `Float32Array` anchors, and
  `lexical/parity.test.ts` still gives one answer for the standalone reader and the view on both sides.
- **The deleted tests were mapped before they went.** Writing the mapping (`verify.md` §4.2) found three scenarios
  with no counterpart yet (a failed call never flips the switch, `lexical.search`'s 30 s timeout and key, the
  in-process `NOT_ATTACHED` re-attach for the lexical leg), and each got a test before the delete.
- **The eval was a measured no-op.** Before (`main` in a throwaway worktree) and after match on metrics and every
  per-query field, for both pipelines.

## 2. Misses

- 🟡 [painful | evidence: issue #193 history, `vault-client-pr2-handover.md`] **PR 1's body closed #193 at its
  merge.** It contained the text "`Closes #193`" inside a heading about PR 2, and GitHub honours the keyword
  anywhere in the squash body. The issue had to be reopened. Its long body lines also failed commitlint on `main`.
  PR 2's body carries the keyword once, deliberately, and every line is under 100 characters.
- 📌 [nit | evidence: `verify.md` section 0] **The owner's vault had uncommitted edits during the baseline eval
  run.** The scores matched, so it did not matter here, but a `-dirty` `vault_sha` would hide a real drift if the
  edits had touched a golden note.

## 3. Plan deviations

| Task | What changed | Why |
|------|--------------|-----|
| 7.1 | `createVaultClients` lives in `vault-client/index.ts` itself (the task's wording), beside the module's re-exports; `backend/index.ts` keeps only `createDisabledSemanticBackend`. | As tasked. Noted because `index.ts` is now both a barrel and the factory. |
| 7.1 | `test/semantic/backend/attachment.test.ts` was moved to `test/semantic/vault-client/attachment.test.ts` over `createAttachment` and a fake link, not dissolved into client tests. | Its ten scenarios are the attachment's own rules (epoch replacement, three attempts, missing key); the attachment is a vault-client module, so its test lives beside it. |
| 7.1 | `test/semantic/backend/factory.test.ts` moved to `test/semantic/vault-client/factory.test.ts`, gained the `--no-shared` end-to-end test the PR 1 hand-over listed, and asserts "one loopback id" instead of `LOCAL_CONNECTION_ID`. | It follows `createVaultClients`; the fixed id no longer exists. |
| 7.2 | The `NOT_ATTACHED` messages ("… is not attached on this connection") were left as they are. | "Names and doc comments only": the messages reach the wire and the tools' stderr. |
| 8.1 | A caller whose handshake lands on a replaced epoch proceeds without retrying on the new one. | That is what the old code did too; the task asked only that such an answer commit nothing. |
| 9.1 | Also fixed stale facade wording in `src/server.ts`, `test/semantic/tools/search-notes.test.ts`, `test/server-modules.test.ts` and `test/integration/session-daemon.test.ts` comments. | Found by the same grep; the parallel session that owned `search-notes.test.ts` is archived. |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (planning session, `brainstorm.md`) |
| superpowers:writing-plans                        | ✓ (`plan.md`; PR 2 is its outline) |
| superpowers:using-git-worktrees                  | ✓ (PR 2 ran in an app-made worktree) |
| superpowers:subagent-driven-development          | ✗ |
| (transitive) superpowers:test-driven-development | ✓, partly (see below) |
| (transitive) superpowers:requesting-code-review  | ✓ (a read-only reviewer on the PR 2 diff before the PR) |
| superpowers:finishing-a-development-branch       | ✓ (one PR via `gh pr create`) |

TDD, partly: 8.1 was red-first (the new test failed with `expected 2 to be 8` before the gate). 7.1 was a move of
behaviour already pinned by the tests it replaced; the new view and client tests were written against the new view
and run green, not watched failing.

### Deliberately Skipped Skills

- **`superpowers:subagent-driven-development`**
  - **What was skipped**: the whole skill for PR 2; every task ran natively.
  - **Why this cycle**: PR 2's plan was an outline (plan.md "PR 2 outline"), and 7.1 is one coupled move: the view,
    `createVaultClients`, the deletions and the port of five test files had to land in one commit for the
    typecheck gate (memory `feedback_type_change_with_call_sites`). 7.2 and 8.1 were a few lines each.
  - **How to prevent recurrence**: `scope-judgment rule`, as in `retrieval-outcome-records`: when a plan's tasks
    share one type change, plan.md §Execution should name native execution and the review that replaces the
    per-task reviewer. This PR's outline did not; a second change with the same answer makes it a schema
    candidate (§6).

## 5. Surprises

- **The in-process lexical result now round-trips the wire shape.** The old local reader returned the entry's
  `ILexicalResult` as is; the view gets the `lexical` handler's snake_case answer and maps it back. The parity test
  and the new in-process test show the round trip is lossless for every field `ILexicalResult` has.
- **The old handshake shared one promise across epochs.** A caller on a new connection joined the old
  connection's `embed.initialize` and could take its batch size. Nothing had pinned that; the gate fixed it as a
  side effect of 8.1.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A PR body is a squash commit body: name a closing keyword only in the PR that should close the
  issue, and never inside prose about a later PR.** → **Promote to memory** (type: project; already covered by
  `project_squash_merge_body_pitfalls`, confirm it names the "heading about a later PR" case)
  > **Why**: #200's body closed #193 at PR 1's merge because a heading mentioned PR 2's keyword.
  > **How to apply**: before `gh pr create` on a multi-PR change, grep the body for `Closes|Fixes|Resolves #`.

- [ ] 📌 **Native execution is the norm for a change's tail PR; plan.md §Execution should say so up front.** →
  **Promote to schema** (superpowers-bridge plan template: an "Execution" line per PR)
  > **Why**: the second change in a row skipped subagent-driven-development for the same reason (one coupled
  > type move), and only the retrospective recorded it.
  > **How to apply**: when writing plan.md for a multi-PR change, state per PR whether it runs natively and what
  > review replaces the per-task reviewer.
