# Type-Aware ESLint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on typescript-eslint `recommended-type-checked` (incl. `no-floating-promises` / `no-misused-promises`) via `projectService`, with a bounded relaxation for `test/**`, and land the repo green.

**Architecture:** Replace the hand-rolled flat config with `defineConfig(...)` from `'eslint/config'`, composing the `typescript-eslint` meta-package's presets. Type info comes from the existing `tsconfig.json` (it already includes `src`, `test`, `scripts`, `tsup.config.ts`) — no `tsconfig.eslint.json`. JS config files outside tsconfig get `disableTypeChecked`. Code changes are types/assertions only.

**Tech Stack:** ESLint 9 flat config, `typescript-eslint` ^8.67.0, Node ≥ 20, npm.

## Global Constraints

- Repo gate: `npm run lint`, `npm test`, `npm run typecheck`, `npm run build` must all pass before any commit or PR (AGENTS.md).
- Conventional Commits enforced by commitlint.
- Dev-tooling change only: no MCP tool contract, parameter, or response-shape changes.
- No behavior changes in `src/` — types/assertions/suppressions only.
- Everything lands as ONE PR (config alone would turn CI red; deps + config + fixes are inseparable).
- Reference artifacts: `openspec/changes/eslint-type-aware/{design.md,specs/type-aware-linting/spec.md}`.
- Expected violation counts below come from a probe with plugin v8.31; the meta-package pulls a newer plugin, so counts may drift by a few — the acceptance criterion is "lint green at the end of Task 3", not exact counts.

---

### Task 1: Swap ESLint dependencies

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `package-lock.json` (via npm, never by hand)

**Interfaces:**
- Consumes: nothing.
- Produces: importable `typescript-eslint` package (default export `tseslint` with `.config`, `.configs.recommendedTypeChecked`, `.configs.disableTypeChecked`) for Task 2.

- [ ] **Step 1: Swap the packages**

```bash
npm uninstall @typescript-eslint/eslint-plugin @typescript-eslint/parser && npm install -D typescript-eslint@^8.67.0
```

- [ ] **Step 2: Verify the swap**

Run: `npm ls typescript-eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser`
Expected: `typescript-eslint@8.67.x` as a direct devDep; the plugin and parser appear only as its transitive deps (marked `deduped`/nested), not top-level.
Also run: `grep -c '"@typescript-eslint/' package.json`
Expected: `0` (no direct entries left in package.json).

- [ ] **Step 3: Confirm the old config still lints (parser resolves transitively)**

