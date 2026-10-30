# Retrospective: lexical-word-boundary

> Written: 2026-10-30 (after verify passed with warnings)
> Commit range: `2b8641d..HEAD`
> Worktree: /Users/amostovenko/worktree/neuro-vault/lucid-mayer-5135e1

---

## 0. Evidence

- **Commit range**: `2b8641d..HEAD` (5 commits before the close-out commit)
- **Diff size**: +755 / −16 lines across 18 files; source +37 / −3 across 3 files, the rest tests,
  docs and change artifacts
- **Tasks done**: 9/9
- **Active hours**: about 1
- **Subagent dispatches**: 1 (whole-branch reviewer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none yet
- **OpenSpec validate state at archive**: pass (27 items)
- **Test coverage signal**: vitest 2939 passed (+16)

Commit chain:

```
e96c364 docs(openspec): propose lexical-word-boundary
ed7aaf0 feat(lexical): match tokens at a word boundary
f81a3e6 feat(lexical): drop Excalidraw drawing payloads from lexical units
d94ab9a docs(lexical): describe word-prefix matching
7fe0669 fix(lexical): an opening quote starts a word
```

---

## 1. Wins

- [evidence: verify.md §Eval] The metric landed exactly on the #228 simulation: `lexical` quick
  controls 5 → 1 (mean 0.12), `fused` quick 6 → 3 (mean 0.47), with no answerable loss. Copying
  the simulation's word-character definition from its script, rather than re-deriving "word
  boundary", is why the numbers carried over.
- [evidence: f81a3e6] Keying the payload skip on the fence language (`compressed-json`) instead of
  the simulation's "under the Drawing heading of an `.excalidraw.md`" kept the rule independent
  of file and heading conventions and reached the same eval numbers.
- [evidence: test/lib/obsidian/lexical/_legacy-lexical-index.ts] The parity oracle imports the
  live `parseNote` and `rankNotes`, so no frozen copy needed editing; only the matcher changed.

## 2. Misses

- 🟡 [painful | evidence: 7fe0669] The measured rule counted `'` as a word character
  unconditionally. Normalization folds curly quotes to `'`, so a word in single quotes stopped
  matching. The plan's Review Focus listed `'` only as a *leading* character of a token, not as
  the character *before* one. The reviewer caught it; the golden set has no such case, so the eval
  could not have.
- 📌 [nit | evidence: d94ab9a] The §5 rewrite in `lexical-search.md` left the "Either way it
  records a density" sentence at the end of the new paragraph instead of the one it refers to;
  fixed in 7fe0669.
- 📌 [nit | evidence: the description test] The description had 5 characters of budget left
  (3795 of 3800), so the lexical line had to be reworded twice to fit.

## 3. Plan deviations

| Plan task | What changed | Why |
| --- | --- | --- |
| 1 | `'` is a word character only after a letter, digit or `_` | Review: opening quotes; only adds matches over the measured rule |
| 1 | Surrogate step-back checks for a real high surrogate | Review: a lone low surrogate after a letter read as a pair |
| 3 | Description line reads "case/accent-insensitive word prefix … an exact phrase ranks higher" | Fit the 3800 budget without touching other sections |
| 4 | Before re-run twice from a temporary `main` worktree | The vault auto-committed between runs, twice |

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ✓ (in the wayfinder map, #228; brainstorm.md written from its resolution) |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ (the session's own app worktree) |
| superpowers:subagent-driven-development | ✗ |
| (transitive) superpowers:test-driven-development | ✓ (each source change had a failing test first) |
| (transitive) superpowers:requesting-code-review | ✓ (one whole-branch reviewer) |
| superpowers:finishing-a-development-branch | ✓ (PR, no local merge) |

### Deliberately Skipped Skills

- **`superpowers:subagent-driven-development`**
  - **What was skipped**: per-task implementer and reviewer subagents. The whole-branch review ran.
  - **Why this cycle**: the source change is 37 lines in two leaf functions (ed7aaf0, f81a3e6);
    plan.md states native execution under "Execution", as for semantic-floor-recalibration.
  - **How to prevent recurrence**: `scope-judgment rule` — the same rule as the previous change:
    under about 300 source lines, native with one whole-branch reviewer.

## 5. Surprises

- The decision text said "word boundary" but the measured simulation defined it precisely
  (`isalnum`, `_`, `'`); the script in the vault's analysis folder was the only place that
  definition lived.
- A quote fix that changes real matching behaviour moved no eval number: the golden set has no
  quoted query term. The eval guards recall at the aggregate level only; character-class edge
  cases need unit tests.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **When a map decision cites a simulation, take its exact rule from the simulation
      script, then review that rule against the normalizer** → **Promote to memory** (type:
      feedback)
  > **Why**: the #228 script defined the word characters the decision only named; the same
  > definition missed curly quotes folded by normalization.
  > **How to apply**: any lexical or retrieval rule implemented from a wayfinder simulation —
  > read the script's predicate, and list the characters normalization folds into it.
- [ ] 📌 **Follow-up: snippet coordinates drift after astral characters** → **one-off** (issue)
  > **Why**: `normalizeWithMap` maps per code point while `matchUnit` indexes UTF-16 units.
  > **How to apply**: a direct PR with a snippet test holding emoji before the match.
