# Retrospective: unified-vault-scope

> Written: 2026-08-24 (after verify passed)
> Commit range: `40ba2b0..0145118`
> Worktree: `/Users/amostovenko/git/neuro-vault/.claude/worktrees/unified-vault-scope` (branch `worktree-unified-vault-scope`, unpushed at write time)

---

## 0. Evidence

- **Commit range**: `40ba2b0..0145118` (11 commits)
- **Diff size**: +931 / -38 lines across 31 files
- **Tasks done**: 11/11 (`grep -cE '^\s*- \[x\]' tasks.md` → 11; `- [ ]` → 0)
- **Active hours**: ~1h10m wall clock (14:33 worktree baseline → 14:45 verify), of which ~45 min was subagent execution
- **Subagent dispatches**: 12 — 5 implementers (T1+T2 batched, T3, T4+T5 batched, T6, T7), 5 task reviewers, 1 final whole-branch reviewer (opus), 1 fix-wave implementer (opus) + 1 scoped re-reviewer
- **New external dependencies**: `picomatch@^4` (MIT, direct prod dep — was transitive-only under `micromatch`), `@types/picomatch` (MIT, dev)
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass — `Totals: 13 passed, 0 failed (13 items)`
- **Test coverage signal**: vitest 1019 → 1056 tests (+37), 85 files, 0 failures. eslint clean, `tsc --noEmit` clean, `npm run build` success.

Commit chain (時序):

```
59b3de4 build: add picomatch as a direct dependency
0a7b9dc feat: add vault scope module (dot rule, defaults, gitignore subset, config union)
dd6c29e feat: load per-vault scope from root gitignore and .neuro-vault/config.json
60500ff fix: warn explicitly on null-shaped scope config instead of relying on a thrown TypeError
a86291f feat(vault-scope): exclude Templates/ and gitignored paths from note discovery
64a890b test: end-to-end vault scope membership over a real temp vault
81d1676 docs: vault-scope concept file and scan-behaviour sweep
efe8fc8 fix(vault-scope): validate exclusion entries and warn on silent scope collapse
3a8527c test(vault-scope): make the e2e agreement test earn its name
e4cadfe docs(vault-scope): correct the coverage claims and document the allowlist hazard
0145118 test(vault-scope): pin that one bad exclusions entry cannot fail server start
```

---

## 1. Wins

- The chokepoint bet paid off exactly as designed. `FsVaultReader.scan` really was the only enumeration path: the final reviewer independently grepped `\.scan(` across `src/` and found all eight consumers (`vault-overview.ts:70`, `wikilink-graph.ts:86`, `lexical-index.ts:51`, `list-matching-paths.ts:58,64`, `resolve-note-name.ts:14`, `query-notes.ts:76`, `fs-vault-provider.ts:293,311`) inheriting scope with **zero** code changes of their own. `fast-glob`/`readdir` appear nowhere else outside the two Smart Connections corpus files.
- Backward compatibility held by construction: `scope?: VaultScope` is optional, and the reviewer verified all ~15 pre-existing `new FsVaultReader(...)` sites across `src/` and `test/` needed no change and behave identically.
- The plan's decision to write the module code *inside* the plan made the first three implementer dispatches near-transcription: `0a7b9dc` and `dd6c29e` were byte-for-byte matches of the plan's code blocks, reviewed clean on the first pass with zero fix rounds. Five task reviews, five clean verdicts, zero fix rounds — the whole fix cost landed in one place (the final review) rather than being smeared across the cycle.
- The final whole-branch review earned its seat. It found a real **Critical** that five clean task reviews had missed, and it found it by *executing* the code rather than reading it: `{"exclusions": [""]}` makes picomatch throw out of `createVaultScope` → `loadVaultScope` → `VaultRegistry.create`, taking down server startup **for every vault** on one vault's config typo — a direct violation of the spec's "SHALL NOT prevent the server from starting". It also measured `{"exclusions": ["!Keep/**"]}` inverting membership and making the two views disagree, violating the "two views SHALL agree" requirement.
- The e2e test (`64a890b`) was proven to have teeth rather than assumed to: the implementer removed `scope` from the fixtures and confirmed 3 of 4 assertions flipped red while read-by-explicit-path correctly stayed green — the D7 discovery-not-ACL boundary demonstrated, not asserted.

