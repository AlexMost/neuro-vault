# Agent Working Notes

A cheat sheet for this repo. Deeper docs live under `docs/` (map: [`docs/README.md`](docs/README.md)); decisions in [`docs/adr/`](docs/adr/INDEX.md). This file does not repeat them.

## Run / check

- `npm test` — full vitest suite.
- `npm run lint` — eslint.
- `npx tsc --noEmit` — typecheck. **Authoritative** — a `tsup` build alone is not enough (`isolatedModules`).
- `npm run build` (tsup) · `npm run dev` (`tsx src/cli.ts`) · `npm run spec` (OpenSpec CLI).

`npm test`, `npm run lint`, and `npx tsc --noEmit` must all pass before any commit or PR.

## Workflow

- Capability change → an OpenSpec opsx change; smaller work → a direct PR. Which one: [`.claude/rules/opsx-routing.md`](.claude/rules/opsx-routing.md). Full flow: [`docs/workflow.md`](docs/workflow.md).
- PRs go to `main` via `gh pr create` — never push directly. Release: `npm run release` on `main`, after the PR merges.
