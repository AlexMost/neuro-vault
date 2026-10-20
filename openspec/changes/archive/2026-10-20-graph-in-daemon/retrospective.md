# Retrospective: graph-in-daemon

> Written: 2026-10-20 (after verify passed, `verify.md`).
> Commit range: PR 1, #210, squash-merged to `main` as `ba5dad3` (tasks 1–7); PR 2 on branch
> `claude/graph-cutover` from `ba5dad3`: `76616ee`, `6c246fc`, `3768d57`, then this close-out commit.
> Worktree: `.claude/worktrees/per-model-corpus-752fc5`, one session for both PRs.

The change gives each vault directory one wikilink graph, held by the vault entry. Every attached session and the
lexical tie-break read it, the sessions through batched `graph.*` reads on their vault client. Only a
`--no-semantic` session hosts a graph of its own. It closes #172.

---

## 0. Evidence

- **Commit range**: PR 1 had 9 commits, squashed to `ba5dad3`. PR 2 so far: `76616ee` (8.1/8.2), `6c246fc` (9.1),
  `3768d57` (review follow-ups), then the close-out.
- **Diff size**:
  - PR 1: 39 files, +1665 / −45. Of that, `src/` is 11 files, +276 / −21; the rest is tests, docs and the change
    artifacts.
  - PR 2: 47 files, +670 / −245 before the close-out. Of that, `src/` is 12 files, +124 / −73.
- **Tasks done**: 15/16 before the archive. 10.1 is this close-out.
- **Active hours**: about 2 h 15 min in total.
  - PR 1: about 1 h 15 min, from the first read to the PR, including the brainstorm and plan.
  - PR 2: about 1 h, from approval to verify.
- **Subagent dispatches**: 2, each a read-only whole-branch review, one per PR. Every task ran natively.
- **New external dependencies**: none.
- **Bugs encountered post-merge**: none. PR 1 merged with CI green and no fix commit.
- **OpenSpec validate state at archive**: 26 valid / 0 invalid (`verify.md` §1).
- **Test coverage signal**:
  - Test count: 2830 passed / 4 skipped at PR 1's head (`ba5dad3`); 2841 / 4 skipped at PR 2's head.
  - Eval on the owner's vault: identical before and after on both pipelines (`verify.md`).

Commit chain (in time order):

```
ba5dad3 PR 1 (#210): IGraphReader, the entry's graph as a reader, graph.* rows and service, the view
76616ee refactor(graph): sessions read the vault entry's graph                         [PR 2, 8.1/8.2]
6c246fc docs: one graph per vault, in the vault entry                                    [PR 2, 9.1]
3768d57 fix(graph): review follow-ups on the cut-over                                    [PR 2]
```

---

## 1. Wins

- **PR 1 was free of breaking changes, because the entry already built a graph.** The tie-break's
  `WikilinkGraphIndex` became the shared one: `IVaultEntry.graph` wraps the same object (`e98e66f` in PR 1), so no
  second copy ever existed. A test spying on `rebuild` pins that one build serves both readers.
- **Batched reads kept every consumer at one call per question.** The cut-over touched 12 `src/` files with
  +124 / −73 lines (`76616ee`). Not one consumer needed a loop of graph calls, and `listMatchingPaths` dropped its
  graph entirely.
- **The integration test proves sharing, not just agreement.** In `vault-client.test.ts`, "two sessions read one
  entry graph" writes a link between two sessions' reads and checks that neither sees it within the TTL. A
  session-built graph would have rebuilt and seen it.
- **The eval matched as JSON on both pipelines** (`verify.md`). This was expected: the eval's path changed only in a
  type.

## 2. Misses

- 🟡 [painful | evidence: `3768d57`] **The first one-call assertions in the tool tests could not catch a per-note
  loop.** They ran on a one-note scan. The PR 2 reviewer caught this, and the tests now use two or three notes.
  Lesson: an assertion that a tool makes "one call" needs at least two items to be able to fail.
