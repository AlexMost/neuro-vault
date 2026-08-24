# CLI `--version` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `neuro-vault-mcp` a `--version` flag that prints the published version and exits 0, and stop `--help` from falling through into the `--vault is required` error.

**Architecture:** `src/cli.ts` calls `parseConfig(argv)` and hands the result to `startNeuroVaultServer`. `parseConfig` builds a yargs parser with `.exitProcess(false)`, so when yargs *itself* satisfies an invocation (help, version) it prints and returns instead of exiting — and today control falls through into vault validation. The fix makes that outcome representable: `parseConfig` returns a discriminated union, and `cli.ts` returns early on the `handled` variant. A new `src/package-meta.ts` becomes the single reader of `package.json`, consumed by both the CLI's version flag and the MCP server identity.

**Tech Stack:** TypeScript (strict, ESM, `isolatedModules`), Node ≥ 20, yargs 18, vitest 3, tsup (single-file bundle to `dist/cli.js`).

**Spec:** `openspec/changes/cli-version-flag/specs/cli-startup-flags/spec.md` · design rationale in `openspec/changes/cli-version-flag/design.md` · task grouping in `openspec/changes/cli-version-flag/tasks.md`

## Global Constraints

- `npm test`, `npm run lint`, and `npm run typecheck` must all pass before any commit or PR (AGENTS.md).
- `npm run typecheck` (`tsc --noEmit`) is **authoritative** for type-correctness. A successful `tsup` build is not sufficient — the bundler runs with `isolatedModules` and does not type-check across files (ADR-0002).
- ESM only. Every relative import inside `src/` carries a `.js` extension, even when the source file is `.ts`.
- Conventional Commits. Commit messages use `feat:` / `fix:` / `refactor:` / `docs:` / `test:` prefixes; commitlint runs in CI.
- Tests use dependency injection through the existing `NeuroVaultStartupDependencies` seam (`serverFactory`, `transportFactory`, `vaultEntryDeps`). Do **not** reach for `vi.mock` on modules.
- `src/package-meta.ts` must stay at `src/` root depth. See Task 1 for why — moving it breaks the published binary while every source-level test keeps passing.
- Never push directly to `main`. Work goes to `main` via `gh pr create`.

---

### Task 1: Single source for the package version

Today `src/server.ts` reads `package.json` directly to build the MCP server identity. The CLI needs the same string. Two independent reads of one value drift, so this task extracts the read into a module both consume.

**The path depth is load-bearing.** `createRequire(import.meta.url)` resolves `'../package.json'` against the file that is actually *running*. tsup flattens the entire bundle into a single `dist/cli.js` and never rewrites that literal string. `src/` and `dist/` sit at the same depth under the package root, so `'../package.json'` reaches the root from both. A module at `src/lib/package-meta.ts` would need `'../../package.json'` — correct from source, pointing *above* the package root once bundled. A unit test running against `src/` would pass while the published binary crashed. Keep the file at `src/package-meta.ts`.

**Files:**

- Create: `src/package-meta.ts`
- Create: `test/package-meta.test.ts`
- Modify: `src/server.ts:1` (drop the now-unused `createRequire` import), `src/server.ts:22-26` (replace the local read)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `export const packageMeta: { name: string; version: string }` from `src/package-meta.ts`. Tasks 2 and 3 import it as `import { packageMeta } from './package-meta.js'` (from `src/`) or `from '../src/package-meta.js'` (from `test/`).

- [ ] **Step 1: Write the failing test**

Create `test/package-meta.test.ts`. The test reads the manifest independently, so the assertion is a real comparison rather than a tautology:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { packageMeta } from '../src/package-meta.js';

