## 1. Dependencies

- [x] 1.1 Add `typescript-eslint` to devDependencies; remove `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` (`npm install` updates the lockfile)

## 2. ESLint config rewrite

- [x] 2.1 Rewrite `eslint.config.js` on `tseslint.config(...)`: keep the existing ignores block and `js.configs.recommended`; spread `tseslint.configs.recommendedTypeChecked`; set `parserOptions.projectService: true` and `tsconfigRootDir: import.meta.dirname`; keep the existing `no-unused-vars` override with its ignore patterns
- [x] 2.2 Add the `test/**` override disabling exactly `require-await`, `unbound-method`, `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-return`, with a comment explaining the mock/fixture false-positive rationale
- [x] 2.3 Add the `tseslint.configs.disableTypeChecked` block scoped to `**/*.{js,mjs,cjs}` for config files outside tsconfig

## 3. Get the codebase green

- [x] 3.1 Run `npx eslint . --fix` to clear the ~120 `no-unnecessary-type-assertion` hits; review the diff is assertion-removal only
- [x] 3.2 Hand-fix the remaining `src/` violations: 2 `no-base-to-string`, 1 `no-empty-object-type` (no behavior changes)

## 4. Verification

- [x] 4.1 Confirm the guard rules are live: a scratch file with a deliberate floating promise fails lint with `no-floating-promises` (do not commit the scratch file)
- [x] 4.2 Full gate green: `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`

## 5. Docs

- [x] 5.1 Sweep docs for lint-setup claims (AGENTS.md, docs/, README badges/sections) and update any that describe the old non-type-aware config