## 2. Misses

- 🔴 [blocking] Untrusted input validation was absent from the design, the spec deltas, the plan, and all five task reviews. `.neuro-vault/config.json` is the one place user-authored data enters this module, and nothing anywhere said "validate it". The spec had already written down the failure contract (`SHALL NOT prevent the server from starting`) — what was missing was noticing that the contract has a *hostile-input* dimension, not just an I/O-failure dimension. D5 enumerated unreadable / invalid-JSON / invalid-shape and stopped there; a well-formed config with a malicious-or-typo'd *entry* was outside the enumeration.
- 🟡 [painful] The behaviour-change note was aimed at a target that does not exist. Design's #1 risk mitigation said "CHANGELOG entry states the behaviour change explicitly", and the plan implemented it as a note in a `docs:` commit body — but this repo's `commit-and-tag-version` renders Features/Bug Fixes from commit **subjects** only, so the note was invisible to every user. Nobody checked how the CHANGELOG is actually produced before designing the mitigation around it. Cost: a non-interactive history rewrite (`a86291f`) at the very end of the cycle.
- 🟡 [painful] `docs/guide/finding-notes.md` shipped a claim a user could directly falsify — that scope applies to "any of the tools below", when `get_similar_notes`, `find_duplicates`, and the semantic leg of `search_notes` read the Smart Connections corpus and are **not** scope-governed in this slice, by design. The doc-sweep task reviewer verified every claim in the *new concept file* against source and re-ran the sweep greps, but the sweep's own new prose in the guide layer was not held to that standard.
- 🟡 [painful] `openspec archive` silently deleted two contract scenarios from the main spec. A `## MODIFIED Requirements` delta replaces the **entire** requirement block, scenarios included — and this change's `headless-vault-operations` delta carried only 6 of the main spec's 8 scenarios plus its new one. Syncing therefore dropped "Inline-only tags are not filterable" and "Property names are counted across notes", neither of which this change had any business touching. Caught by reading `git diff` on the synced spec after archive; restored in both the main spec and the archived delta (so a replay is idempotent). Nothing in `openspec validate` flags this — a delta that deletes scenarios is structurally valid.

