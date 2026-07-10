# Retrospective: compact-tool-response-contract

> Written: 2026-07-10 (after verify passed)
> Commit range: `c3b2897..b4b89c2`
> Worktree: `.claude/worktrees/compact-tool-response-contract`

---

## 0. Evidence

- **Commit range**: `c3b2897..b4b89c2` (6 commits)
- **Diff size**: +650 / −7 lines across 12 files (8 source lines in `src/lib/tool-response.ts`; the rest is tests, docs, and change artifacts)
- **Tasks done**: 8/8 (`grep -cE '^\s*- \[x\]' tasks.md` → 8)
- **Active hours**: ~1 (explore session that produced the design was a separate earlier ~1h block)
- **Subagent dispatches**: 8 (4 implementers incl. 1 fixer, 3 task reviewers, 1 final whole-branch reviewer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (pre-merge retro)
- **OpenSpec validate state at archive**: pass (7/7 items valid)
- **Test coverage signal**: vitest 753/753 across 64 files (748 at baseline; +5 net new envelope tests)

Commit chain (時序):

```
25a1cd8 docs(openspec): add compact-tool-response-contract change artifacts
46522f8 feat(mcp): emit minified JSON in tool response text channel
6bef576 feat(mcp): include error code and details in error text channel
684bf85 docs(architecture): document tool response envelope policy
a2e0e4c docs(openspec): check off completed tasks in compact-tool-response-contract
b4b89c2 test(mcp): assert structured error channel unchanged when details present
```

---

## 1. Wins

- Empirical explore-mode work (live-server JSON-RPC probe + controlled error experiment, captured in §0 of brainstorm.md) **reversed the task's preliminary preference** before any code was written: the vault task leaned toward summary-text (variant A); measurement showed A saves zero context tokens in Claude Code and loses data on text-only clients. The cheap probe prevented an entire wrong implementation cycle.
- The same experiment surfaced a worse, previously invisible bug — error `code`/`details` never reach the agent — which became P2 and arguably delivers more value than the original minification ask.
- Plan-as-transcription worked: because plan.md carried complete test and implementation code, both feat tasks ran on the cheapest model tier with zero questions, zero review findings above Minor (see §0 dispatch count vs. the single fix commit `b4b89c2`).
- Single-choke-point architecture (`src/lib/tool-response.ts`) held: the whole behavioral change for all 16 tools is 8 source lines, and the final reviewer's repo-wide staleness sweep found nothing else to update.
- Task 4's live smoke check (raw JSON-RPC against built `dist/cli.js`) verified the real envelope end-to-end, not just unit assertions — `text === JSON.stringify(structuredContent)` true, error text `INVALID_FILTER: `-prefixed.

## 2. Misses

- 🟡 [painful | evidence: plan.md Task 2 test code vs `b4b89c2`] The plan's with-details error test asserted only `content[0].text`, so the spec scenario "structured error channel is unchanged" was only partially covered until the final whole-branch review caught it. Plan-time self-review checked spec→task coverage but not scenario→assertion coverage inside the supplied test code.
- 📌 [nit | evidence: task-3 review] The new architecture doc skipped the `## Why it exists` heading every sibling doc uses; triaged as leave-as-is, but a one-line doc-style note in the plan's Task 3 would have prevented the finding.

## 3. Plan deviations

| Plan task | What changed | Why |
| --------- | ------------ | --- |
| 2.3 sweep | Produced no diff (plan anticipated updates to `tool-registry`/`server-modules`/`vault-writer` tests) | Those tests assert `structuredContent`, which the change deliberately left untouched; the sweep confirmed rather than changed |
| post-plan | Extra commit `b4b89c2` (one test assertion) | Final whole-branch review finding; closes the partially covered spec scenario |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | ✓ (in progress at write time — PR step follows archive) |

### Deliberately Skipped Skills

(none — all rows ✓)

## 5. Surprises

- The vault task's core premise ("дублювання роздуває tool output і сприяє truncation") was wrong for the primary client: Claude Code injects only ONE minified copy (`structuredContent`) into model context for success results. The duplication cost was wire-only; the real defect was on the error path.
- Claude Code drops error `structuredContent` entirely — ADR-0003's machine-readable error codes were invisible to agents the whole time, despite tests asserting them faithfully at the unit level.
- The task-2.3 sweep found zero tests asserting error text outside the envelope's own test file — the codebase's discipline of asserting `structuredContent` (per ADR-0003) accidentally made the error-text format change friction-free.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Probe what the client actually injects into model context before optimizing MCP response shape** → **Promote to memory** (type: feedback)
  > **Why**: This cycle's task premise (token duplication) was disproven by a 5-minute raw JSON-RPC probe + controlled error experiment; the observable in-session behavior (what appears in the agent's own context) identified the real bug (dropped error codes) that unit tests could never see.
  > **How to apply**: Any future neuro-vault change motivated by "response size/tokens/truncation" — measure a live response over raw stdio JSON-RPC AND check what the agent actually receives in-session before designing.

- [ ] 📌 **Plan self-review should map spec scenarios → concrete test assertions, not just spec → tasks** → **One-off** (recorded; re-evaluate if it recurs)
  > **Why**: The only review finding that survived to the final gate was a spec scenario whose supplied test code covered the text channel but not the structured channel.
  > **How to apply**: When a plan embeds verbatim test code, walk each spec scenario and name the assertion that proves it.
