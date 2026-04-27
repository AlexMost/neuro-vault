# Agent Working Notes

Conventions for AI agents (and humans) working on this repository.

## Documentation layout

```
docs/
  architecture/                  # one file per architectural concept (current state)
  superpowers/
    specs/                       # design specs — COMMITTED, canonical record
    plans/                       # implementation plans — GITIGNORED, local only
```

### Specs (`docs/superpowers/specs/`)

- Filename: `YYYY-MM-DD-<topic>-design.md`
- Created during brainstorming, before any code is written.
- One spec per feature or significant change.
- Committed to git. This is the long-lived, reviewed record of what was decided and why.
- A spec describes goal, scope, architecture, interfaces, error handling, testing strategy, and Definition of Done.
- Specs do not get rewritten as the world changes — if a decision is revisited, write a new spec that supersedes the old one and link the two. The old spec stays so the history is readable.

### Plans (`docs/superpowers/plans/`)

- Created from a spec, by the writing-plans flow.
- Step-by-step implementation breakdown for execution in a session.
- **Gitignored.** Plans are local working artifacts that change frequently during execution. They are not the canonical record — the spec is.
- If a plan reveals that the spec was wrong, fix the spec and commit that fix. The plan itself stays local.

### Architecture docs (`docs/architecture/`)

- One file per architectural concept (e.g. `module-structure.md`, `vault-provider.md`, `retrieval-policy.md`).
- Describes the **current** state of the codebase, not future plans.
- Each file answers: what is this concept, why does it exist, how does it interact with the rest of the system, what are its boundaries.
- Updated when the concept it describes changes — these are living documents, not historical records.
- A reader should be able to understand any one architectural concept by reading exactly one file.

## Workflow for non-trivial work

1. **Brainstorm** → write a spec to `docs/superpowers/specs/`. Commit it.
2. **Plan** → derive an implementation plan from the spec into `docs/superpowers/plans/` (local only).
3. **Implement** → follow the plan. Update the spec inline if a decision changes mid-flight.
4. **Document** → if the change introduces or alters an architectural concept, update or add a file in `docs/architecture/` as part of the same change.
5. **Open a PR** → push the branch and open a PR to `main` via `gh pr create`. Never push directly to `main`; the release flow expects a merge commit.

Trivial work (typo fix, dependency bump, doc tweak) does not need a spec.

## Coding conventions

- TypeScript strict mode; module type is ESM.
- Tests use vitest; mocks via `vi.fn()`. Prefer DI over module-level mocks.
- Error responses go through `ToolHandlerError` so MCP clients receive structured `{ code, message, details }`.
- New external command invocations use `execFile` with an args array — never `exec` with an interpolated string.
- Format with prettier; lint with eslint. Both run in `prepublishOnly`.

## MCP parameter dictionary

One concept = one parameter name across every tool the server exposes. New tools must follow this dictionary for any concept listed here; renames cost a major version.

| Concept                        | Param   | Used by                                                                                                          |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Vault-relative POSIX path      | `path`  | `read_note`, `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_similar_notes` |
| Wikilink-style note identifier | `name`  | `read_note`, `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`                      |
| Frontmatter property key       | `key`   | `set_property`, `read_property`, `remove_property`                                                               |
| Tag name                       | `tag`   | `get_tag`                                                                                                        |
| Semantic search query          | `query` | `search_notes`                                                                                                   |

Tools that take both `name` and `path` for the same concept (note identifier) require exactly one — both or neither produces `INVALID_ARGUMENT`.

## Subagent dispatch — model and reasoning effort

When dispatching subagents for plan execution, match the **model** and **reasoning effort** to the task complexity:

| Task shape                                                                                                | Model    | Reasoning effort |
| --------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| Mechanical refactor, single file, complete spec, file move/rename, exact-snippet implementation           | `haiku`  | low              |
| Multi-file integration, TDD with new logic, error mapping, debugging, pattern matching, tool registration | `sonnet` | medium           |
| Architectural design, cross-cutting changes, ambiguous requirements, final repo-wide code review          | `opus`   | high             |

Reviewer roles:

- **Spec compliance review** — same model as the implementer (`haiku` / `sonnet`); the question is whether code matches a written spec, which is mechanical.
- **Code quality review** — one tier above the implementer (mechanical → `sonnet`, integration → `opus`); judgment-heavy.
- **Final pre-merge review** — always `opus` with high effort.

Signals that you should escalate one tier:

- Subagent reports `BLOCKED` or `DONE_WITH_CONCERNS` on a task you originally classified as mechanical.
- The task description contains "design", "decide", "choose between", or open-ended success criteria.
- The change touches more than three files, or crosses module boundaries.

Default to the lowest tier that can plausibly succeed; cost and latency add up across a 30-task plan, and a re-dispatch with a stronger model is cheap compared to over-spending on every task.

## Subagent definition of done

Every implementer subagent dispatched for a task in a plan MUST verify, before reporting `DONE`, that the working tree is in a fully green state:

- `npm test` — all tests pass; the test count must not drop unintentionally.
- `npm run lint` — clean (no errors).
- `npx tsc --noEmit` — clean (no errors). This is the source of truth for typechecking; `tsup` uses `isolatedModules` so a `tsup` build alone is not sufficient.

If any of those three checks fail, the subagent's status is NOT `DONE`. The correct status is `DONE_WITH_CONCERNS` (with the failure spelled out) or `BLOCKED`. The controller will not advance to the next task while any of the three checks is red.

This applies even to refactor / move tasks where "no behavior change" is the goal — silent regressions caught a task later are far more expensive than re-running three short commands at the end of every task.

## Release

- `npm run release` uses `commit-and-tag-version` — driven by Conventional Commits.
- A release should bundle one logical unit of change (one spec → one release where reasonable).
- Update the README in the same change that introduces user-facing behaviour.

### Release flow

Releases always happen on `main`. The sequence is:

1. Open a PR from the feature branch to `main` and merge it.
2. Check out `main`, pull, run `npm run release` — `commit-and-tag-version` bumps the version, updates `CHANGELOG.md`, and creates a git tag.
3. Push commits and tags (`git push --follow-tags`). Optionally `npm publish` after explicit user approval.

Never run `npm run release` on a feature branch — the version bump and changelog must land on `main` so the tag points at the merge commit and the changelog stays linear.
