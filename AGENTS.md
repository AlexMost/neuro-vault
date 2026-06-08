# Agent Working Notes

`neuro-vault-mcp` is an MCP server that gives an AI assistant two things over an Obsidian vault: semantic search (over a Smart Connections embedding corpus) and direct vault operations (notes, properties, tags, structured queries). TypeScript, ESM, Node ≥ 20.

This is a cheat sheet for working in the repo — deeper docs live under `docs/` (map: [`docs/README.md`](docs/README.md)), decisions in [`docs/adr/`](docs/adr/INDEX.md). It does not repeat them.

## Run / check

- `npm test` — full vitest suite.
- `npm run lint` — eslint.
- `npx tsc --noEmit` — typecheck. **Authoritative** — a `tsup` build alone is not enough (`isolatedModules`).
- `npm run build` (tsup) · `npm run dev` (`tsx src/cli.ts`) · `npm run spec` (OpenSpec CLI).

`npm test`, `npm run lint`, and `npx tsc --noEmit` must all pass before any commit or PR.

## Workflow

- Capability change → an OpenSpec opsx change; smaller work → a direct PR. Which one: [`.claude/rules/opsx-routing.md`](.claude/rules/opsx-routing.md). Full flow: [`docs/workflow.md`](docs/workflow.md).
- PRs go to `main` via `gh pr create` — never push directly. Release: `npm run release` on `main`, after the PR merges.
