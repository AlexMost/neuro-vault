<!--
Raw capture of superpowers:brainstorming output (2026-08-20).
Decision log: background → probe data → decision chain Q1–Q3 → validated design.
-->

# Brainstorm — type-aware ESLint

## Background

An engineering review of the repo flagged the ESLint setup as shallow: the flat
config runs with `parserOptions.project: false`, so no type-aware rules run at
all — the effective rule set is `js.configs.recommended` plus a single
`@typescript-eslint/no-unused-vars` override. Strict `tsc --noEmit` covers type
correctness, but whole classes of bugs (floating promises, promises passed
where sync callbacks are expected, `any` leaks) are only catchable by
type-aware lint. For an async-heavy MCP server this is a relevant gap.

Goal: enable type-aware linting (projectService + typescript-eslint
recommended-type-checked, including `no-floating-promises` /
`no-misused-promises`) with the codebase kept green.

## Probe (data gathered before deciding)

A scratch config (recommended-type-checked rules + `projectService: true`) was
run over `src test scripts` before any questions were asked. Results:

- **389 violations total, 66 files** — but `no-floating-promises` and
  `no-misused-promises` had **0 hits**. The headline rules are already clean;
  they land purely as a future guard.
- **`src/` nearly clean: 31 violations** — 28 `no-unnecessary-type-assertion`
  (auto-fixable, mostly redundant `!` after indexing), 2 `no-base-to-string`,
  1 `no-empty-object-type`.
- **`test/` carries 358 violations**, concentrated in three classically
  test-noisy rules: `require-await` (157 — async fixture/mock callbacks with
  no await), `unbound-method` (68 — `expect(mock.method)` patterns),
  `no-unsafe-*` (41), plus 92 auto-fixable `no-unnecessary-type-assertion`.

## Decision chain

**Q1 — ruleset tier?** → **`recommended-type-checked`.**
Rejected: `strict-type-checked` (more stylistic contention and exceptions;
violation count unmeasured), `recommended + stylistic-type-checked` (extra
churn for marginal gain).

**Q2 — test-file policy (358/389 violations live in `test/`)?** →
**Full strictness for `src/` and `scripts/`; relax the noisy rules in
`test/**`** — disable `require-await`, `unbound-method`, and the four
`no-unsafe-*` rules there. Standard practice: these rules false-positive on
mocks and fixtures. `no-floating-promises`, `no-misused-promises`, and
`no-unnecessary-type-assertion` stay on everywhere (floating promises in tests
are exactly the un-awaited-assertion bug class).
Rejected: fixing all 358 by hand (large mechanical diff across 60+ test files
for no behavioral gain), exempting tests from type-aware entirely (loses
`no-floating-promises` where it matters most).

**Q3 — config plumbing?** → **`typescript-eslint` meta-package**, rewrite
`eslint.config.js` on `tseslint.config(...)` with flat presets
(`recommendedTypeChecked`, `disableTypeChecked` for JS config files outside
tsconfig). Upstream-recommended path; separate
`@typescript-eslint/eslint-plugin` + `parser` devDeps become transitive and
are removed.
Rejected: keeping the separate plugin/parser packages and spreading preset
rules by hand (verbose, drifts from upstream docs).

## Validated design (user-approved)

- Add devDep `typescript-eslint`; drop direct `@typescript-eslint/eslint-plugin`
  and `@typescript-eslint/parser`.
- `eslint.config.js` → `tseslint.config(...)`:
  - `js.configs.recommended` + `tseslint.configs.recommendedTypeChecked`,
    `parserOptions.projectService: true` + `tsconfigRootDir` (existing tsconfig
    already includes `src`, `test`, `scripts`, `tsup.config.ts` — no separate
    `tsconfig.eslint.json`).
  - `tseslint.configs.disableTypeChecked` block for `*.js`/`*.mjs`/`*.cjs`
    outside tsconfig (commitlint.config.js, eslint.config.js).
  - `test/**` override disabling: `require-await`, `unbound-method`,
    `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`,
    `no-unsafe-return`.
  - Existing ignores list and `no-unused-vars` ignore-pattern override kept.
- Code fixes: ~120 `no-unnecessary-type-assertion` via `eslint --fix`;
  2 `no-base-to-string` + 1 `no-empty-object-type` in `src/` by hand.
  No behavior changes — types/assertions only.
- Acceptance: `npm run lint` clean; `npm test` (1019 tests), `npm run
  typecheck`, `npm run build` all green; `no-floating-promises` confirmed
  active (a deliberate floating promise in a scratch file must be flagged).
- Risks accepted as minimal: auto-fix only removes assertions the rule proves
  redundant (typecheck backstops); type-aware lint is slower but seconds-scale
  for a repo this size.
