# Retrospective: hybrid-search-notes

> Written: 2026-07-06 (after verify passed)
> Commit range: `27034dc..03aa879`
> Worktree: `.claude/worktrees/hybrid-search-notes` (branch `worktree-hybrid-search-notes`, not yet merged)

---

## 0. Evidence

- **Commit range**: `27034dc..03aa879` (16 commits; retrospective + archive add ~2 more)
- **Diff size**: +5193 / -532 lines across 41 files
- **Tasks done**: 20/20 (`tasks.md` all `- [x]`); 11 plan tasks executed
- **Active hours**: ~1 session, continuous (subagent-driven, no human-in-loop between tasks)
- **Subagent dispatches**: 25 — 11 implementers, 11 task reviewers, 2 fix subagents (Task 8 assertion strengthening, determinism refactor), 1 final whole-branch review
- **New external dependencies**: `mdast-util-from-markdown@^2.0.3` (MIT, runtime — block-level markdown AST with line positions), `@types/mdast@^4.0.4` (MIT, dev). First markdown parser in the repo.
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass (one requirement-body SHALL-placement error found and fixed in `7386fe5`)
- **Test coverage signal**: vitest 706 → 758 (+52 tests); lint clean; `tsc --noEmit` clean; `npm run build` OK
- **Breaking change**: yes — `results`→`semantic_matches`, `mode: quick|deep`→`mode: hybrid|lexical` + `effort: quick|deep`; ships as a major (`feat(search)!:` commit `16a5159`)

Commit chain:

```
27034dc chore(release): 11.0.0                                      (base)
94095ed docs(openspec): add hybrid-search-notes change artifacts
4fbd284 chore(deps): add mdast-util-from-markdown for lexical leg
42e0225 feat(lexical): normalization with offset map
b2e2ea7 feat(lexical): markdown AST block extraction with line positions
69cc559 feat(lexical): tiered deterministic ranking with density and snippets
f47fe08 feat(lexical): LexicalIndex with mtime cache over vault reader
16a5159 feat(search)!: mode/effort axes and semantic_matches rename
2ea8725 feat(search): lexical leg orchestration — hybrid, lexical-only, cold corpus
4cf7fd8 feat(search): multi-query and multi-vault parity for the lexical leg
e1531a3 docs(search): hybrid tool description and parameter dictionary
ed01763 docs(guide): restructure by intent — finding vs reading-and-modifying
44dfc9c test(search): end-to-end hybrid sanity fixture
0b1fea4 docs(openspec): tick hybrid-search-notes tasks.md checkboxes
7f14058 refactor(lexical): ordinal path tie-break for byte-for-byte determinism
7386fe5 docs(openspec): lead filter requirement with SHALL for openspec validate
03aa879 docs(openspec): verify hybrid-search-notes (PASS with warnings)
```

---

## 1. Wins

- [evidence: §0 test count 706→758] Every lexical primitive was built TDD RED→GREEN as its own pure-function module (`normalize` `42e0225`, `blocks` `b2e2ea7`, `match`/`rank`/`snippet` `69cc559`, `LexicalIndex` `f47fe08`) before any tool wiring — the integration tasks (`16a5159`, `2ea8725`) landed against already-proven components.
- [evidence: commit `f47fe08`, verify §4] The `LexicalIndex` implementer independently chose the single-read `splitFrontmatter` refactor the plan offered as an option, and the reviewer hand-verified the file-relative line-offset arithmetic (`[5,5]` fixture) byte-for-byte — a genuinely better design than the plan's double-read reference.
- [evidence: commit `2ea8725`, task-7 review] The highest-risk task (leg orchestration, corpus-independence, cold-corpus fallback) held up: the reviewer confirmed `mode: "lexical"` structurally cannot reach `corpus.snapshot()`, and that an *available* corpus that errors still throws `DEPENDENCY_ERROR` (invariant preserved by an untouched pre-existing test).
- [evidence: commit `ed01763`, task-10 review] Docs restructure preserved content subsection-by-subsection (reviewer verified nothing dropped) and even corrected a stale `read_notes` API example as a side effect.
- [evidence: final review] Independent whole-branch review at the most-capable tier found zero Critical/Important defects and proved the carried-over `table`-branch concern was moot (no GFM extension loaded → pipe tables parse as paragraphs; the branch is unreachable dead code).

## 2. Misses

