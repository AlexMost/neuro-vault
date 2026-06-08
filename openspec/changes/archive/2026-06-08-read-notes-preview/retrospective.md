# Retrospective: read-notes-preview

> Written: 2026-06-08 (after verify passed)
> Commit range: `d06483a..49454e2`
> Worktree: `/Users/amostovenko/git/neuro-vault/.claude/worktrees/read-notes-preview` (branch `worktree-read-notes-preview`, pre-PR)

---

## 0. Evidence

- **Commit range**: `d06483a..49454e2` (5 commits)
- **Diff size**: code+docs `10 files, +300 / -73`; including planning artifacts `17 files, +892 / -73`
- **Tasks done**: 13/13 (`grep -c '^- \[x\]' tasks.md` → 13; 0 remaining)
- **Active hours**: ~2h end-to-end (propose + apply); apply phase ~50 min
- **Subagent dispatches**: 10 (A: implement + spec-review + quality-review + fix; B: implement + spec-review + quality-review + fix; D: docs implement; final whole-implementation review)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass (`2 passed, 0 failed` — `spec/baseline`, `change/read-notes-preview`)
- **Test coverage signal**: vitest 60 files / 716 tests (baseline 704 → +12); `previewBody` 6 dedicated unit tests; `read_notes` handler 20 tests (was 14)

Commit chain (時序):

```
d06483a (origin/main base)
9dfef99 docs(openspec): add read-notes-preview change artifacts
760a648 feat(read-notes): add pure previewBody truncation helper
6b53d24 feat(read-notes)!: replace fields with content full|preview|frontmatter mode
02f412a docs(read-notes): document content modes and triage-preview rule
49454e2 chore(openspec): mark read-notes-preview tasks complete
```

---

## 1. Wins

- [evidence: §0 subagent dispatches; commit `6b53d24`] Two-stage review earned its keep: the Task B code-quality reviewer surfaced two real improvements that landed before merge — a `ContentMode` type alias (the union was spelled ~6×) and a schema-level test for the "legacy `fields` key ignored" spec clause, which was the **only** spec scenario with zero coverage (handler tests bypass Zod).
- [evidence: design.md D1a; spec scenarios "multiple paths default to preview" / "duplicate of a single path still counts as one"] The mid-propose redesign to a **count-based default** (1 distinct path → full, ≥2 → preview) resolved the cost-vs-correctness tension: triage gets cheap previews by default without the agent opting in (the W17–W24 failure mode), while single-note read→edit/cite stays full. This was a direct user decision via AskUserQuestion, not an assumption.
- [evidence: `git diff origin/main..HEAD --stat -- src/lib/**` is empty] The breaking change is provably localized to one tool surface. `VaultReader.readNotes({ fields })` and its `query_notes` / wikilink-graph callers were untouched — exactly design D3's intent.
- [evidence: `src/modules/operations/preview-body.ts`, 6 unit tests] Truncation was isolated into a pure helper, making the bounded/boundary-cut/deterministic behavior trivially testable independent of the handler.
- [evidence: verify.md §0] All gates green on the first full-suite run after implementation: tsc 0, lint 0, prettier 0, 716 tests.

## 2. Misses

- 🟡 [painful | evidence: IDE diagnostics "Cannot find module '../../src/.../preview-body.js'" and "'content' does not exist in type 'Input'" vs `npx tsc --noEmit` exit 0] Stale LSP diagnostics fired **false alarms three times** because the IDE indexed worktree files against the main checkout's project. Each forced an independent re-verification. Not blocking (tsc was always authoritative and clean), but it cost cycles and could have masked a real error in the noise.
- 📌 [nit | evidence: final review; commit `49454e2` amend] I blanket-flipped every `tasks.md` checkbox to `[x]`, including 5.1 (README) which was n/a — README has no `read_notes` reference. Caught by the final whole-implementation reviewer; annotated as n/a.
- 📌 [nit | evidence: Task B implementer report claimed "tsc clean" alongside "npm test 715"] An implementer cited vitest-green as part of its "verified" claim; vitest strips types and does **not** typecheck. The claim happened to be true, but the reasoning was unsound — only the independent `npx tsc --noEmit` is evidence.

## 3. Plan deviations

| Plan task         | What changed                                                           | Why                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks 2,3,4,5     | Merged into a single implementer unit (B) + single commit `6b53d24`    | `isolatedModules` + Zod excess-property/type errors mean types-only or validator-only states don't compile. Each subagent task must end green (TDD), so the tool-surface change had to land atomically. The plan already foresaw part of this ("types fold into Task 3's commit"). |
| Task 6            | Folded into unit B                                                     | Removing the tool's `fields` triggers excess-property `tsc` errors at other call-sites (e.g. `src/server.ts`); they had to be fixed in the same commit to reach a clean typecheck.                                                                                                 |
| Task 5 commit msg | Implemented under `6b53d24` (not a separate `test(read-notes)` commit) | Consequence of the merge above; tests are TDD-first within the same unit.                                                                                                                                                                                                          |

