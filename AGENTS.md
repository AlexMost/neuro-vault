# Agent Working Notes

Project-specific conventions for AI agents (and humans) working on this repository. Workflow mechanics (brainstorming, plan writing, subagent dispatch, plan execution) live in their respective superpowers skills — this file does not duplicate them.

## Coding conventions

- TypeScript strict mode; module type is ESM.
- Tests use vitest; mocks via `vi.fn()`. Prefer DI over module-level mocks.
- Error responses go through `ToolHandlerError` so MCP clients receive structured `{ code, message, details }`.
- New external command invocations use `execFile` with an args array — never `exec` with an interpolated string.
- Format with prettier; lint with eslint. Both run in `prepublishOnly`.
- Naming and file-layout conventions (I-prefix for interfaces, classes without prefix, one file per concept) — see [`docs/architecture/naming-conventions.md`](docs/architecture/naming-conventions.md).

## Quality gates

Three checks must pass before any commit or PR:

- `npm test` — full vitest suite; test count must not drop unintentionally.
- `npm run lint` — eslint clean.
- `npx tsc --noEmit` — typecheck clean. `tsup` uses `isolatedModules`, so a `tsup` build alone is not sufficient — `tsc --noEmit` is the source of truth.

These apply even to refactors where "no behavior change" is the goal — silent regressions caught a task later cost more than re-running three short commands at the end of every task.

## MCP parameter dictionary

One concept = one parameter name across every tool the server exposes. New tools must follow this dictionary for any concept listed here; renames cost a major version.

| Concept                                     | Param                 | Used by                                                                                             |
| ------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| Vault-relative POSIX path                   | `path`                | `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_similar_notes` |
| Vault-relative POSIX path list              | `paths`               | `read_notes`                                                                                        |
| Vault-relative POSIX path subtree (or list) | `path_prefix`         | `query_notes`, `search_notes` (inside `filter`)                                                     |
| Subtrees to exclude (string or list)        | `exclude_path_prefix` | `query_notes`, `search_notes` (inside `filter`)                                                     |
| Wikilink-style note identifier              | `name`                | `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`                      |
| Frontmatter property key                    | `key`                 | `set_property`, `read_property`, `remove_property`                                                  |
| Semantic search query                       | `query`               | `search_notes`                                                                                      |
| Structured query filter (MongoDB)           | `filter`              | `query_notes`                                                                                       |

Tools that take both `name` and `path` for the same concept (note identifier) require exactly one — both or neither produces `INVALID_ARGUMENT`. `read_notes` is paths-only (batch reads from disk); to read by wikilink, resolve to a path first via `search_notes` or another path-producing tool.

> Note on `path`: when the target is an _individual note_, `.md` is auto-appended if the final path segment has no extension (`Tasks/Foo` → `Tasks/Foo.md`). This applies to `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_note_links`, and `get_similar_notes`. Subtree-prefix uses (`path_prefix`, `exclude_path_prefix`) and `read_notes` paths do not auto-append.

## Documentation layout

Where each kind of doc lives and which question it answers — the five-location map (WHY / HOW / WHAT-now / WHAT-proposed / frozen) — is in [`docs/README.md`](docs/README.md).

## Workflow

Non-trivial work runs the spec-driven flow mapped in [`docs/workflow.md`](docs/workflow.md); whether a change goes through an OpenSpec `superpowers-bridge` opsx change or a direct PR is decided by [`.claude/rules/opsx-routing.md`](.claude/rules/opsx-routing.md). The apply phase uses the superpowers chain (`using-git-worktrees` → `subagent-driven-development` → `finishing-a-development-branch`) with TDD + per-task code review. This file does not restate those — only the project conventions they assume:

- A load-bearing architectural decision gets a numbered ADR in `docs/adr/` (ask before writing) — see [`docs/adr/INDEX.md`](docs/adr/INDEX.md).
- A change that introduces or alters an architectural concept updates the matching `docs/architecture/` file in the same change.
- PRs go to `main` via `gh pr create`; never push directly — the release flow expects a merge commit.

## Release

- `npm run release` uses `commit-and-tag-version` — driven by Conventional Commits.
- A release should bundle one logical unit of change (one spec → one release where reasonable).
- Update the README in the same change that introduces user-facing behaviour.

Releases always happen on `main`:

1. Open and merge the PR from the feature branch to `main`.
2. Check out `main`, pull, run `npm run release` — bumps the version, updates `CHANGELOG.md`, creates a git tag.
3. Push commits and tags (`git push --follow-tags`). Optionally `npm publish` after explicit user approval.

Never run `npm run release` on a feature branch — the version bump and changelog must land on `main` so the tag points at the merge commit and the changelog stays linear.