- 📌 [nit] Three task reviews independently flagged unvalidated `configExclusions` as a **Minor** ("worth a note for whichever later task first reads the config"). The signal was there from Task 2 onward; the severity call was wrong three times in a row because each task-scoped reviewer could only see its own diff, and the crash requires composing Task 2's module with Task 3's reader and Task 4's registry.
- 📌 [nit] Design D3 asserted that fast-glob's `ignore` "is picomatch-backed internally, so the two views agree by construction". They are different engines at different majors (`picomatch@4` direct vs `picomatch@2` nested under `micromatch`). The implementation is fine — agreement comes from the post-filter running last — but the stated *reason* was wrong, and a later slice trusting it could get burned. Corrected in the docs, deliberately not back-edited into design.md.
- 📌 [nit] The controller ruled `/` into the catch-all gitignore warn set; it is inert under this subset (stripped to `''` and skipped), so that one input now emits a warning whose text is false. Parked — no second fix wave.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1.1 + 1.2 | Batched into one implementer dispatch (two commits) | Task 1 is a 3-step mechanical `npm install` existing solely to unblock Task 2's import; a separate review seat for a lockfile diff buys nothing |
| 3.1 + 3.2 (plan Tasks 4+5) | Batched into one dispatch, landed as one commit | Task 4's `readerFactory` change does not typecheck until Task 5 adds `scope` to `FsVaultReaderOptions`. The plan flagged this inline and permitted the combination |
| 3.3 (plan Task 6) | The plan's "expect FAIL" red step no longer applied (Tasks 3–5 had landed), so it became a verification step. Replaced the red step with an explicit teeth-proof: remove `scope`, confirm assertions flip, restore | A test that passes on first write proves nothing about its own sensitivity |
| 3.3 (plan Task 6) | Added a `list_properties` assertion the plan omitted | The `headless-vault-operations` scenario names **both** tags and properties; the plan's test only covered tags |
| 4.2 (plan Task 7) | Sweep targets located by content, not by the plan's line numbers | The branch base moved past the plan's authoring commit (origin/main advanced to `40ba2b0`) |
| 4.3 (plan Task 7) | Behaviour-change note moved from a `docs:` commit body to a reworded `feat:` commit **subject** | See §2 — the `docs:` body never reaches the CHANGELOG |
| — (new) | Exclusion-entry validation, catch-all gitignore warning, non-object config shape guard, `.gitignore` EACCES warning, `readonly ignorePatterns` | Final-review findings; none were in the plan |
| — (new) | `specs/vault-scope/spec.md` R1 wording tightened | "the two views SHALL agree on membership for every path" is literally false for dot-paths, which `ignorePatterns` omits by design |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (prior session — `brainstorm.md`) |
| superpowers:writing-plans                        | ✓ (prior session — `plan.md`, 8 tasks) |
| superpowers:using-git-worktrees                  | ✓ (native `EnterWorktree`, per Step 1a) |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED→GREEN evidence in every implementer report; teeth-proof substituted for RED on the e2e task) |
| (transitive) superpowers:requesting-code-review  | ✓ (5 task reviews + 1 final whole-branch review + 1 scoped re-review) |
| superpowers:finishing-a-development-branch       | ✓ (next step, after archive) |

### Deliberately Skipped Skills

(none — every apply-phase skill was used)

One process note that is not a skip: the session carried a standing "do not call the Agent tool unless the user requested it" directive, which conflicts head-on with this schema's mandate that apply MUST run subagent-driven and MUST NOT silently fall back to manual. Resolved by asking the user before Task 1 rather than by picking a side. The schema's own instruction anticipates exactly this ("the user can... explicitly opt into the manual fallback path"), so the escape hatch worked as designed.

## 5. Surprises

- **A clean sweep of task reviews is not evidence of a clean branch.** Five task reviewers, all thorough, all correct within their scope, all clean — and the branch still carried a startup-killing crash. The defect was *compositional*: it needs Task 2's module, Task 3's reader, and Task 4's registry together, and no task-scoped diff contains it. This is the strongest argument for the final whole-branch seat that this cycle produced.
- **Reading code and running code found different bugs.** Every task reviewer read carefully; the final reviewer ran `picomatch([''])` against the worktree's own `node_modules` and got a thrown exception. The Critical was invisible to inspection and obvious to execution.
- **The plan containing literal code made the implementers fast and the reviewers weak.** Verbatim transcription meant three tasks were reviewed as "matches the brief exactly" — which is true, and which quietly transfers the review question from "is this right?" to "does this match?". The brief's own correctness went unexamined until the final review.
- **`docs/superpowers/` is the change's own test case.** The vault's root `.gitignore` names it, so this repo's frozen pre-OpenSpec record is precisely one of the trees that leaves discovery under the new scope. The behaviour change was dogfooded by the repo it shipped in.
- **The controller's pre-flight scan caught the one cross-task conflict the plan had already flagged** (T4 cannot typecheck without T5) and nothing else. The scan's value here was confirming the plan's self-awareness, not finding new problems — worth knowing for calibrating how much to invest in it next time.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **Any module reading user-authored config must validate entries before handing them to a pattern/parser engine, and a test must prove one bad entry cannot take down startup** → **Promote to memory** (type: feedback)
  > **Why**: `unified-vault-scope` shipped `.neuro-vault/config.json` exclusions straight into `picomatch`. An empty-string entry threw out of `createVaultScope` → `loadVaultScope` → `VaultRegistry.create`, killing the whole multi-vault server on one vault's typo, and a `!`-prefixed entry silently inverted membership. Five task reviews rated it "Minor"; only the final whole-branch review, which *ran* the code, caught it.
  > **How to apply**: whenever a change adds or extends a config file, env var, or any other user-authored input that reaches a glob/regex/parser library — write the hostile-input test (empty string, engine metacharacter, wrong type) in the same task that adds the reader, not in a follow-up.

