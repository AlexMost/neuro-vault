# Agent Working Notes

`neuro-vault-mcp` is an MCP server that gives an AI assistant two things over an Obsidian vault: semantic search (over a Smart Connections embedding corpus) and direct vault operations (notes, properties, tags, structured queries). TypeScript, ESM, Node ≥ 20.

This is a cheat sheet for working in the repo — deeper docs live under `docs/` (map: [`docs/README.md`](docs/README.md)), decisions in [`docs/adr/`](docs/adr/INDEX.md). It does not repeat them.

## Run / check

- `npm test` — full vitest suite.
- `npm run lint` — eslint.
- `npm run typecheck` (`tsc --noEmit`) — typecheck. **Authoritative** — a `tsup` build alone is not enough (`isolatedModules`).
- `npm run build` (tsup) · `npm run dev` (`tsx src/cli.ts`) · `npm run spec` (OpenSpec CLI).

`npm test`, `npm run lint`, and `npm run typecheck` must all pass before any commit or PR. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) enforces these plus `npm run build` and commitlint on every push to `main` and PR.

## Rarely-used tools

These tools are kept because each is the sole path to its capability; reach for them deliberately:

- `get_note_links` — traverse the wikilink graph around a note (incoming + outgoing edges, including unresolved targets).
- `find_duplicates` — vault-wide all-pairs near-duplicate sweep (corpus hygiene; high embedding similarity).
- `remove_property` — the only way to _delete_ a frontmatter key (`set_property` only sets; `edit_note` preserves frontmatter).

## Agent skills

### Issue tracker

GitHub Issues (`gh`). **Every opsx change is tracked by an issue**; a direct PR gets
one only when the work was planned ahead (typo / dep bump / lint tweak: no issue).
An issue links to its change by **slug**, never by a path — `openspec archive` moves
the change directory before the PR exists. PRs carry `Closes #<n>` in a change's
**last** PR and `Refs #<n>` in earlier ones. A multi-change effort gets an `effort`
epic with the changes as sub-issues; ordering lives in native `blocked_by` edges.
Issues, PRs and repo docs never name private vault paths or note titles.
See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

## Workflow

- Capability change → an OpenSpec opsx change; smaller work → a direct PR. Which one: [`.claude/rules/opsx-routing.md`](.claude/rules/opsx-routing.md). Full flow: [`docs/workflow.md`](docs/workflow.md).
- PRs go to `main` via `gh pr create` — never push directly. Release: `npm run release` on `main`, after the PR merges. Pushing the tag auto-publishes the GitHub Release from the `CHANGELOG.md` section.
