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

## Documentation layout

- `docs/architecture/` — one file per architectural concept, describing the **current** state of the codebase (living documents, not historical record). A reader should be able to understand any one concept by reading exactly one file.
- `docs/superpowers/specs/` — design specs, **committed**. The long-lived reviewed record of decisions. If a decision is revisited, write a new spec that supersedes the old one and link the two; the old spec stays so history is readable.
- `docs/superpowers/plans/` — implementation plans, **gitignored**. Local working artifacts. If a plan reveals the spec was wrong, fix the spec and commit that fix; the plan itself stays local.

## Workflow

Non-trivial work uses the superpowers skill chain: `brainstorming` → `writing-plans` → `subagent-driven-development` (or `executing-plans`) → `finishing-a-development-branch`. The chain enforces spec/plan semantics, TDD discipline, review checkpoints, and PR mechanics; AGENTS.md does not duplicate that.

Project-specific addenda to the chain:

- When the change introduces or alters an architectural concept, update or add a file in `docs/architecture/` as part of the same change.
- Open a PR to `main` via `gh pr create`. Never push directly to `main` — the release flow expects a merge commit.
- Trivial work (typo fix, dependency bump, doc tweak) skips the spec.

## Release

- `npm run release` uses `commit-and-tag-version` — driven by Conventional Commits.
- A release should bundle one logical unit of change (one spec → one release where reasonable).
- Update the README in the same change that introduces user-facing behaviour.

Releases always happen on `main`:

1. Open and merge the PR from the feature branch to `main`.
2. Check out `main`, pull, run `npm run release` — bumps the version, updates `CHANGELOG.md`, creates a git tag.
3. Push commits and tags (`git push --follow-tags`). Optionally `npm publish` after explicit user approval.

Never run `npm run release` on a feature branch — the version bump and changelog must land on `main` so the tag points at the merge commit and the changelog stays linear.
