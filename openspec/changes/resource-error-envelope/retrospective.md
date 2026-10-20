# Retrospective: resource-error-envelope

> Written: 2026-10-20 (after verify passed)
> Commit range: `413d6e0..HEAD`
> Worktree: `.claude/worktrees/shared-daemon-pr2-6aff26`, branch `claude/resource-error-envelope`

## 0. Evidence

- **Commit range**: `413d6e0..HEAD` (5 commits with the archive)
- **Diff size**: about +600 lines across 17 files. Most of it is the change's own artifacts; the
  code is about 40 lines in `src/lib/resource-registry.ts` plus a 28-line test helper.
- **Tasks done**: 6/6
- **Active hours**: about 0.5
- **Subagent dispatches**: 1 (the whole-branch reviewer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none yet
- **OpenSpec validate state at archive**: pass (27/27)
- **Test coverage signal**: vitest 2867 → 2871 passed

Commit chain:

```
a02d3c2 docs(openspec): propose resource-error-envelope
d38132c feat(resources): carry a ToolHandlerError's code and details on the wire
b499882 docs(resources): record resource read errors in an ADR and the docs
8fa2749 docs(resources): say which error message the resource specs mean
<archive> chore(openspec): archive resource-error-envelope
```

## 1. Wins

- The SDK source settled the design before any code: `shared/protocol.js` reads only `code`,
  `message` and `data` from a thrown error, so a plain `Error` subclass with those fields is
  enough (design D4).
- The test helper `test/_resource-wire.ts` reads through a real server and client. It is the
  test #213's retrospective asked for: that change's resource test called the handler directly
  and could not see the lost code.

## 2. Misses

- 📌 [nit | evidence: `8fa2749`] The first spec draft said "the client's message is
  `Graph read failed`". The SDK client prefixes it with `MCP error -32603: `. The reviewer
  caught it, and the scenarios now name the JSON-RPC error message.
- 📌 [nit | evidence: `8fa2749`] The first draft said any non-`ToolHandlerError` reaches the
  client with no `data`. That holds only for a plain `Error`, because an `McpError` keeps its own
  code and data.

## 3. Plan deviations

| Plan task | What changed | Why |
| --- | --- | --- |
| 1 | The wire helper is a shared `test/_resource-wire.ts` (`readErrorOverWire`) instead of a function inside one test file | Task 2 needs it too |
| 2 | Its test landed in the `feat` commit, not its own | It was green as soon as Task 1 was in, so a separate commit added nothing |

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ✓ (one design question to the user, approved) |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ (the session's own worktree, branched from `origin/main` after #213 merged) |
| superpowers:subagent-driven-development | ✗ |
| (transitive) superpowers:test-driven-development | ✓ (RED: 2 failing, then GREEN) |
| (transitive) superpowers:requesting-code-review | ✓ (one whole-branch reviewer) |
| superpowers:finishing-a-development-branch | ✓ (push + PR) |

### Deliberately Skipped Skills

- **`superpowers:subagent-driven-development`**
  - **What was skipped**: per-task implementer and reviewer subagents.
  - **Why this cycle**: plan.md's Execution line chose native. The two code tasks share one
    40-line class, and the second is a test of the first.
  - **How to prevent recurrence**: `scope-judgment rule` — a plan with at most two code tasks
    sharing one interface runs natively with one whole-branch reviewer, as `graph-read-errors`
    did too.

## 5. Surprises

- `McpError` cannot be thrown as is for a domain error: its constructor bakes
  `MCP error <code>: ` into the message, and the client SDK adds it again.

## 6. Promote candidates → long-term learning

- [ ] 📌 **Test MCP resources over the SDK wire, not through the handler** → **One-off**
  (`test/_resource-wire.ts` now exists and is the obvious tool)
  > **Why**: #213's handler-direct resource test passed while the client lost the code.
  > **How to apply**: any resource test that asserts an error shape uses `readErrorOverWire`.
