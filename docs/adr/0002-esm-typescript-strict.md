# ADR-0002 — ESM + TypeScript strict; `tsc --noEmit` is the build source of truth

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

The whole server is TypeScript, shipped as an ESM package (`"type": "module"`) and built with `tsup`. `tsup` is fast because it transpiles per-file under `isolatedModules` — it does **not** do whole-program type checking. A green `tsup` build therefore says nothing about type-correctness across module boundaries, which is exactly where the bugs that matter hide.

## Decision

Strict TypeScript everywhere, ESM module type, and **`npx tsc --noEmit` is the authoritative typecheck** — not the `tsup` build. Type-correctness is gated by `tsc --noEmit`; `tsup` is only the emit step. This gate is one of the three mandatory checks before any commit or PR (see ADR-0003's sibling quality-gate convention in AGENTS.md): `npm test`, `npm run lint`, `npx tsc --noEmit`.

## Consequences

- Cross-module type errors are caught by `tsc --noEmit` that a `tsup` build would pass silently.
- CI / pre-publish runs the full typecheck; contributors must run it locally before claiming "done" — a `tsup` build alone is not evidence.
- ESM-only means consumers import the published `dist/cli.js`; Node ≥ 20 is required (`engines`).

## Alternatives considered

- **Trust the `tsup` build** — faster feedback, but `isolatedModules` makes it blind to whole-program errors; rejected as a false safety signal.
- **CommonJS output** — unnecessary; all consumers and the runtime target support ESM, and the toolchain is ESM-native.