- [ ] 🟡 **Before designing a "users will see it in the CHANGELOG" mitigation, check how the CHANGELOG is actually generated** → **Promote to memory** (type: feedback)
  > **Why**: this cycle's design named a CHANGELOG entry as the #1 risk mitigation for a silent behaviour change, and the plan implemented it as a note in a `docs:` commit body. This repo's `commit-and-tag-version` renders only `feat:`/`fix:` commit **subjects** — the note was invisible. Cost was a history rewrite at the end of the cycle (`a86291f`).
  > **How to apply**: at plan-writing time, for any change with a user-visible behaviour shift — read the release tooling's config (`.versionrc`, preset, `CHANGELOG.md`'s existing shape) and make the behaviour statement a `feat:`/`fix:` **subject**, not a body note in a `docs:` commit.

- [ ] 🟡 **A doc sweep must verify its own new prose, not just the concept file it centres on** → **Promote to memory** (type: feedback)
  > **Why**: the `unified-vault-scope` sweep's reviewer verified every claim in the new `vault-scope.md` against source and independently re-ran the sweep greps — and still passed a sentence in `docs/guide/finding-notes.md` claiming scope applies to "any of the tools below", when three semantic tools on that page are not scope-governed at all. This extends the existing "doc sweeps must cover docs/guide too" rule: reaching the guide layer is necessary but not sufficient.
  > **How to apply**: when reviewing a doc sweep, treat sentences the sweep *added* to guide-layer files with the same source-grepping rigour as the concept file — especially any sentence containing a universal quantifier ("any", "every", "all of the tools below").

- [ ] 📌 **When a plan embeds literal implementation code, tell the task reviewer to judge the brief's correctness, not just the diff's fidelity to it** → **Promote to schema** (superpowers-bridge task-reviewer dispatch guidance)
  > **Why**: three of this cycle's task reviews concluded "matches the brief verbatim / byte-for-byte" and approved. That is the correct verdict on fidelity and a silent abstention on correctness — the plan's own design defect (unvalidated input) survived all three.
  > **How to apply**: in `task-reviewer-prompt.md`, when the brief contains complete literal code, add an explicit instruction to evaluate the brief's design on its merits and to flag defects in the plan itself as findings.

- [ ] 🟡 **A `## MODIFIED Requirements` delta must carry EVERY scenario the main spec's requirement already has — archive replaces the whole block, and `git diff` on the synced spec is the only thing that catches a silent deletion** → **Promote to memory** (type: reference)
  > **Why**: `unified-vault-scope`'s `headless-vault-operations` delta re-stated the requirement with 6 of the main spec's 8 scenarios plus one new one. `openspec archive` therefore deleted "Inline-only tags are not filterable" and "Property names are counted across notes" from the live contract. `openspec validate --all` passed before and after — a delta that deletes scenarios is structurally valid, so validation is not the net here.
  > **How to apply**: when authoring a MODIFIED delta, diff the delta's scenario list against the main spec's requirement and carry the untouched ones verbatim; after `openspec archive`, always read `git diff openspec/specs/` before committing, and restore anything dropped in both the main spec and the archived delta.

- [ ] 📌 **Design claims about third-party library internals need a version check before they become load-bearing rationale** → **One-off** (recorded, not promoted)
  > **Why**: D3 justified the two-view design with "fast-glob's `ignore` is picomatch-backed internally, so the two views agree by construction" — true in spirit, false in fact (`picomatch@4` direct vs `picomatch@2` nested under `micromatch`). The design still lands correctly for a different reason (the predicate post-filter runs last), so nothing broke; it does not generalise into a rule worth carrying, beyond the ordinary habit of checking the lockfile before asserting what a dependency does internally.