- 🟡 [painful | evidence: PR 1 `c13c0bb`] **The PR 1 docs claimed that a disposed entry answers `GRAPH_FAILED`.**
  `VaultEntries` drops the record before disposing the entry, so the answer is `NOT_ATTACHED`. The plan's Review
  Focus made the same claim; I had not grepped `vault-entries.ts` before writing it.
- 📌 [nit | evidence: `3768d57`] **`collectMatchingPaths` first asked for counts before compiling the filter.** A
  rejected filter therefore paid a full-scan graph call. Fixed: the matcher compiles first, and excluded paths are
  not sent.

## 3. Plan deviations

| Plan task | What changed | Why |
| --- | --- | --- |
| apply executor | Native execution, with one fresh reviewer per PR, instead of a subagent per task | The six PR 1 tasks were small and each built on the last one's interface. One reviewer on the whole branch caught the cross-task issues, such as the doc claims. |
| 8.1 | `lexicalOnlyVaultFactories` (a const) became `createLexicalOnlyVaultFactories()` | Under `--no-semantic`, the one graph per root needs a memo map scoped to one server start, not to the module. |
| 8.1 | `makeTestRegistry`'s default standalone lexical reader tie-breaks over an empty sync graph | An `IGraphReader` cannot feed the synchronous tie-break. No test depended on the tie-break coming from the entry's test graph. |
| 8.2 | The `search_notes` test that had a vault fail on `ensureFresh` now fails on `backlinkCounts` after the legs ran | A vault with no match no longer reads the graph, so the test's broken vault needed a match. |

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ✓ (forks decided by this session, owner-approved after PR 1) |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✗ |
| superpowers:subagent-driven-development | ✗ |
| (transitive) superpowers:test-driven-development | partly (tests written with or just before each implementation) |
| (transitive) superpowers:requesting-code-review | ✓ (one whole-branch review per PR) |
| superpowers:finishing-a-development-branch | ✓ (push + `gh pr create`) |

### Deliberately Skipped Skills

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the skill as a whole.
  - **Why this cycle**: the session already ran in an app-made worktree (`.claude/worktrees/per-model-corpus-752fc5`).
    PR 2 branched from `origin/main` inside it after PR 1 merged.
  - **How to prevent recurrence**: `skill doc` — the bridge's apply instruction could say that an app-made worktree
    satisfies this step.
- **`superpowers:subagent-driven-development`**
  - **What was skipped**: the per-task implementer and reviewer subagents.
  - **Why this cycle**: plan Tasks 1–6 were each under 100 lines of `src/`, and each consumed the previous task's
    interface (`IGraphReader` → entry → service → view). I made the call after writing the plan. One whole-branch
    review per PR replaced the per-task reviews, and it found 15 Minor issues and nothing above Minor.
  - **How to prevent recurrence**: `one-off` — for a chain of small, interface-dependent tasks, native execution plus
    one branch review is the cheaper fit. Record that choice in the plan header, not afterwards.

## 5. Surprises

- **`--no-semantic` builds no vault clients at all** (`lexicalOnlyVaultFactories`, decision F1 of
  `daemon-lexical-search`). The brief suggested the graph might attach anyway. Keeping a session-hosted graph there
  was the only option that kept "no daemon starts" true.
- **`listMatchingPaths` never needed a graph.** Its compiled filter can name only paths, `tags` and frontmatter keys,
  and it never refreshed the graph anyway. Dropping the dependency was a free simplification.

## 6. Promote candidates → long-term learning

- [ ] 🟡 A "makes one call" test needs at least two items to be able to fail.
  → **Promote to** memory (feedback)
  > **Why**: three tool tests in `76616ee` asserted one graph call over a one-note scan, so a per-note loop would
  > also have passed (`3768d57`).
  > **How to apply**: whenever a test pins "one batched call", feed it two or more items and assert the call's
  > argument list.
- [ ] 📌 Grep the lifecycle before naming an error code in a doc.
  → **Promote to** one-off (covered by the existing memory "Verify code claims in durable docs")
  > **Why**: the `GRAPH_FAILED` row claimed "an entry disposed mid-read", but the record goes first, so the answer is
  > `NOT_ATTACHED`.
  > **How to apply**: before writing "X answers code C when Y", find the code path that produces Y.
