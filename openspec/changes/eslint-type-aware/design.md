## Context

The repo lints with a hand-rolled flat config: `js.configs.recommended`, the
`@typescript-eslint` parser with `parserOptions.project: false`, and a single
`no-unused-vars` override. No type-aware rule runs. Strict `tsc --noEmit` is
the type-correctness gate (ADR-0002), but promise misuse and `any` leaks are
invisible to both tsc and non-type-aware lint.

A probe (recommended-type-checked + `projectService: true` over
`src test scripts`) established the ground truth this design is built on:

- `no-floating-promises` / `no-misused-promises`: **0 hits** — pure guard, no
  fixing campaign.
- `src/`: 31 hits (28 auto-fixable `no-unnecessary-type-assertion`,
  2 `no-base-to-string`, 1 `no-empty-object-type`).
- `test/`: 358 hits, dominated by `require-await` (157), `unbound-method` (68),
  `no-unsafe-*` (41) — classic test-noise rules firing on mocks/fixtures —
  plus 92 auto-fixable `no-unnecessary-type-assertion`.

Constraints: dev-tooling only — no MCP tool contract changes; CI keeps the
same `npm run lint` step; the existing tsconfig already includes `src`,
`test`, `scripts`, and `tsup.config.ts`.

## Goals / Non-Goals

**Goals:**

- Type-aware linting on by default for all type-checked sources, with
  `no-floating-promises` and `no-misused-promises` active everywhere.
- `npm run lint` green at merge; `npm test`, `npm run typecheck`,
  `npm run build` unaffected.
- Config tracks upstream presets instead of hand-rolled rule lists.

**Non-Goals:**

- No `strict-type-checked` or `stylistic-type-checked` tiers (weighed and
  rejected in brainstorm — contention over marginal gain).
- No mass rewrite of test files to satisfy test-noisy rules.
- No `noUncheckedIndexAccess` or other tsconfig changes.
- No CI workflow changes.

## Decisions

### D1: Ruleset tier — `recommended-type-checked`

- **Choice**: `tseslint.configs.recommendedTypeChecked` as the base.
- **Why**: best signal/noise at measured cost (389 violations, only 31 in
  `src/`); contains all the motivating rules.
- **Alternatives**: `strict-type-checked` — more stylistic contention,
  unmeasured violation count; `+ stylistic-type-checked` — extra churn,
  marginal gain. Both rejected.

### D2: Test policy — full strictness in `src/`/`scripts/`, bounded relaxation in `test/**`

- **Choice**: a `test/**` override disables `require-await`, `unbound-method`,
  `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`,
  `no-unsafe-return`. Everything else — notably `no-floating-promises`,
  `no-misused-promises`, `no-unnecessary-type-assertion` — stays on everywhere.
- **Why**: the six disabled rules produced 358/389 hits, all false-positive
  patterns on mocks and fixtures (async interface conformance without await,
  `expect(mock.method)`, `unknown` probing). Floating promises in tests are
  the un-awaited-assertion bug class, so that rule must stay.
- **Alternatives**: fix all 358 by hand — large mechanical diff across 60+
  test files, no behavioral gain; exempt `test/**` from type-aware entirely —
  loses `no-floating-promises` where it matters most. Both rejected.

### D3: Plumbing — `typescript-eslint` meta-package + `projectService`

- **Choice**: add devDep `typescript-eslint`; rewrite `eslint.config.js` on
  `tseslint.config(...)`; `parserOptions.projectService: true` +
  `tsconfigRootDir: import.meta.dirname`; drop direct
  `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` devDeps
  (they arrive transitively).
- **Why**: upstream-recommended entry point; presets track releases;
  `projectService` reuses the existing tsconfig, so no `tsconfig.eslint.json`.
- **Alternatives**: keep separate plugin/parser and spread preset rules by
  hand (as the probe did) — verbose, drifts from upstream docs. Rejected.

### D4: JS config files — `disableTypeChecked`

- **Choice**: a final `tseslint.configs.disableTypeChecked` block scoped to
  `**/*.{js,mjs,cjs}` (commitlint.config.js, eslint.config.js — files outside
  tsconfig).
- **Why**: type-aware rules crash on files without type information; this is
  the documented escape hatch.
- **Alternatives**: `allowDefaultProject` — pulls config files into the
  project service for near-zero lint value at real cost. Rejected.

### D5: Getting green — auto-fix plus three hand fixes

- **Choice**: run `eslint --fix` for the ~120 `no-unnecessary-type-assertion`
  hits; hand-fix 2 `no-base-to-string` and 1 `no-empty-object-type` in `src/`.
- **Why**: the auto-fix only removes assertions the type-checker proves
  redundant; `tsc --noEmit` backstops every removal. Types/assertions only —
  no behavior changes.

## Risks / Trade-offs

- [Risk] Auto-fix removes a `!` that was load-bearing under a future tsconfig
  change (e.g. enabling `noUncheckedIndexAccess`). → Mitigation: `npm run
  typecheck` runs in the same gate; any such site fails loudly at that future
  change, not silently now.
- [Risk] `projectService` lint is slower than untyped lint. → Mitigation:
  accepted; seconds-scale at 86 source files, and CI already type-checks the
  same program.
- [Trade-off] Six rules dark in `test/**` — a real unsafe-`any` bug in a test
  helper goes unlinted. → Accepted: tests are executed, not shipped; the
  1019-test suite is the functional gate; relaxation is bounded and documented
  in the config.
- [Trade-off] Preset-tracking means new typescript-eslint minors can introduce
  new violations. → Accepted: violations surface at dep-bump PRs where they
  are cheap to fix or pin.

## Migration Plan

N/A — dev-tooling change only; no deploy, endpoint, or data concerns.
Land as one PR: deps + config + code fixes must merge together (config alone
turns CI red). Rollback = revert the PR. Acceptance: `npm run lint`,
`npm test`, `npm run typecheck`, `npm run build` all green; a deliberate
floating promise in a scratch file is flagged by `no-floating-promises`
(verified during implementation, not committed).

## Open Questions

None — all forks resolved in brainstorm (Q1–Q3).
