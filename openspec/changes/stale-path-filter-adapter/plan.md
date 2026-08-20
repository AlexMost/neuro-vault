# Stale-Path Filter Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace three private copies of the Smart Connections stale-path existence check with one `filterExisting` adapter on `IVaultEntry`.

**Architecture:** A factory in `src/lib/obsidian/existing-paths.ts` produces a per-vault `(paths) => Promise<Set<string>>` closure bound to that vault's root. `VaultRegistry.create` builds one per entry from `IVaultEntryDeps.existingPathFilterFactory`, exactly as it already does for `readConventions` / `conventionsReaderFactory`. The three semantic tool handlers call `entry.filterExisting` at the same seam their private copies occupied, so existence checking stays at the handler layer and the retrieval policy layer stays free of disk I/O.

**Tech Stack:** TypeScript (strict, ESM, `node:fs/promises`), vitest, Node ≥ 20. No new dependencies.

## Global Constraints

- `npm test`, `npm run lint`, and `npx tsc --noEmit` must all pass before any commit. `tsc --noEmit` is authoritative — a `tsup` build alone is not (ADR-0002).
- No MCP contract may move: no tool description, parameter name, response field, or error code changes in this diff. This is a pure internal refactor.
- Test count must not silently drop against the pre-change baseline (baseline spec, "Test count must not silently drop").
- Conventional Commits for every commit message.
- Do not amend any file under `docs/adr/` — ADRs are immutable (ADR-0008). Living prose goes in `docs/architecture/`.
- Prefer dependency injection over module-level mocks in tests.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/obsidian/existing-paths.ts` *(new)* | The only implementation of "which of these vault-relative paths exist on disk". Mirrors `vault-conventions.ts`: a small module with an injectable filesystem primitive, not exported through the `index.ts` barrel (neither is `vault-conventions.ts`). |
| `src/lib/vault-registry.ts` *(modify)* | Declares `IVaultEntry.filterExisting` and `IVaultEntryDeps.existingPathFilterFactory`; assembles one filter per entry. |
| `src/server.ts` *(modify)* | Supplies the real factory in `buildDefaultVaultEntryDeps`. |
| `src/modules/semantic/tools/{search-notes,find-duplicates,get-similar-notes}.ts` *(modify)* | Drop their private copies; call `entry.filterExisting`. |
| `src/modules/semantic/tool-helpers.ts` *(modify)* | Loses `pathExistsForEntry`; keeps `readNoteContentForEntry`. |
| `test/lib/obsidian/existing-paths.test.ts` *(new)* | The adapter's contract, asserted once. |
| `test/operations/tools/_test-registry.ts` *(modify)* | Disk-backed `filterExisting` default so every existing temp-vault rig keeps working. |

---

## Task 1: The existence-filter adapter

**Files:**
- Create: `src/lib/obsidian/existing-paths.ts`
- Test: `test/lib/obsidian/existing-paths.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createExistingPathFilter(opts: { vaultRoot: string; access?: PathAccess }): (paths: Iterable<string>) => Promise<Set<string>>` and `type PathAccess = (p: string) => Promise<void>`. Task 2 imports both.

- [x] **Step 1: Write the failing test**

Create `test/lib/obsidian/existing-paths.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createExistingPathFilter } from '../../../src/lib/obsidian/existing-paths.js';