Run: `npm run lint`
Expected: PASS (old `eslint.config.js` imports `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`, which still resolve transitively — this keeps the tree bisectable).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): swap @typescript-eslint plugin+parser for the typescript-eslint meta-package"
```

---

### Task 2: Rewrite eslint.config.js on tseslint.config

**Files:**
- Modify: `eslint.config.js` (full rewrite, content below)

**Interfaces:**
- Consumes: `typescript-eslint` meta-package from Task 1.
- Produces: the lint surface Tasks 3–4 run against. Rule set per spec: `recommendedTypeChecked` everywhere; six rules off in `test/**`; `disableTypeChecked` for `**/*.{js,mjs,cjs}`.

- [ ] **Step 1: Replace the whole file with:**

```js
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.worktrees/**',
      'package-lock.json',
      '.claude/worktrees/**',
      // subagent-driven-development scratch (ledger, task briefs, review
      // diffs) — throwaway, deleted at the end of each apply run.
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test-only relaxation: these rules false-positive on the mock/fixture
    // idiom — async interface conformance without await, expect(mock.method),
    // probing unknown payloads. Promise-safety rules (no-floating-promises,
    // no-misused-promises) stay ON here deliberately: an un-awaited assertion
    // is exactly the bug class tests must not have.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // JS config files (eslint.config.js, commitlint.config.js) sit outside
    // tsconfig — no type info, so type-aware rules must not run on them.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
```

- [ ] **Step 1b: Add vitest.config.ts to the TS project**

`vitest.config.ts` is NOT in tsconfig's `include` (`["src", "test", "scripts", "tsup.config.ts"]`), so `projectService` errors on it. Ruling (user, 2026-08-20): bring it into the project rather than exempting it from type-aware lint. In `tsconfig.json`:

```json
  "include": ["src", "test", "scripts", "tsup.config.ts", "vitest.config.ts"]
```

Notes for the implementer:
- `defineConfig` from `'eslint/config'` is used instead of the deprecated `tseslint.config(...)` helper (ruling, 2026-08-20; typescript-eslint ≥8.67 deprecates the latter in favor of ESLint's own `defineConfig`).
- The old `globals: { console, process, URL }` block is dropped on purpose: the typescript-eslint presets disable core `no-undef` for TS files (TS itself checks identifiers), and the remaining JS files (`eslint.config.js`, `commitlint.config.js`) contain only imports/exports. Step 2 verifies this.
- `import.meta.dirname` needs Node ≥ 20.11 — fine for local dev and CI (`node-version: 20` resolves to latest 20.x).

- [ ] **Step 2: Run lint over the repo; expect ONLY the known backlog**

Run: `npx eslint . 2>&1 | tail -5`
Expected: roughly `✖ ~120–140 problems` (the `no-unnecessary-type-assertion` backlog in src+test, plus 2 `no-base-to-string`, 1 `no-empty-object-type`). MUST NOT contain: parser errors ("was not found by the project service"), `no-undef` hits, or any `require-await`/`unbound-method`/`no-unsafe-*` hits from `test/**` files.
If `no-undef` fires anywhere: add a `globals` entry for that file's block instead of reverting the drop.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "feat(lint): enable type-aware linting via typescript-eslint recommendedTypeChecked"
```

(CI would be red at this commit if pushed alone — acceptable inside the PR; the branch is only merged green at HEAD.)

---

### Task 3: Get the codebase green

**Files:**
- Modify: ~60 files in `src/**` and `test/**` (mechanical `--fix` output)
- Modify: `src/lib/obsidian/query/query-notes.ts:322-338`
- Modify: `src/modules/operations/index.ts:8`

**Interfaces:**
- Consumes: the Task 2 config.
- Produces: `npm run lint` exits 0; no runtime behavior change (Task 4 proves it with the full suite).

- [ ] **Step 1: Auto-fix the redundant assertions**

Run: `npx eslint . --fix`
Then: `git diff --stat` and skim `git diff` — every hunk must be an assertion removal (`x!` → `x`, `x as T` → `x`) and nothing else. Revert anything that isn't.

- [ ] **Step 2: Hand-fix no-base-to-string in query-notes.ts**

At `src/lib/obsidian/query/query-notes.ts:335-336` the current code is:

```ts
  const sa = String(a);
  const sb = String(b);
```

`a`/`b` are `unknown` frontmatter values; falling back to default stringification (objects → `'[object Object]'`, i.e. all objects tie) is the existing, deliberate sort convention, and changing it (e.g. to `JSON.stringify`) would reorder array-valued properties — a behavior change this plan forbids. Suppress with intent documented:

```ts
  // Deliberate: non-primitive values fall back to default stringification and
  // tie with each other — sort order for objects/arrays is not part of the
  // query contract (only missing-last and primitive ordering are).
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const sa = String(a);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const sb = String(b);
```

- [ ] **Step 3: Hand-fix no-empty-object-type in operations/index.ts**

At `src/modules/operations/index.ts:8` replace:

```ts
// empty body — reserved for future module-level options
export interface IOperationsModuleConfig {}
```

with:

```ts
// no options yet — becomes an interface again when the first option lands
export type IOperationsModuleConfig = Record<string, never>;
```

(`createOperationsModule`'s `_config: IOperationsModuleConfig = {}` default still type-checks: `{}` is assignable to `Record<string, never>`.)

- [ ] **Step 4: Lint must be clean**

Run: `npm run lint`
Expected: exit 0, no output.

- [ ] **Step 5: Typecheck backstops the assertion removals**

Run: `npm run typecheck`
Expected: exit 0. If any removed `!` was load-bearing, it fails here — restore that single assertion and add it to the commit message as a note.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "fix(lint): clear the type-aware backlog (redundant assertions, base-to-string, empty interface)"
```

---

### Task 4: Verify the guard rules are live, then run the full gate

**Files:**
- Create (temporarily): `src/lint-canary.ts` — MUST be deleted in this task, never committed.

**Interfaces:**
- Consumes: green tree from Task 3.
- Produces: verified acceptance criteria from `specs/type-aware-linting/spec.md`.

- [ ] **Step 1: Prove no-floating-promises fires (spec scenario "Floating promise is rejected")**

```bash
cat > src/lint-canary.ts <<'EOF'
async function canary(): Promise<void> {}
export function trigger(): void {
  canary();
}
EOF
npx eslint src/lint-canary.ts
```

Expected: FAIL with `@typescript-eslint/no-floating-promises`.

- [ ] **Step 2: Prove require-await stays active in src (spec scenario "Test-noisy rule silent in tests, active in src")**

```bash
cat > src/lint-canary.ts <<'EOF'
export async function canary(): Promise<number> {
  return 1;
}
EOF
npx eslint src/lint-canary.ts
```

Expected: FAIL with `@typescript-eslint/require-await`. (The equivalent pattern already exists un-flagged all over `test/**` — Task 2 Step 2 verified the relaxation.)

- [ ] **Step 3: Delete the canary**

```bash
rm src/lint-canary.ts
git status --porcelain
```

Expected: clean tree (nothing to commit from this task).

- [ ] **Step 4: Full gate**

Run: `npm run lint && npm test && npm run typecheck && npm run build`
Expected: all four exit 0; vitest reports 1019 passed (same count as before this change — the suite is the no-behavior-change proof).

---

### Task 5: Docs sweep

**Files:**
- Modify: any doc that describes the old lint setup (locate in Step 1; likely candidates: `AGENTS.md`, `docs/workflow.md`, `docs/architecture/*.md`)

**Interfaces:**
- Consumes: final config from Tasks 1–3.
- Produces: docs consistent with the type-aware setup (per the repo rule: sweep ALL of docs/, including docs/guide/, after behavior-relevant changes).

- [ ] **Step 1: Find stale claims**

```bash
grep -rn -i -e 'eslint' -e '"lint' -e 'npm run lint' AGENTS.md README.md docs/ --include='*.md' | grep -v docs/superpowers/
```

For each hit, decide: does the sentence still hold with type-aware linting on? (`docs/superpowers/` is frozen — never edit it.)

- [ ] **Step 2: Update what's stale**

Expected scope: at most a sentence or two — e.g. if a doc says lint is "eslint recommended only" or lists the two old devDeps. If every hit still holds, record "no stale claims found" in the task ledger and skip the commit.

- [ ] **Step 3: Commit (only if edits were made)**

```bash
git add AGENTS.md README.md docs/
git commit -m "docs: reflect type-aware eslint setup"
```

---

## Self-review (done at authoring time)

- Spec coverage: R1 (type-aware everywhere) → Tasks 2+4; R2 (bounded test relaxation, comment required) → Task 2 config + Step 2 check + Task 4 Step 2; R3 (disableTypeChecked for JS) → Task 2 config + Step 2 "no parser errors"; R4 (meta-package, no direct plugin/parser deps) → Task 1.
- No placeholders: full config text, exact fix code, exact commands and expected outputs included.
- Type consistency: `IOperationsModuleConfig` alias keeps the same exported name; no other signatures change.
