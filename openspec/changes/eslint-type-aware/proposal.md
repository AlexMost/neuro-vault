## Why

The ESLint config runs with `parserOptions.project: false` — no type-aware rules run at all, so the effective coverage is `js.configs.recommended` plus a single `no-unused-vars` override. Strict `tsc --noEmit` catches type errors, but floating promises, promises passed where sync callbacks are expected, and `any` leaks are only catchable by type-aware lint — a relevant gap for an async-heavy MCP server. A probe run showed the codebase is already clean on the headline rules (`no-floating-promises` / `no-misused-promises`: 0 hits), so enabling them now is a cheap, permanent guard rather than a fixing campaign.

## What Changes

**ESLint config plumbing**

- From: separate `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` devDeps, hand-rolled flat config, `project: false`.
- To: `typescript-eslint` meta-package, `tseslint.config(...)` with `recommendedTypeChecked` presets, `parserOptions.projectService: true` (reusing the existing tsconfig — no `tsconfig.eslint.json`), `disableTypeChecked` block for JS config files outside tsconfig.
- Reason: upstream-recommended path; presets track typescript-eslint releases instead of drifting.
- Impact: non-breaking; dev-time only. The two old devDeps become transitive and are removed.

**Rule surface**

- From: `js.configs.recommended` + `@typescript-eslint/no-unused-vars`.
- To: plus full `recommended-type-checked` rule set for `src/`, `scripts/`, and root TS configs; `test/**` additionally disables the test-noisy rules `require-await`, `unbound-method`, and the four `no-unsafe-*` rules (they false-positive on mocks/fixtures). `no-floating-promises`, `no-misused-promises`, `no-unnecessary-type-assertion` stay on everywhere.
- Reason: full strictness where it pays; standard test relaxation instead of a ~358-violation mechanical diff across 60+ test files.
- Impact: non-breaking; CI `npm run lint` gets stricter.

**Code fixes to get green**

- ~120 `no-unnecessary-type-assertion` hits via `eslint --fix` (redundant `!` assertions); 2 `no-base-to-string` and 1 `no-empty-object-type` in `src/` fixed by hand. Types/assertions only — no behavior changes.

## Capabilities

### New Capabilities

- `type-aware-linting`: the repo's lint gate runs type-aware rules (promise misuse, unsafe `any` flows, redundant assertions) over all type-checked sources, with a documented, bounded relaxation for test files.

### Modified Capabilities

_None — no MCP tool contract, parameter, or response shape changes._

## Impact

- `eslint.config.js` — rewritten on `tseslint.config(...)`.
- `package.json` / `package-lock.json` — devDeps: add `typescript-eslint`, remove `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`.
- `src/**` — 3 hand fixes + auto-fixed assertion removals; `test/**` — auto-fixed assertion removals only.
- CI is unchanged (same `npm run lint` step, now stricter); lint runtime grows by type-checking overhead (seconds at this repo size).