async function makeVault(paths: string[]): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'existing-paths-'));
  for (const rel of paths) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '', 'utf8');
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe('createExistingPathFilter', () => {
  it('reports only the paths that exist on disk', async () => {
    const { root, cleanup } = await makeVault(['Folder/a.md', 'Folder/b.md']);
    try {
      const filter = createExistingPathFilter({ vaultRoot: root });
      const survivors = await filter(['Folder/a.md', 'Folder/gone.md', 'Folder/b.md']);
      expect([...survivors].sort()).toEqual(['Folder/a.md', 'Folder/b.md']);
    } finally {
      await cleanup();
    }
  });

  it('checks a repeated path once and reports it once', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/v', access });
    const survivors = await filter(['a.md', 'a.md', 'a.md']);
    expect(access).toHaveBeenCalledTimes(1);
    expect([...survivors]).toEqual(['a.md']);
  });

  it('resolves a missing path as absent instead of raising', async () => {
    const { root, cleanup } = await makeVault(['keep.md']);
    try {
      const filter = createExistingPathFilter({ vaultRoot: root });
      await expect(filter(['keep.md', 'gone.md'])).resolves.toEqual(new Set(['keep.md']));
    } finally {
      await cleanup();
    }
  });

  it('returns an empty set for empty input without touching the filesystem', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/v', access });
    expect(await filter([])).toEqual(new Set());
    expect(access).not.toHaveBeenCalled();
  });

  it('joins each path against its own vault root', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const filter = createExistingPathFilter({ vaultRoot: '/vaults/alpha', access });
    await filter(['Folder/note.md']);
    expect(access).toHaveBeenCalledWith(path.join('/vaults/alpha', 'Folder/note.md'));
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/lib/obsidian/existing-paths.test.ts
```

Expected: FAIL — `Failed to resolve import ".../existing-paths.js"`.

- [x] **Step 3: Write the implementation**

Create `src/lib/obsidian/existing-paths.ts`:

```ts
import { access as fsAccess } from 'node:fs/promises';
import path from 'node:path';

/** Injectable existence primitive: resolves if the path is reachable, rejects otherwise. */
export type PathAccess = (absolutePath: string) => Promise<void>;

/**
 * Build this vault's stale-path filter.
 *
 * The Smart Connections corpus is read-only and unwatched (ADR-0006), so it
 * can still name a note that was deleted since the plugin last wrote its
 * index. Every consumer of corpus-derived paths must therefore check disk
 * before answering. That check lives here and nowhere else: the returned
 * closure is bound to one vault root and exposed as `IVaultEntry.filterExisting`.
 *
 * Returns the subset of `paths` that exist. Input is de-duplicated, each path
 * is checked independently, and an unreachable path is reported as absent
 * rather than raising — a missing file is the expected case, not an error.
 */
export function createExistingPathFilter(opts: {
  vaultRoot: string;
  access?: PathAccess;
}): (paths: Iterable<string>) => Promise<Set<string>> {
  const access = opts.access ?? ((absolutePath: string) => fsAccess(absolutePath));
  return async (paths) => {
    const unique = new Set(paths);
    if (unique.size === 0) return new Set();
    const checks = await Promise.all(
      [...unique].map(async (notePath) => {
        try {
          await access(path.join(opts.vaultRoot, notePath));
          return notePath;
        } catch {
          return undefined;
        }
      }),
    );
    return new Set(checks.filter((p): p is string => p !== undefined));
  };
}
```

- [x] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/lib/obsidian/existing-paths.test.ts
```

Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/obsidian/existing-paths.ts test/lib/obsidian/existing-paths.test.ts
git commit -m "feat(obsidian): add per-vault existing-path filter"
```

---

## Task 2: Registry and server wiring

**Files:**
- Modify: `src/lib/vault-registry.ts`
- Modify: `src/server.ts:78-93` (`buildDefaultVaultEntryDeps`)
- Test: `test/lib/vault-registry.test.ts`

**Interfaces:**
- Consumes: `createExistingPathFilter` from Task 1.
- Produces: `IVaultEntry.filterExisting: FilterExistingPaths` and `IVaultEntryDeps.existingPathFilterFactory: (opts: { vaultRoot: string }) => FilterExistingPaths`, where `export type FilterExistingPaths = (paths: Iterable<string>) => Promise<Set<string>>` is exported from `src/lib/vault-registry.ts`. Tasks 3–6 call `entry.filterExisting(paths)`.

- [x] **Step 1: Write the failing test**

Append to the final `describe` block in `test/lib/vault-registry.test.ts`:

```ts
  it('binds one existing-path filter per vault root', async () => {
    const seen: string[] = [];
    const registry = await VaultRegistry.create(
      {
        vaults: [
          { name: 'a', path: '/vaults/a', smartEnvPath: '/vaults/a/.smart-env/multi' },
          { name: 'b', path: '/vaults/b', smartEnvPath: '/vaults/b/.smart-env/multi' },
        ],
        semanticEnabled: false,
        modelKey: 'm',
      },
      {
        ...fakeDeps(),
        existingPathFilterFactory:
          ({ vaultRoot }) =>
          async (paths) => {
            seen.push(vaultRoot);
            // Only vault "a" holds the note.
            return vaultRoot === '/vaults/a' ? new Set(paths) : new Set<string>();
          },
      },
    );

    expect(await registry.require('a').filterExisting(['n.md'])).toEqual(new Set(['n.md']));
    expect(await registry.require('b').filterExisting(['n.md'])).toEqual(new Set());
    expect(seen).toEqual(['/vaults/a', '/vaults/b']);
  });
```

Also add `existingPathFilterFactory: () => async (paths) => new Set(paths)` to the object returned by `fakeDeps()`.

- [x] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/lib/vault-registry.test.ts
```

Expected: FAIL — `existingPathFilterFactory` is not a known property of `IVaultEntryDeps`, and `filterExisting` is not on `IVaultEntry`.

- [x] **Step 3: Declare the capability on the entry**

In `src/lib/vault-registry.ts`, add the exported type above `IVaultEntry`:

```ts
/** Filter vault-relative note paths down to those present on disk. */
export type FilterExistingPaths = (paths: Iterable<string>) => Promise<Set<string>>;
```

Add the field to `IVaultEntry`, immediately after `readConventions`:

```ts
  /**
   * Filter vault-relative note paths down to those still present on this
   * vault's disk. The Smart Connections corpus is read-only and unwatched
   * (ADR-0006), so it can name notes deleted since the plugin last indexed;
   * every tool returning corpus-derived paths runs them through here first.
   * One implementation, so no consumer can disagree about what "exists" means
   * or forget the check entirely.
   */
  filterExisting: FilterExistingPaths;
```

Add the factory to `IVaultEntryDeps`, after `conventionsReaderFactory`:

```ts
  existingPathFilterFactory: (opts: { vaultRoot: string }) => FilterExistingPaths;
```

- [x] **Step 4: Assemble it in `VaultRegistry.create`**

Next to the existing `readConventions` line:

```ts
      const readConventions = deps.conventionsReaderFactory({ vaultRoot: v.path });
      const filterExisting = deps.existingPathFilterFactory({ vaultRoot: v.path });
```

and add `filterExisting,` to the `entries.push({ … })` literal, directly after `readConventions,`.

- [x] **Step 5: Wire the real factory in `src/server.ts`**

Import the adapter alongside the existing obsidian-lib imports:

```ts
import { createExistingPathFilter } from './lib/obsidian/existing-paths.js';
```

and add to the object returned by `buildDefaultVaultEntryDeps`, after `conventionsReaderFactory`:

```ts
    existingPathFilterFactory: ({ vaultRoot }) => createExistingPathFilter({ vaultRoot }),
```

- [x] **Step 6: Run the tests and the typechecker**

```bash
npx vitest run test/lib/vault-registry.test.ts && npx tsc --noEmit
```

Expected: the registry tests PASS. `tsc` will now report errors in `test/operations/tools/_test-registry.ts` only if that file constructs entries without a cast — check the output. It currently casts `Partial<IVaultEntry>` with `as IVaultEntry`, so expect zero errors; if any other site constructs a bare `IVaultEntry` literal, fix it here before moving on.

- [x] **Step 7: Commit**

```bash
git add src/lib/vault-registry.ts src/server.ts test/lib/vault-registry.test.ts
git commit -m "feat(registry): expose filterExisting as a per-vault capability"
```

---

## Task 3: Test-rig default

**Files:**
- Modify: `test/operations/tools/_test-registry.ts`

**Interfaces:**
- Consumes: `createExistingPathFilter` (Task 1), `IVaultEntry.filterExisting` (Task 2).
- Produces: `makeTestRegistry(entries: Partial<IVaultEntry>[])` now yields entries whose `filterExisting` checks the real filesystem under `entry.path` unless the caller supplies its own. Tasks 4–6 rely on this to keep their existing temp-vault fixtures working untouched.

This task deliberately changes no behaviour. Its whole deliverable is "the suite is still green after Task 2 made `filterExisting` required".

- [x] **Step 1: Add the default**

In `test/operations/tools/_test-registry.ts`, import the adapter:

```ts
import { createExistingPathFilter } from '../../../src/lib/obsidian/existing-paths.js';
```

and build the default per entry inside the `map`, so it binds to that entry's own path:

```ts
export function makeTestRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map(
    (e) =>
      ({
        semanticAvailable: true,
        reader: emptyReader,
        readConventions: noConventions,
        // Most rigs provision a real temp vault and expect real staleness
        // semantics, so the default is the production filter bound to this
        // entry's root. A suite that wants specific paths to count as missing
        // passes its own `filterExisting` instead — no temp files needed.
        filterExisting: createExistingPathFilter({ vaultRoot: e.path ?? '' }),
        ...e,
      }) as IVaultEntry,
  );
```

- [x] **Step 2: Run the full suite**

```bash
npm test
```

Expected: PASS, with the same test count as before Task 1 plus the 6 tests added in Tasks 1–2. No test file other than the two already touched should need an edit. If a suite fails here, it is constructing entries outside `makeTestRegistry` — give that rig an explicit `filterExisting` rather than weakening the default.

- [x] **Step 3: Commit**

```bash
git add test/operations/tools/_test-registry.ts
git commit -m "test(registry): default filterExisting to the real disk filter"
```

---

## Task 4: Move `find_duplicates` to the adapter

**Files:**
- Modify: `src/modules/semantic/tools/find-duplicates.ts:6` (import), `:31-41` (the private copy), `:71-74` (the call)
- Test: `test/semantic/tools/find-duplicates.test.ts` (must pass unchanged)

**Interfaces:**
- Consumes: `entry.filterExisting` (Task 2), the rig default (Task 3).
- Produces: nothing later tasks depend on.

Smallest of the three call sites and character-identical to the `search-notes` copy — do it first to validate the seam.

- [x] **Step 1: Confirm the existing staleness test passes before the edit**

```bash
npx vitest run test/semantic/tools/find-duplicates.test.ts
```

Expected: PASS. This is the regression guard for the edit — record that it is green *before* touching the file.

- [x] **Step 2: Delete the private copy and call the adapter**

Remove the whole `async function buildExistingPathSet(…)` block (lines 31–41) and the now-unused import. The import line

```ts
import { pathExistsForEntry } from '../tool-helpers.js';
```

is deleted entirely; the separate `import { readThreshold } from '../tool-helpers.js';` line below it stays. The `IVaultEntry` type import is also now unused — check and remove it if so.

Replace the call:

```ts
        const existing = await entry.filterExisting(pairs.flatMap((p) => [p.note_a, p.note_b]));
```

- [x] **Step 3: Run the test and the typechecker**

```bash
npx vitest run test/semantic/tools/find-duplicates.test.ts && npx tsc --noEmit
```

Expected: PASS, no type errors, and the test file itself is unmodified in `git status`.

- [x] **Step 4: Commit**

```bash
git add src/modules/semantic/tools/find-duplicates.ts
git commit -m "refactor(semantic): find_duplicates uses entry.filterExisting"
```

---

## Task 5: Move `search_notes` to the adapter

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts:12` (import), `:104-114` (the private copy), `:452` (the call)
- Test: `test/semantic/tools/search-notes.test.ts`, `search-notes-hybrid.test.ts`, `search-notes-filter.test.ts`, `search-notes-e2e.test.ts` (all must pass unchanged)

**Interfaces:**
- Consumes: `entry.filterExisting` (Task 2), the rig default (Task 3).
- Produces: nothing later tasks depend on.

- [x] **Step 1: Confirm the search suites pass before the edit**

```bash
npx vitest run test/semantic/tools/
```

Expected: PASS (Task 4 already landed).

- [x] **Step 2: Delete the private copy and call the adapter**

Remove the `async function buildExistingPathSet(…)` block at lines 104–114, and drop `pathExistsForEntry` from the `../tool-helpers.js` import list at line 12 — keep every other name on that import.

At line 452, replace:

```ts
    const existing = await buildExistingPathSet(entry, candidatePaths);
```

with:

```ts
    const existing = await entry.filterExisting(candidatePaths);
```

Leave the block comment above `const rawExpansion = …` exactly as it is — it explains why `assembleUnified` recomputes `flattenExpansion` from the filtered seeds, which this change does not alter.

- [x] **Step 3: Run the suites and the typechecker**

```bash
npx vitest run test/semantic/ && npx tsc --noEmit
```

Expected: PASS, no type errors, and no test file modified in `git status`.

- [x] **Step 4: Commit**

```bash
git add src/modules/semantic/tools/search-notes.ts
git commit -m "refactor(semantic): search_notes uses entry.filterExisting"
```

---

## Task 6: Split exclusion from existence in `get_similar_notes`

**Files:**
- Modify: `src/modules/semantic/tools/get-similar-notes.ts:9-13` (import), `:126-142` (`filterCandidates`)
- Test: `test/semantic/tools/get-similar-notes.test.ts`

**Interfaces:**
- Consumes: `entry.filterExisting` (Task 2), the rig default (Task 3).
- Produces: nothing later tasks depend on.

The one non-mechanical edit — its copy is interleaved with `exclude_folders` filtering. Exclusion stays local and runs first (design D4).

- [x] **Step 1: Confirm the existing staleness test passes before the edit**

```bash
npx vitest run test/semantic/tools/get-similar-notes.test.ts -t "respects pathExists filter on linked targets too"
```

Expected: PASS. This is the regression guard.

- [x] **Step 2: Write the failing test for the combined case**

Add to `test/semantic/tools/get-similar-notes.test.ts`, next to the existing existence test (spec Requirement 4, second scenario):

```ts
  it('drops a candidate that is both excluded and missing, without raising', async () => {
    const { tool, cleanup } = await buildToolWithVault({
      absentPaths: ['Folder/B.md'],
    });
    try {
      const results = await tool.handler({
        path: 'Folder/A.md',
        threshold: 0,
        exclude_folders: ['Folder/B.md'],
      });
      expect(results.map((r) => r.path)).not.toContain('Folder/B.md');
      expect(results.map((r) => r.path)).toContain('Folder/C.md');
    } finally {
      await cleanup();
    }
  });
```

- [x] **Step 3: Run it**

```bash
npx vitest run test/semantic/tools/get-similar-notes.test.ts
```

Expected: PASS already — the current interleaved implementation also handles this. That is fine and intended: this test exists to pin the behaviour *across* the refactor, so it must be green before and after. If it fails now, stop and investigate before changing any source.

- [x] **Step 4: Split the function**

Replace `filterCandidates` (lines 126–142) with:

```ts
async function filterCandidates(args: {
  candidates: Iterable<Candidate>;
  excludePrefixes: readonly string[];
  entry: IVaultEntry;
}): Promise<Candidate[]> {
  // Two unrelated filters: `exclude_folders` is a caller preference, staleness
  // is a corpus invariant. Exclusion runs first so the disk check only sees
  // candidates that could still be returned.
  const afterExclude = [...args.candidates].filter(
    (c) => !isExcluded(c.path, args.excludePrefixes),
  );
  const existing = await args.entry.filterExisting(afterExclude.map((c) => c.path));
  return afterExclude.filter((c) => existing.has(c.path));
}
```

Then drop `pathExistsForEntry` from the `../tool-helpers.js` import list at lines 9–13, keeping `readNoteContentForEntry`, `readPositiveInteger`, and `readThreshold`.

- [x] **Step 5: Run the suite and the typechecker**

```bash
npx vitest run test/semantic/tools/get-similar-notes.test.ts && npx tsc --noEmit
```

Expected: PASS, including both the pre-existing `respects pathExists filter on linked targets too` and the new combined-case test.

- [x] **Step 6: Commit**

```bash
git add src/modules/semantic/tools/get-similar-notes.ts test/semantic/tools/get-similar-notes.test.ts
git commit -m "refactor(semantic): get_similar_notes uses entry.filterExisting"
```

---

## Task 7: Close the seam

**Files:**
- Modify: `src/modules/semantic/tool-helpers.ts:1-17`
- Test: `test/semantic/tools/find-duplicates.test.ts` (the injectable-filter test)

**Interfaces:**
- Consumes: Tasks 4–6 complete (no callers of `pathExistsForEntry` remain).
- Produces: nothing.

- [x] **Step 1: Delete `pathExistsForEntry`**

Remove the `pathExistsForEntry` function from `src/modules/semantic/tool-helpers.ts`. Keep `readNoteContentForEntry` — `get_similar_notes` still calls it for forward-link resolution. If `fs`/`path` imports are now unused by the remaining code, remove them too; if `readNoteContentForEntry` still needs them, leave them.

- [x] **Step 2: Prove no caller remains**

```bash
npx tsc --noEmit && grep -rn "pathExistsForEntry" src test
```

Expected: `tsc` clean; `grep` matches only comments in test files (`_helpers.ts:100`, `search-notes.test.ts:764,772`, `find-duplicates.test.ts:29,55`). Update those comments to name `entry.filterExisting` instead — a stale comment naming a deleted function is the seed of the next private copy.

- [x] **Step 3: Write the injectable-filter test**

Spec Requirement 2, second scenario — proves the adapter is substitutable without touching disk. Add to `test/semantic/tools/find-duplicates.test.ts`:

```ts
  it('honours a substituted existence filter with no files on disk', async () => {
    const corpus = makeFakeCorpusIndex(
      new Map([
        ['Folder/note-d.md', { path: 'Folder/note-d.md', embedding: [1, 0, 0], blocks: [] }],
        ['Folder/note-e.md', { path: 'Folder/note-e.md', embedding: [1, 0, 0], blocks: [] }],
      ]),
    );
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: '/nonexistent',
        smartEnvPath: '/nonexistent/.smart-env',
        corpus,
        semanticAvailable: true,
        // Everything the corpus names is declared present — no temp dir.
        filterExisting: async (paths) => new Set(paths),
      },
    ]);
    const tool = buildFindDuplicatesTool({
      registry,
      searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
      modelKey: MODEL_KEY,
    });

    const results = await tool.handler({ threshold: 0.95 });

    expect(results.map((r) => [r.note_a, r.note_b])).toEqual([
      ['Folder/note-d.md', 'Folder/note-e.md'],
    ]);
  });
