---
paths:
  - 'openspec/changes/**/tasks.md'
---

# Applying an OpenSpec change

This repo uses the `superpowers-bridge` schema. Apply-phase orchestration is defined in `openspec/schemas/superpowers-bridge/schema.yaml` (`apply.instruction`) — follow that as the source of truth. Summary, in order:

1. Pre-flight skill check (all required Superpowers skills present); if any missing, STOP.
2. **Worktree** — invoke `superpowers:using-git-worktrees`. The worktree branches from `origin/main`, so commit the change folder (`openspec/changes/<name>/`) to the branch first — uncommitted artifacts authored in the main checkout will be missing inside the fresh worktree.
3. **Executor** — invoke `superpowers:subagent-driven-development` and pass it `plan.md`. It transitively brings TDD (RED-GREEN-REFACTOR per task) and `superpowers:requesting-code-review` (per-task review subagent). Do NOT invoke `dispatching-parallel-agents` here — `subagent-driven-development` handles parallel-safe groups itself.
4. **Verify** — produce `verify.md` via `openspec-verify-change` (`/opsx:verify`). Re-run until no blocking issues.
5. **Retrospective** — write `retrospective.md` (BEFORE PR), per the schema's retrospective instruction.
6. **Archive** — `npx openspec archive -y` (or `/opsx:archive`); syncs delta-specs and moves the folder.
7. **PR** — invoke `superpowers:finishing-a-development-branch` as the LAST step.

Project-specific verify gates live in `openspec/config.yaml` under `rules.verify`: `npm test`, `npm run lint`, `npx tsc --noEmit` (the last is the typecheck source of truth — a `tsup` build alone is not sufficient).
