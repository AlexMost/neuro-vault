# type-aware-linting Specification

## Purpose
TBD - created by archiving change eslint-type-aware. Update Purpose after archive.
## Requirements
### Requirement: Type-aware rules run over all type-checked sources
The lint gate (`npm run lint`) SHALL run the typescript-eslint `recommended-type-checked` rule set, with type information sourced from the repository's existing `tsconfig.json` via `projectService`, over every file that tsconfig includes (`src/`, `test/`, `scripts/`, root TS configs).

#### Scenario: Floating promise is rejected
- **WHEN** a TS file under `src/` (or any type-checked path) contains an un-awaited, un-voided Promise-returning call as a statement
- **THEN** `npm run lint` fails with `@typescript-eslint/no-floating-promises`

#### Scenario: Promise misuse in a sync position is rejected
- **WHEN** a Promise-returning function is passed where a void-returning callback is expected
- **THEN** `npm run lint` fails with `@typescript-eslint/no-misused-promises`

#### Scenario: Redundant type assertion is rejected everywhere
- **WHEN** a file in `src/` or `test/` contains a non-null or type assertion the type-checker proves unnecessary
- **THEN** `npm run lint` fails with `@typescript-eslint/no-unnecessary-type-assertion`

### Requirement: Test files get a bounded, documented relaxation
The lint config SHALL disable exactly these rules for `test/**` and no others: `@typescript-eslint/require-await`, `@typescript-eslint/unbound-method`, `@typescript-eslint/no-unsafe-member-access`, `@typescript-eslint/no-unsafe-assignment`, `@typescript-eslint/no-unsafe-argument`, `@typescript-eslint/no-unsafe-return`; the relaxation MUST be expressed as a single `test/**`-scoped override in `eslint.config.js` with a comment stating why.

#### Scenario: Test-noisy rule silent in tests, active in src
- **WHEN** an `async` function without `await` (an interface-conforming mock) exists in `test/**` and an equivalent one exists in `src/`
- **THEN** `npm run lint` passes the test file and fails the `src/` file with `@typescript-eslint/require-await`

#### Scenario: Floating promises still rejected in tests
- **WHEN** a test file contains an un-awaited Promise-returning assertion or helper call as a statement
- **THEN** `npm run lint` fails with `@typescript-eslint/no-floating-promises`

### Requirement: Files without type information stay lintable
The lint config SHALL apply the `disableTypeChecked` preset to JS config files outside tsconfig (`**/*.{js,mjs,cjs}`), so linting them succeeds without type-aware rules instead of crashing the run.

#### Scenario: Root JS config files lint cleanly
- **WHEN** `npm run lint` runs over the repo including `eslint.config.js` and `commitlint.config.js`
- **THEN** the run completes without parser "file not found in project service" errors

### Requirement: Config tracks upstream presets
The ESLint flat config SHALL be composed with `defineConfig(...)` from `'eslint/config'`, referencing the `typescript-eslint` meta-package's named presets (`recommendedTypeChecked`, `disableTypeChecked`) rather than hand-copied rule lists; `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` MUST NOT appear as direct devDependencies.

#### Scenario: Presets referenced, not inlined
- **WHEN** `eslint.config.js` and `package.json` are inspected
- **THEN** the config spreads `tseslint.configs.recommendedTypeChecked`, and `package.json` devDependencies contain `typescript-eslint` but neither `@typescript-eslint/eslint-plugin` nor `@typescript-eslint/parser`