## 4. Skill / workflow compliance

| Skill                                            | Used                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| superpowers:brainstorming                        | ✗                                              |
| superpowers:writing-plans                        | ✗                                              |
| superpowers:using-git-worktrees                  | ✓                                              |
| superpowers:subagent-driven-development          | ✓                                              |
| (transitive) superpowers:test-driven-development | ✓                                              |
| (transitive) superpowers:requesting-code-review  | ✓                                              |
| superpowers:finishing-a-development-branch       | ✓ (next step — runs immediately after archive) |

### Deliberately Skipped Skills

> Both skips occurred in the **propose** phase (not apply); both are sanctioned by the corresponding artifact's own PRECHECK, which offers manual authoring when the exploration/decomposition is already complete.

- **`superpowers:brainstorming`**
  - **What was skipped**: the interactive brainstorming skill; `brainstorm.md` was authored as a decision-log capture instead.
  - **Why this cycle**: the source task `Tasks/neuro-vault/Preview-режим тіла для read_notes` already encoded locked scope / out-of-scope / Definition-of-Done, itself distilled from six weekly usage reports (W17→W24). The single open design fork (parameter shape) was resolved live via the AskUserQuestion tool ("backward compat not required"; then "smart default by path count"). Re-running the interactive skill would have re-litigated decisions the user had already made.
  - **How to prevent recurrence**: `one-off — schema boundary case`. The brainstorm artifact PRECHECK explicitly permits manual authoring "when the exploration is already complete"; this cycle met that condition (a fully-formed upstream spec + a live fork resolution). It is a boundary the schema already sanctions, not a gap to close.

- **`superpowers:writing-plans`**
  - **What was skipped**: the interactive writing-plans skill; `plan.md` was authored manually (micro-steps with file paths, code snippets, commit points).
  - **Why this cycle**: scope was small and the code seams were already known from grounding reads during propose (`read-notes.ts`, `tool-helpers.ts`, `types.ts`, `vault-reader.ts`). The plan artifact PRECHECK sanctions manual authoring for well-scoped work.
  - **How to prevent recurrence**: `one-off — schema boundary case`. Same boundary as above; the artifact PRECHECK already names this path.

> Note: if future cycles repeatedly skip brainstorming/writing-plans with this same "upstream vault spec already locked" trigger, that recurrence is a §6 promote candidate (tighten the opsx-routing rule to name "task originates from a locked vault spec" as an explicit manual-authoring trigger).

## 5. Surprises

- [evidence: Task B code-quality reviewer; `src/lib/obsidian/vault-reader.ts` `readOne`] The underlying reader **ignores `fields` entirely** — it always reads the whole file from disk and splits frontmatter, regardless of the requested fields. So `content: 'frontmatter'` / `'preview'` save the **MCP response payload** (the agent's context cost — which IS the metric) but buy **no disk-I/O savings**. The plan/design phrasing "skip the body read" is inaccurate at the reader layer. This does not affect the feature's value (payload = context cost is the goal), and the shipped docs correctly say "response payload," not "disk I/O." Pre-existing reader behavior; out of scope here.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Stale LSP diagnostics in git-worktree apply runs are false positives — verify against `npx tsc --noEmit` in the worktree, never trust the IDE "cannot find module" / "property does not exist" diagnostic** → **Promote to memory** (type: feedback)

  > **Why**: this cycle's worktree-based apply produced three false-alarm diagnostics (the IDE indexed worktree files against the main checkout), each costing a re-verification; it will recur on every `EnterWorktree`-based opsx apply.
  > **How to apply**: during any worktree-isolated implementation, when a `<new-diagnostics>` block flags a missing module or unknown property, resolve it by running `npx tsc --noEmit` in the worktree before reacting — treat the diagnostic as stale unless tsc agrees.

- [ ] 📌 **"npm test green" is not evidence of typecheck — vitest strips types** → **One-off** (already covered by AGENTS.md "tsc --noEmit is authoritative")

  > **Why**: a Task B implementer bundled vitest-green into a "verified/tsc-clean" claim; the conflation is unsound even when the conclusion happens to hold.
  > **How to apply**: AGENTS.md already states tsc is the source of truth; reinforce in implementer dispatch prompts ("vitest does not typecheck — run tsc separately"). No new memory needed.

- [ ] 📌 **`read_notes` payload savings are at the MCP-response layer, not disk I/O (reader always reads the full file)** → **One-off** (forward note for any future "cheap read" work)
  > **Why**: design/plan said "skip the body read," but `vault-reader.readOne` ignores `fields`; the metric (context cost) is still achieved, but the mechanism description was wrong.
  > **How to apply**: if a future change targets disk-I/O reduction for reads, it must change `vault-reader.readOne` itself — projecting at the tool layer is not enough.