- 🟡 [painful | evidence: task-8 review, fix in `4cf7fd8`] The Task 8 multi-query test initially asserted `matched_queries` *cardinality* only, not *content* — a query-attribution swap would have passed. Caught in review, fixed with explicit path→query assertions. A test that looks like coverage but isn't.
- 🟡 [painful | evidence: `7386fe5`, verify §1] The `filter` requirement in the delta spec placed `SHALL` on its second body line; `openspec validate` inspects only the first body line after the header, so validation failed at verify time — a full cycle after the spec was authored. Planning never ran `openspec validate`.
- 📌 [nit | evidence: task-1 review, `4fbd284` amend] Task 1's throwaway `spike-notes.md` had a mangled nested markdown fence (three-backtick inside three-backtick); cosmetic, fixed by controller amend.
- 📌 [nit | evidence: final review, `lexical-index.test.ts`] The "reproducible ordering" test is a weaker regression net than its name suggests (same instance, unchanged vault); real ordering determinism is covered by `rank.test.ts`. Left as-is (DEFER).

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 2.4 (lazy tier cascade) | Not implemented | Optional per design D8 / spec "MAY evaluate lazily"; full `rankNotes` evaluation is the reference semantics. Determinism + tiering requirements satisfied without it. |
| 5 (`LexicalIndex`) | Single-read `splitFrontmatter` instead of plan's double-read reference | Cleaner, one filesystem read, byte-identical `content`; plan explicitly offered this as the preferred alternative. |
| 4 (`rank.ts`) | `localeCompare` → ordinal path tie-break (`7f14058`) | Final review: spec demands byte-for-byte reproducibility; `localeCompare` is collation-based and not version-pinned. One-line hardening of the plan's own stated intent. |
| 11 (Step 4) | Did NOT run the plan's `git push` + `gh pr create` | The opsx apply flow requires the PR to come LAST, after verify + retrospective + archive are committed to the branch. Controller deferred it. |
| — (spec) | `filter` requirement reworded (`7386fe5`) | `openspec validate` requires SHALL on the first requirement-body line. Meaning unchanged. |

## 4. Skill / workflow compliance

| Skill | Used |
|-------|------|
| superpowers:brainstorming | ✓ (planning phase, pre-apply) |
| superpowers:writing-plans | ✓ (plan.md, pre-apply) |
| superpowers:using-git-worktrees | ✓ (native `EnterWorktree`) |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED→GREEN per task) |
| (transitive) superpowers:requesting-code-review | ✓ (per-task + final whole-branch) |
| superpowers:finishing-a-development-branch | ✓ (final step, in progress) |

### Deliberately Skipped Skills

(none — every apply-phase skill was used)

## 5. Surprises

- [evidence: `7386fe5`] `openspec validate`'s SHALL check reads **only the first body line** of a requirement, not the whole requirement text. A correctly-normative requirement can fail validation purely on line-wrap placement. Non-obvious and only surfaced at verify.
- [evidence: final review] The plan's `blocks.ts` reference included a `table` node branch, but CommonMark (no GFM extension) never emits `table` nodes — the branch is unreachable dead code, discovered only under adversarial whole-branch review.
- [evidence: repeated IDE diagnostics] Throughout, the IDE LSP surfaced "cannot find module" / "unused `_channel`" / "mockReturnValue does not exist" errors that were all stale (LSP indexing the main checkout, not the worktree). Authoritative `npx tsc --noEmit` in the worktree was clean every time — consistent with the known worktree stale-LSP pattern.

## 6. Promote candidates → long-term learning

- [ ] 🟡 `openspec validate` requires the SHALL/MUST keyword on the FIRST body line of a requirement (immediately after `### Requirement:`), not merely somewhere in the body.
  → **Promote to** memory (reference)
  > **Why**: A spec authored with SHALL on a wrapped second line passes human review but fails `openspec validate` at verify time — a full cycle late.
  > **How to apply**: When authoring or editing any `openspec/**/spec.md` requirement, put the SHALL/MUST clause on the first line after the header; run `openspec validate --all` during the planning/spec phase, not only at verify.

- [ ] 📌 Run `openspec validate --all` as part of the spec/planning phase gate, before apply.
  → **Promote to** CLAUDE.md / opsx-routing rule
  > **Why**: Structural spec errors are cheap to fix at authoring time and expensive to discover at verify (they block archive).
  > **How to apply**: Add `openspec validate --all` to the spec-authoring checklist so validation failures surface before implementation starts.

- [ ] 📌 In subagent-driven-development, a test that asserts cardinality/presence but not attribution/content is a recurring "looks-like-coverage" trap.
  → **Promote to** one-off (already covered by the reviewer rubric's "vacuous test" check)
  > **Why**: Task 8's `matched_queries` test would have passed under a query-attribution swap; only the reviewer's content-assertion scrutiny caught it.
  > **How to apply**: When reviewing multi-input merge/annotation tests, require an assertion that maps a specific input to its specific output, not just a count.
