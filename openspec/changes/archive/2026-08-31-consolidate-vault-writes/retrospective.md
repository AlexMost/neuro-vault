# Retrospective: consolidate-vault-writes

> Written: 2026-08-31 (after verify passed)
> Commit range: `8327384..d00fad4`
> Worktree: three worktrees, one per group; group 3 at `neuro-vault-wt-g3`

---

## 0. Evidence

- **Commit range**: `8327384..d00fad4` (3 commits — one merge commit per PR, plus group 3's)
  - PR 1 `#122` — `52c63a6` fold `FsVaultWriter` into the disk provider
  - PR 2 `#123` — `d00f6cf` resize `VaultProvider` to note-file operations
  - PR 3 (this branch) — `d00fad4` docs: ADR-0016 + architecture refresh
- **Diff size**: 54 files changed, +3446 / −998 across the whole change; group 3 alone is 10 files, +105 / −37
- **Tasks done**: 16/16 at archive (14/16 at the moment this retro was written — 3.7 is sequenced after archive by design, 3.9 is the step this retro feeds)
- **Active hours**: ~3 sessions, one per PR group
- **Subagent dispatches**: 0 in group 3 (the plan marked 3.1–3.5 parallel-safe; the user directed sequential execution). Groups 1–2 used subagent-driven-development per the schema.
- **New external dependencies**: none
- **Bugs encountered post-merge**: none
- **OpenSpec validate state at archive**: pass (19/19)
- **Test coverage signal**: vitest 110 files / 1371 tests passing; group 3 changed no `src/` or `test/` file, so the count is deliberately flat against PR 2

Commit chain (時序):

```
8327384 Add buildSingleVaultTool: one owner for the single-vault dispatch contract (#121)  [base, prior change]
52c63a6 refactor(operations): fold FsVaultWriter into the disk provider (#122)             [group 1]
d00f6cf refactor(vault): resize VaultProvider to note-file operations (#123)               [group 2]
d00fad4 docs: record ADR-0016 and refresh the write-path architecture docs                 [group 3]
```

---

## 1. Wins

- [evidence: `52c63a6`, `src/modules/operations/fs-vault-provider.ts` `readRaw`/`writeRaw`] The #113 class of bug now has one place to be wrong. Two independent fs-error mappings over the same vault root collapsed into one, and `edit_note` kept its coded-`WRITE_FAILED` assertions across the move.
- [evidence: `src/modules/operations/tool-helpers.ts:17` `resolveIdentifier`] The "exactly one of `name` or `path`" rule went from four implementations at two depths — one of which was not an XOR — to one. `grep -rn "exactly one of name or path" src/` returns a single construction site.
- [evidence: design D3 → `resolveExisting` / `resolveNew`] Splitting *validation* (once, tool layer) from *resolution* (two named private modes) is what let "one rule" be true without lying about `create_note`'s `kind: 'name'` meaning something different from everyone else's. A single resolver with an `allowMissing` flag was considered and rejected — it is the exact shape this change existed to remove.
- [evidence: `test/operations/tools/_helpers.ts`, `test/lib/obsidian/vault-overview.test.ts`] Stub count went from three to one. Moving the aggregates onto free functions over a `VaultReader` meant the overview tests seed notes instead of stubbing an aggregate method — the assertions got more honest, not just fewer.
- [evidence: task 3.6 sweep → `docs/architecture/vault-reader.md:44`] The `docs/`-wide sweep earned its place. Tasks 3.2–3.5 named six architecture files; a seventh was stale in a way none of them covered, and only the unrestricted grep found it.

## 2. Misses

- 🟡 [painful | evidence: tasks.md 3.2–3.5 `file:line` references] Every line number in the group 3 task text was stale by the time group 3 ran, because the plan was written before PRs #121–#123 landed. The referenced *content* was all still present, so nothing was lost — but each task needed a re-grep before it could be executed. Line numbers in a plan that spans multiple merged PRs are write-only.
- 🟡 [painful | evidence: task 3.5 vs `src/lib/obsidian/vault-aggregates.ts`] Task 3.5 said to *delete* the `vault-writer.ts` bullet from `obsidian-lib.md` and said nothing about adding one. But `obsidian-lib.md` is a per-file enumeration of `src/lib/obsidian/`, and group 2 added a file to that directory. A doc task that says "delete X" from an enumeration is incomplete unless it also asks what the change *added* to the thing being enumerated.
- 📌 [nit | evidence: `docs/adr/0009-disk-direct-vault-operations.md:24`] Bullet (a) reads false against current code in its bolded claim, and is corrected only by an italic follow-up note appended beneath it. That is the right convention for an Accepted ADR, but a reader skimming bold text gets the wrong answer before reaching the correction.

## 3. Plan deviations

| Plan task | What changed | Why |
| --------- | ------------ | --- |
| 3.1 | ADR filename resolved to `0016-one-disk-module-owns-note-writes.md` | The plan left `<slug>` open |
| 3.2–3.5 | Every `file:line` re-derived by grep before editing | Line numbers predate #121–#123; content was all present, positions had drifted |
| 3.5 | Added a `vault-aggregates.ts` bullet the task did not ask for, and refreshed the `vault-overview.ts` bullet's deps | `obsidian-lib.md` enumerates every file in `src/lib/obsidian/`; group 2 added one and changed another's deps |
| 3.6 | Fixed `docs/architecture/vault-reader.md`, outside the six files 3.2–3.5 named | This is what the sweep is for; stopping at already-touched files would have made the step ceremonial |
| 3.1–3.5 | Executed sequentially, not concurrently | Plan marked them parallel-safe; user directed sequential |
| ADR-0009 | Body untouched; INDEX row gains "refined in part by 0016" | Accepted ADRs are historical records. The method enumeration at :14 is what 0016 narrows, and the INDEX note is how 0003 → 0015 recorded the same relationship. Bullet (a)'s inaccuracy predates this change and already carries its own follow-up correction — out of scope, and already handled. |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✗ (group 3 only) |
| (transitive) superpowers:test-driven-development | ✓ (groups 1–2) / n/a (group 3) |
| (transitive) superpowers:requesting-code-review  | ✓ (PR review between groups) |
| superpowers:finishing-a-development-branch       | ✓    |

### Deliberately Skipped Skills

**superpowers:subagent-driven-development — group 3 only**

- **What was skipped**: subagent dispatch for tasks 3.1–3.6. Groups 1 and 2 used it as the schema intends.
- **Why this cycle**: two concrete conditions. (1) The user explicitly directed sequential execution — "Whether to dispatch them concurrently is my call, not the plan's — do it sequentially unless I say otherwise." (2) Group 3 is documentation-only with no `src/`/`test/` changes in scope, so there is no TDD loop for a subagent to run, and the tasks share one coherence requirement — every doc must tell the same story about the same seam — which is exactly the property that fan-out degrades.
- **How to prevent recurrence**: not a recurrence to prevent; it is a **scope-judgment rule** worth stating. A documentation group whose files must agree with each other is a poor fan-out candidate even when the plan marks the files disjoint — file-disjointness is not narrative-disjointness. The plan's "parallel-safe" marker measured the former and was read as licensing the latter.

## 5. Surprises

- [evidence: `docs/adr/0009-disk-direct-vault-operations.md:24`] The ADR-0009 bullet (a) inaccuracy flagged going in turned out to be **already corrected** — an italic `_Follow-up (2026-08, change inline-tags-in-list-tags)_` note sits directly beneath it. The premise that it was an uncorrected stale claim was wrong; the repo had already applied its append-don't-rewrite convention. Grepping the bullet's full text rather than the flagged line was what surfaced it.
- [evidence: `docs/guide/`, `README.md` sweep returned zero] The guide layer really was clean. The temptation in a "sweep all of X" task is to produce edits proportional to the scope swept; the honest outcome here was no edits, and the task text explicitly warned against inventing them.
- [evidence: `test/operations/tools/_helpers.ts` `makeProvider`] The surviving `VaultProvider` seam's real justification is narrower than the one `docs/architecture/vault-provider.md` had been asserting for a year ("an alternative backend — a REST API, an Obsidian plugin bridge — could replace `FsVaultProvider`"). Nothing in the repo was ever going to build that. Writing ADR-0016 forced the honest version into the doc: it is a stub point for tool tests, and adding a method to it is a claim that a test needs to stub that behaviour.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Plan `file:line` references decay across PR boundaries** — a multi-PR plan's later groups must re-grep every `file:line` it cites, because earlier merged groups move them.
  → **Promote to** memory (feedback)
  > **Why**: the plan for group 3 was written before PRs #121–#123 landed; all of its line numbers had drifted while the referenced content was intact. Executing them literally would have edited the wrong lines or reported false "not found".
  > **How to apply**: when a plan group runs after another group of the same change has merged, treat every `file:line` in the task text as a search hint, not an address. Grep the quoted content first.

- [ ] 🟡 **A "delete X" task on an enumeration doc is half a task** — ask what the change *added* to whatever the doc enumerates.
  → **Promote to** memory (feedback)
  > **Why**: task 3.5 said only to delete the `vault-writer.ts` bullet from `obsidian-lib.md`, a per-file listing of `src/lib/obsidian/`. The same change had added `vault-aggregates.ts` to that directory, and no task mentioned it. Executing 3.5 literally would have left the enumeration silently incomplete — a worse failure than a stale bullet, because nothing points at the gap.
  > **How to apply**: when a doc task removes an entry from a doc that enumerates a directory, interface, or table, diff that directory/interface against the doc before finishing — the removal and the addition are the same edit.

- [ ] 📌 **File-disjoint ≠ safe to fan out for documentation** — a doc group whose files must tell one coherent story is a poor parallel candidate even when the files don't overlap.
  → **Promote to** memory (feedback)
  > **Why**: `plan.md` marked 3.1–3.5 "parallel-safe: touch disjoint files". True for merge conflicts, false for the actual risk — six docs describing one seam, which five independent agents would describe five ways.
  > **How to apply**: before dispatching a documentation group concurrently, ask whether the outputs have to agree with each other. If they do, the shared narrative is the sequential dependency the file list doesn't show.

- [ ] 📌 **An Accepted ADR's stale claim may already carry its correction** — read the whole bullet before deciding it needs one.
  → **Promote to** one-off (this cycle's specific finding; the general habit is already covered by [[feedback_verify_code_claims_in_durable_docs]])
  > **Why**: ADR-0009's bullet (a) was flagged as an uncorrected inaccuracy; it in fact carries an appended follow-up note recording exactly that correction. The bolded claim is stale, the bullet as a whole is not.
  > **How to apply**: when a durable doc looks stale, grep the surrounding block, not the flagged line — this repo's convention is to append a follow-up beneath an Accepted ADR's claim rather than to rewrite it.