describe('packageMeta', () => {
  it('mirrors the package manifest', async () => {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(packageMeta.name).toBe(manifest.name);
    expect(packageMeta.version).toBe(manifest.version);
    expect(packageMeta.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/package-meta.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/package-meta.js"`.

- [ ] **Step 3: Create the module**

Create `src/package-meta.ts`:

```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The one place `package.json` is read at runtime — consumed by the CLI's
 * `--version` flag and by the MCP server identity.
 *
 * The path is resolved against the *emitted* file, not this source file: tsup
 * flattens the whole bundle into `dist/cli.js` and never rewrites this literal
 * string. `src/` and `dist/` sit at the same depth under the package root, so
 * `'../package.json'` is correct from both — which is exactly why this module
 * must stay at `src/` root depth and not move under `src/lib/`. A deeper path
 * would still pass every source-level test and break the published binary.
 */
export const packageMeta = require('../package.json') as {
  name: string;
  version: string;
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/package-meta.test.ts
```

Expected: PASS.

- [ ] **Step 5: Point `server.ts` at the shared module**

In `src/server.ts`, delete the `createRequire` import on line 1 and replace the block at lines 22-26.

Remove:

```ts
import { createRequire } from 'node:module';
```

Replace:

```ts
const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};
```

with:

```ts
const { name: SERVER_NAME, version: SERVER_VERSION } = packageMeta;
```

and add to the existing import block (alongside the other `./`-relative imports):

```ts
import { packageMeta } from './package-meta.js';
```

- [ ] **Step 6: Verify the manifest is now read exactly once**

```bash
grep -rn "package.json" src/
```

Expected: exactly one hit, the `require('../package.json')` inside `src/package-meta.ts`. This is the spec's "No second manifest read" scenario.

- [ ] **Step 7: Run the full suite plus typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all pass. The MCP identity is unchanged, so the existing server tests must stay green — if any fail, the extraction changed behaviour and must be corrected, not the test.

- [ ] **Step 8: Commit**

```bash
git add src/package-meta.ts test/package-meta.test.ts src/server.ts
git commit -m "refactor: read package.json from one module"
```

---

### Task 2: Make "the parser already handled it" representable

`parseConfig` currently promises a `ServerConfig` unconditionally, so "the CLI ended without producing a config" has nowhere to live in the type — which is precisely why `--help` falls through into the `--vault` guard. This task adds the union, enables the version flag, and short-circuits both flags.

Two facts, both verified empirically against the yargs version in this repo:

- `.version('9.9.9')` under `.exitProcess(false)` emits exactly one `console.log('9.9.9')` — the bare string, no program name.
- yargs sets `help: true` / `version: true` on the returned argv **only** when that flag fired. A normal `--vault /tmp` parse returns neither key. That makes `args.help === true || args.version === true` an exact signal.

**Files:**

- Modify: `src/config.ts:1-10` (imports), `src/config.ts:50-92` (the `parseConfig` body)
- Test: `test/config.test.ts`

**Interfaces:**

- Consumes: `packageMeta` from Task 1.
- Produces:
  ```ts
  export type ParsedCli =
    | { kind: 'run'; config: ServerConfig }
    | { kind: 'handled' };

  export function parseConfig(argv: string[]): Promise<ParsedCli>;
  ```
  Task 3 consumes exactly this. The variant tags are the strings `'run'` and `'handled'` — no other spelling.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts`. Note the two new imports at the top of the file — `vi` joins the existing `vitest` import, and `packageMeta` is new:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packageMeta } from '../src/package-meta.js';
```

Then add these cases inside the existing `describe('parseConfig', ...)` block:

```ts
it('--version prints the bare version and needs no --vault', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const parsed = await parseConfig(['node', 'cli.js', '--version']);

    expect(parsed).toEqual({ kind: 'handled' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(packageMeta.version);
  } finally {
    log.mockRestore();
  }
});

it('--help exits cleanly instead of falling through to the --vault error', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const parsed = await parseConfig(['node', 'cli.js', '--help']);

    expect(parsed).toEqual({ kind: 'handled' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('--vault');
  } finally {
    log.mockRestore();
  }
});

it('still rejects a run invocation with no --vault', async () => {
  await expect(parseConfig(['node', 'cli.js', '--semantic'])).rejects.toThrow(/--vault/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/config.test.ts
```

Expected: the `--version` and `--help` cases FAIL — both currently reject with `--vault is required` instead of resolving. That failure *is* the bug this task fixes.

- [ ] **Step 3: Add the union and the version flag**

In `src/config.ts`, add the import next to the existing `./types.js` import:

```ts
import { packageMeta } from './package-meta.js';
```

Add the exported type above `parseConfig`:

```ts
/**
 * The two ways argument parsing can end.
 *
 * `handled` means yargs itself satisfied the invocation — it printed help or
 * the version and, because of `.exitProcess(false)`, returned instead of
 * exiting. There is no config to produce and nothing left to validate.
 */
export type ParsedCli = { kind: 'run'; config: ServerConfig } | { kind: 'handled' };
```

- [ ] **Step 4: Short-circuit in `parseConfig`**

Change the signature:

```ts
export async function parseConfig(argv: string[]): Promise<ParsedCli> {
```

In the yargs chain, replace `.version(false)` with:

```ts
    .version(packageMeta.version)
```

Immediately after the `.parse()` call and **before** `const rawVaults = args.vault ?? [];`, insert:

```ts
  // yargs already satisfied this invocation by printing help or the version.
  // `.exitProcess(false)` means it did not exit for us, so stop here — running
  // the --vault guard below would print a spurious error after the help text
  // and exit non-zero.
  if (args.help === true || args.version === true) {
    return { kind: 'handled' };
  }
```

Finally, wrap the existing return value:

```ts
  return {
    kind: 'run',
    config: {
      vaults,
      semantic: {
        enabled: args.semantic,
        modelKey: DEFAULT_MODEL_KEY,
        modelId: DEFAULT_MODEL_ID,
      },
    },
  };
```

- [ ] **Step 5: Update the existing assertions for the new shape**

Let the compiler enumerate every call site rather than hunting by eye:

```bash
npm run typecheck
```

Each error points at a `parseConfig` result in `test/config.test.ts` used as a `ServerConfig`. The fix is mechanical — narrow, then read `.config`. For example:

```ts
const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
if (parsed.kind !== 'run') throw new Error('expected a run configuration');
expect(parsed.config.vaults).toEqual([
  {
    name: 'Sandbox',
    path: vaultPath,
    smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
  },
]);
```

The `rejects.toThrow(...)` cases need no change — they never touch the resolved value. Repeat until `npm run typecheck` is clean.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/config.test.ts && npm run typecheck
```

Expected: PASS and a clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(cli): add --version and stop --help falling through"
```

---

### Task 3: Entry point honours the short-circuit

`parseConfig` now reports `handled`, but `main()` still ignores it. Until this task lands, `--version` prints the version and then starts an MCP server — writing JSON-RPC frames onto the same stdout that just received the version string. The test below is what pins that shut.

**Files:**

- Modify: `src/cli.ts:9-15` (the `main` function)
- Test: `test/server-modules.test.ts`

**Interfaces:**

- Consumes: `ParsedCli` from Task 2.
- Produces: no signature change — `main(argv?, deps?)` keeps returning `Promise<void>`.

- [ ] **Step 1: Write the failing test**

Add to `test/server-modules.test.ts`. It uses the same `NeuroVaultStartupDependencies` DI seam the existing tests in this file already use (`serverFactory`, `transportFactory`), so no module mocking is needed:

```ts
describe('informational flags', () => {
  it.each([['--version'], ['--help']])(
    '%s never constructs a server or opens the transport',
    async (flag) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const serverFactory = vi.fn(() => createFakeServer());
      const transportFactory = vi.fn(() => ({}) as never);

      try {
        await main(['node', 'cli.js', flag], { serverFactory, transportFactory });

        expect(serverFactory).not.toHaveBeenCalled();
        expect(transportFactory).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      } finally {
        log.mockRestore();
      }
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/server-modules.test.ts -t "never constructs a server"
```

Expected: FAIL — `main` still passes a config through to `startNeuroVaultServer`, so `serverFactory` is called. (At this point it may also fail earlier, on the `parsed.config` type, which the next step resolves.)

- [ ] **Step 3: Return early in `main`**

Replace the body of `main` in `src/cli.ts`:

```ts
export async function main(
  argv: string[] = process.argv,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const parsed = await parseConfig(argv);
  // yargs printed help or the version — nothing to run, exit 0.
  if (parsed.kind === 'handled') return;
  await startNeuroVaultServer(parsed.config, deps);
}
```

Leave `run()` and `checkIsEntrypoint()` untouched. `process.exitCode` is never assigned on this path, so the process exits 0.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/server-modules.test.ts
```

Expected: PASS, with the pre-existing tests in the file still green.

- [ ] **Step 5: Confirm the error path is unchanged**

Read `run()` in `src/cli.ts` and confirm it still catches, prints to `console.error`, and sets `process.exitCode = 1`. Then check the behaviour end to end:

```bash
npx tsx src/cli.ts --vault relative/path; echo "exit=$?"
```

Expected: the `--vault: path must be absolute` message on stderr and `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/server-modules.test.ts
git commit -m "fix(cli): exit 0 on --version and --help without starting the server"
```

---

### Task 4: Documentation

Parallel-safe with Task 3 — different files, no shared state.

**Files:**

- Create: `docs/architecture/cli-startup.md`
- Modify: `docs/architecture/README.md` (concept list), `docs/guide/configuration.md:5-9` (CLI argument table)

**Interfaces:**

- Consumes: the final shape of `ParsedCli` and `packageMeta` from Tasks 1-2. Write this task *after* those land so the doc describes shipped code.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the architecture doc**

Create `docs/architecture/cli-startup.md`, following the house shape used by the other files in that directory — `## What it is`, `## Why it exists`, `## How it interacts`, `## Boundaries`. It must cover:

- The entry-point flow: `cli.ts` → `parseConfig(argv)` → `startNeuroVaultServer(config, deps)`.
- Why `.exitProcess(false)` is correct (argument parsing is a library concern and must not kill its caller) and what it obliges the caller to do (act on the parser's signal).
- The `ParsedCli` union, and the point that `handled` exists so an early exit is representable rather than falling through into vault validation.
- `src/package-meta.ts` as the single manifest reader, and the `src/`-vs-`dist/` depth constraint spelled out in Task 1.
- Boundaries: this file owns flag handling and startup termination only. Once the transport connects, `mcp-server-shape.md` takes over.

- [ ] **Step 2: Link it from the architecture index**

Add a bullet to the `## Concepts` list in `docs/architecture/README.md`, matching the existing "path — one-line description of what it owns" style:

```markdown
- [cli-startup.md](./cli-startup.md) — the command-line entry point: informational flags (`--version`, `--help`), why parsing never exits the process itself, and the single `package.json` read behind the version string and the MCP server identity
```

- [ ] **Step 3: Add `--version` to the CLI argument table**

In `docs/guide/configuration.md`, add a row after the `--help` row. Keep the existing column alignment:

```markdown
| `--version`      | no       | —          | Print the installed version and exit                                                                                                                                    |
```

- [ ] **Step 4: Sweep for any other flag listing**

Do not trust the inventory above — confirm it:

```bash
grep -rn -- "--semantic\|--no-semantic\|--help" README.md docs/
```

Every hit that reads as a *listing* of available flags (rather than a command example) needs the `--version` row too. Flag listings live in more places than architecture-scoped greps suggest, so this sweep covers all of `docs/`, including `docs/guide/`.

- [ ] **Step 5: Verify formatting**

```bash
npm run format
```

Expected: pass. If prettier reports the new table row, run `npm run format:write` and re-check.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/cli-startup.md docs/architecture/README.md docs/guide/configuration.md
git commit -m "docs: describe CLI startup and document --version"
```

---

### Task 5: Verification gate

Runs last, after every other task. Step 2 is the important one: it is the only check that can catch a wrong `package-meta.ts` path depth, because that failure mode passes every source-level test.

**Files:** none modified — this task only runs checks.

**Interfaces:**

- Consumes: the complete implementation from Tasks 1-4.
- Produces: evidence for `verify.md`.

- [ ] **Step 1: Run the three required gates**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all three pass. `npm run typecheck` is authoritative — do not substitute a successful `npm run build` for it.

- [ ] **Step 2: Verify against the build output, not just the source**

```bash
npm run build && node dist/cli.js --version; echo "exit=$?"
```

Expected: the exact version from `package.json` (for example `15.4.0`) on stdout, and `exit=0`. **If this prints a module-resolution error while `npm test` passed, `src/package-meta.ts` is at the wrong depth** — it must be `src/package-meta.ts`, not `src/lib/package-meta.ts`. See Task 1.

- [ ] **Step 3: Verify `--help` on the build output**

```bash
node dist/cli.js --help; echo "exit=$?"
```

Expected: help text, `exit=0`, and **no** trailing `--vault is required` line. Before this change the same command printed that error and exited 1.

- [ ] **Step 4: Confirm a real invocation still starts the server**

```bash
node dist/cli.js --vault "$(pwd)" --no-semantic &
sleep 2 && kill %1
```

Expected: the process stays alive waiting on stdio rather than exiting immediately — the short-circuit did not swallow the normal path. (Any absolute path to a directory whose basename matches `/^[a-zA-Z0-9_-]{1,64}$/` works here.)

- [ ] **Step 5: Format and validate the change**

```bash
npm run format && npx openspec validate cli-version-flag
```

Expected: prettier passes and the change reports valid.

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --title "feat(cli): add --version and fix --help fall-through" --body "Closes #92"
```

Never push directly to `main`. `Closes #92` belongs here because this is the change's only planned PR.
