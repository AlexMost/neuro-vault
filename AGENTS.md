# Agent Working Notes

`neuro-vault-mcp` is an MCP server that gives an AI assistant two things over an Obsidian vault: semantic search (over the server's own embedding corpus) and direct vault operations (notes, properties, tags, structured queries). TypeScript, ESM, Node 20.19+ / 22.12+ / 23+.

This is a cheat sheet for working in the repo — deeper docs live under `docs/` (map: [`docs/README.md`](docs/README.md)), decisions in [`docs/adr/`](docs/adr/INDEX.md). It does not repeat them.

## Run / check

- `npm test` — full vitest suite.
- `npm run lint` — eslint.
- `npm run typecheck` (`tsc --noEmit`) — typecheck. **Authoritative** — a `tsup` build alone is not enough (`isolatedModules`).
- lefthook's `post-checkout` / `post-merge` / `post-rewrite` hooks run `npm ci` whenever HEAD moves to a different `package-lock.json` ([`scripts/sync-deps.sh`](scripts/sync-deps.sh)): a stale install makes type-aware lint report errors CI never sees.
- `npm run build` (tsup) · `npm run dev` (`tsx src/cli.ts`) · `npm run spec` (OpenSpec CLI) · `npm run eval` (offline retrieval-quality harness — [`eval/README.md`](eval/README.md)).
- Tool tests reach a tool through `registerTool(buildXTool(deps))` and the `callTool` / `expectToolError` helpers in [`test/_gate.ts`](test/_gate.ts) — never `buildXTool(deps).handler`. The registration gate coerces, closes the schema with `.strict()`, and fails as `INVALID_PARAMS`; a handler-direct call enters past all three. See [ADR-0015](docs/adr/0015-input-gate-owns-schema-validation.md).

`npm test`, `npm run lint`, `npm run typecheck`, and `npm run format` must all pass before any commit or PR. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) enforces these plus `npm run build` and commitlint on every push to `main` and PR.

## Rarely-used tools

These tools are kept because each is the sole path to its capability; reach for them deliberately:

- `get_note_links` — traverse the wikilink graph around a note (incoming + outgoing edges, including unresolved targets).
- `find_duplicates` — vault-wide all-pairs near-duplicate sweep (corpus hygiene; high embedding similarity).
- `remove_property` — the only way to _delete_ a frontmatter key (`set_property` only sets; `edit_note` preserves frontmatter).

## Workflow

- Capability change → an OpenSpec opsx change; smaller work → a direct PR. Which one: [`.claude/rules/opsx-routing.md`](.claude/rules/opsx-routing.md). Full flow: [`docs/workflow.md`](docs/workflow.md).
- Every opsx change is tracked by a GitHub issue; a direct PR gets one only when the work was planned ahead. PRs carry `Closes #<n>` in a change's last PR, `Refs #<n>` in earlier ones. Conventions: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- PRs go to `main` via `gh pr create` — never push directly. Release: `npm run release` on `main`, after the PR merges. Pushing the tag auto-publishes the GitHub Release from the `CHANGELOG.md` section.

## Commits

- Conventional Commits: `type(scope): subject`; a breaking change is `type!:` plus a `BREAKING CHANGE:` footer. commitlint (`@commitlint/config-conventional`) checks **every commit** of a PR, not only the merge title, so one bad message fails the PR and only a history rewrite and force-push fixes it.
- Wrap body lines at 100 characters or fewer — the rule that fails most often. The lefthook `commit-msg` hook ([`lefthook.yml`](lefthook.yml), installed by `npm install`) runs commitlint on each commit; for commits made around it (`--no-verify`, cherry-picks), check the branch before pushing: `npx commitlint --from origin/main --to HEAD`.
- End every commit with one `Co-Authored-By:` trailer naming the session's primary model.