```

- [x] **Step 4: Run it**

```bash
npx vitest run test/semantic/tools/find-duplicates.test.ts
```

Expected: PASS. If the pair ordering differs from the assertion, read the actual output and fix the expectation to match `findDuplicates`' own ordering — do not change the tool to satisfy the test.

- [x] **Step 5: Confirm exactly one implementation remains**

```bash
grep -rn "buildExistingPathSet\|fs.access\|pathExists" src
```

Expected: the only existence-filtering match is inside `src/lib/obsidian/existing-paths.ts`. Any other match is either unrelated (a different concern reading files) or a fourth copy that must be removed now.

- [x] **Step 6: Commit**

```bash
git add src/modules/semantic/tool-helpers.ts test/semantic/
git commit -m "refactor(semantic): drop pathExistsForEntry, the adapter owns existence"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/architecture/smart-connections-corpus.md`
- Modify: `docs/architecture/vault-registry.md`
- Sweep: all of `docs/`, including `docs/guide/`

**Interfaces:**
- Consumes: the shipped implementation from Tasks 1–7.
- Produces: nothing.

- [x] **Step 1: State the obligation and name its owner**

In `docs/architecture/smart-connections-corpus.md`, near the existing note that the loader does not watch for changes, add a short subsection saying: the corpus can name notes deleted since the plugin last wrote its index, so every tool returning corpus-derived paths filters them through `IVaultEntry.filterExisting` (`src/lib/obsidian/existing-paths.ts`) at the handler seam; the corpus itself is not made staleness-aware, and the retrieval policy layer stays free of disk I/O. Name the three current consumers. Do not present this as a clause of ADR-0006 — it is a consequence of the read-only, unwatched decision recorded there.

- [x] **Step 2: Document the per-entry capability**

In `docs/architecture/vault-registry.md`, add `filterExisting` / `existingPathFilterFactory` wherever `readConventions` / `conventionsReaderFactory` is described, with one line on why it is a per-entry capability (bound to one vault root, substitutable in tests) and a cross-link to `smart-connections-corpus.md` for the why.

- [x] **Step 3: Sweep the rest of `docs/`**

```bash
grep -rn "pathExists\|buildExistingPathSet\|exists on disk\|existence check" docs/ --exclude-dir=superpowers
```

Fix any prose that describes existence checking as per-tool behaviour. `docs/superpowers/` is the frozen pre-OpenSpec record — do not edit it. Include `docs/guide/` in the sweep: architecture-scoped greps miss the model-facing layer.

- [x] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: record the staleness obligation and its single owner"
```

---

## Task 9: Gates and PR

**Files:** none modified beyond what earlier tasks touched.

- [x] **Step 1: Run every gate**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all three PASS.

- [x] **Step 2: Check the test count did not drop**

Compare the vitest total against the count on `main` before this branch. It must be higher by the tests added in Tasks 1, 2, 6, and 7 — never lower. If any suite lost tests, find out which and restore them.

- [x] **Step 3: Confirm no MCP contract moved**

```bash
git diff main --stat && git diff main -- src/modules/semantic/tools/ | grep -E "^[-+].*(description|inputSchema|ToolHandlerError\(')" 
```

Expected: no added/removed line touches a tool description string, an input schema field, or an error code. Only import lines, the deleted private functions, and the call sites should appear.

- [x] **Step 4: Open the PR**

```bash
git push -u origin HEAD
```

Then `gh pr create` targeting `main`, with the proposal's Why as the body's opening. Never push directly to `main`; release happens on `main` after merge.
