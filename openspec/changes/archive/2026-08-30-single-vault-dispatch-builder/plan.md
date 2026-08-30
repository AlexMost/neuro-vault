# single-vault-dispatch-builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One exported `buildSingleVaultTool` owns the explicit-vault dispatch contract (vault param, suffix-last description, resolver call) for all nine single-vault tools, with the invariants CI-enforced.

**Architecture:** Mirror `buildMultiVaultTool` for the explicit-vault class: a discriminated spec union (`semantic: true` routes through `resolveSemanticVault` and types `entry.backend` as present). Both builders then place the dispatch block as its own final paragraph, killing the separator heuristic; an ESLint boundary keeps tool modules from re-importing the helpers.

**Tech Stack:** TypeScript (ESM, strict), zod, vitest, ESLint flat config.

**Spec:** `openspec/changes/single-vault-dispatch-builder/` — `design.md` (decisions D1–D6), `specs/multi-vault-dispatch/spec.md` (delta), `proposal.md`. Tracked by GitHub issue #111.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` green at every commit; run the gate commands **verbatim** (no path-scoped subsets).
- No tool-contract change: parameter names (ADR-0005), dispatch prose **wording**, error codes (ADR-0003) stay byte-identical; only joining whitespace may change.
- Tool behaviour tests go through the registration gate: `registerTool(buildXTool(deps))` + `callTool`/`expectToolError` from `test/_gate.ts` (ADR-0015). Never call `.handler` directly in new tests.
- Every commit ends with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One PR, branch → `gh pr create` to `main` with `Closes #111`. Never push to `main`, never local-merge, never release.
- Work in a worktree (superpowers:using-git-worktrees); trust `npx tsc --noEmit` over IDE diagnostics there.

---

### Task 1: `buildSingleVaultTool` + gate-routed builder tests

**Files:**
- Create: `src/lib/single-vault-tool.ts`
- Test: `test/lib/single-vault-tool.test.ts`

**Interfaces:**
- Consumes: `resolveVault`/`resolveSemanticVault` (`src/lib/resolve-vault.ts`), `vaultParamShape`/`describeMultiVault`/`EXPLICIT_VAULT_SUFFIX` (`src/lib/vault-param.ts`), `ITool` (`src/lib/tool-registry.ts`).
- Produces: `buildSingleVaultTool<TInput, TOutput>(registry, spec)` and the spec types below — Tasks 2–3 migrate the nine tools onto exactly these.

- [x] **Step 1: Write the failing test**

`test/lib/single-vault-tool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildSingleVaultTool } from '../../src/lib/single-vault-tool.js';
import type { SemanticBackend } from '../../src/lib/obsidian/semantic-backend.js';
import { registerTool } from '../../src/lib/tool-registry.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { EXPLICIT_VAULT_SUFFIX } from '../../src/lib/vault-param.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';
import { callTool, expectToolError } from '../_gate.js';

interface FakeEntrySpec {
  name: string;
  backend?: SemanticBackend;
}

function registryOf(...specs: Array<string | FakeEntrySpec>): IVaultRegistry {
  const list = specs.map((s) => {
    const { name, backend } = typeof s === 'string' ? { name: s, backend: undefined } : s;
    return { name, path: `/vaults/${name}`, backend } as unknown as IVaultEntry;
  });
  const byName = new Map(list.map((e) => [e.name, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no vault ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
  };
}

const readyBackend = { status: () => ({ state: 'ready' as const }) } as SemanticBackend;
const indexingBackend = {
  status: () => ({ state: 'indexing' as const, indexed: 1, total: 3 }),
} as SemanticBackend;

interface Input {
  vault?: string;
  n?: number;
}

function regFor(registry: IVaultRegistry) {
  return registerTool(
    buildSingleVaultTool<Input, { vault: string; n: number | null }>(registry, {
      name: 'remove_property',
      title: 'Fake Tool',
      description: 'Domain prose.',
      inputShape: { n: z.number().optional() },
      runForEntry: async (entry, input) => ({ vault: entry.name, n: input.n ?? null }),
    }),
  );
}

describe('buildSingleVaultTool', () => {
  it('refuses an omitted vault in multi-vault mode with VAULT_REQUIRED', async () => {
    const payload = await expectToolError(regFor(registryOf('a', 'b')), {});
    expect(payload.code).toBe('VAULT_REQUIRED');
    expect(payload.details).toMatchObject({
      tool: 'remove_property',
      registered_vaults: ['a', 'b'],
    });
  });

  it('targets the named vault', async () => {
    const out = await callTool(regFor(registryOf('a', 'b')), { vault: 'b', n: 7 });
    expect(out).toEqual({ vault: 'b', n: 7 });
  });

  it('fails the whole call for an unknown vault name', async () => {
    const payload = await expectToolError(regFor(registryOf('a', 'b')), { vault: 'nope' });
    expect(payload.code).toBe('VAULT_NOT_FOUND');
  });

  it('resolves the only vault in single-vault mode without a vault param', async () => {
    const out = await callTool(regFor(registryOf('only')), {});
    expect(out).toEqual({ vault: 'only', n: null });
  });

  it('advertises vault alongside domain params in multi-vault mode only', () => {
    const multiShape = (regFor(registryOf('a', 'b')).spec.inputSchema as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(multiShape).sort()).toEqual(['n', 'vault']);
    const singleShape = (regFor(registryOf('only')).spec.inputSchema as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(singleShape)).toEqual(['n']);
  });

  it('appends the explicit-vault block as the final paragraph, and only in multi-vault mode', () => {
    expect(regFor(registryOf('a', 'b')).spec.description).toBe(
      `Domain prose.\n\nRegistered vaults: "a", "b". ${EXPLICIT_VAULT_SUFFIX}`,
    );
    expect(regFor(registryOf('only')).spec.description).toBe('Domain prose.');
  });

  it('places the block as its own paragraph for a multi-line domain description too', () => {
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registryOf('a', 'b'), {
        name: 'get_note_links',
        title: 'Fake Multi-line',
        description: 'Line one.\nLine two.',
        inputShape: {},
        runForEntry: async (entry) => entry.name,
      }),
    );
    expect(reg.spec.description).toBe(
      `Line one.\nLine two.\n\nRegistered vaults: "a", "b". ${EXPLICIT_VAULT_SUFFIX}`,
    );
  });

  it('semantic: true routes through the readiness gate before the per-vault function', async () => {
    const registry = registryOf({ name: 'a', backend: indexingBackend }, { name: 'b' });
    let ran = false;
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registry, {
        name: 'find_duplicates',
        title: 'Fake Semantic',
        description: 'Domain prose.',
        semantic: true,
        inputShape: {},
        runForEntry: async (entry) => {
          ran = true;
          return entry.backend.status().state;
        },
      }),
    );
    const payload = await expectToolError(reg, { vault: 'a' });
    expect(payload.code).toBe('SEMANTIC_INDEX_BUILDING');
    expect(ran).toBe(false);
  });

  it('semantic: true hands a ready entry with a typed backend to the per-vault function', async () => {
    const registry = registryOf({ name: 'a', backend: readyBackend }, { name: 'b' });
    const reg = registerTool(
      buildSingleVaultTool<Input, string>(registry, {
        name: 'find_duplicates',
        title: 'Fake Semantic',
        description: 'Domain prose.',
        semantic: true,
        inputShape: {},
        runForEntry: async (entry) => entry.backend.status().state,
      }),
    );
    expect(await callTool(reg, { vault: 'a' })).toBe('ready');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/single-vault-tool.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/single-vault-tool.js`.

- [x] **Step 3: Implement the builder**

`src/lib/single-vault-tool.ts`:

```ts
import { z } from 'zod';

import type { SemanticBackend } from './obsidian/semantic-backend.js';
import { resolveSemanticVault, resolveVault } from './resolve-vault.js';
import type { ToolName } from './tool-names.js';
import type { ITool } from './tool-registry.js';
import { describeMultiVault, EXPLICIT_VAULT_SUFFIX, vaultParamShape } from './vault-param.js';
import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

interface ISingleVaultSpecBase {
  name: ToolName;
  title: string;
  /** Domain prose only. The explicit-vault contract is appended by the builder. */
  description: string;
  /**
   * Domain params. `vault` is contributed by the builder, never here — enforced
   * at the type level by excluding a `vault` key (`vault?: never`), so a spec
   * that declares one fails `npm run typecheck` rather than silently
   * overriding, or in single-vault mode single-handedly reintroducing, the
   * builder's own `vault` param.
   */
  inputShape: z.ZodRawShape & { vault?: never };
}

export interface ISingleVaultToolSpec<TInput extends { vault?: string }, TOutput>
  extends ISingleVaultSpecBase {
  semantic?: false;
  runForEntry: (entry: IVaultEntry, input: TInput) => Promise<TOutput>;
}

/**
 * The `semantic: true` variant resolves through `resolveSemanticVault`, which
 * owns the readiness gate (SEMANTIC_INDEX_BUILDING / SEMANTIC_DISABLED /
 * SEMANTIC_INDEX_NOT_FOUND) — so the per-vault function sees a backend that is
 * present and ready, typed as such.
 */
export interface ISemanticVaultToolSpec<TInput extends { vault?: string }, TOutput>
  extends ISingleVaultSpecBase {
  semantic: true;
  runForEntry: (
    entry: IVaultEntry & { backend: SemanticBackend },
    input: TInput,
  ) => Promise<TOutput>;
}

/**
 * The one owner of the explicit-vault dispatch contract — the mirror of
 * `buildMultiVaultTool` for the nine tools that cannot fan out. Each of them
 * previously hand-rolled three pieces: the `vaultParamShape` spread, the
 * `EXPLICIT_VAULT_SUFFIX` concatenation, and a resolver call restating the
 * tool's own name literal. The suffix-goes-last invariant was enforced by
 * nothing and had already broken twice.
 */
export function buildSingleVaultTool<TInput extends { vault?: string }, TOutput>(
  registry: IVaultRegistry,
  spec: ISingleVaultToolSpec<TInput, TOutput> | ISemanticVaultToolSpec<TInput, TOutput>,
): ITool<TInput, TOutput> {
  const block = describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX);
  return {
    name: spec.name,
    title: spec.title,
    description: block === '' ? spec.description : `${spec.description}\n\n${block.trimStart()}`,
    inputSchema: z.object({ ...vaultParamShape(registry), ...spec.inputShape }),
    handler: async (input) =>
      spec.semantic === true
        ? await spec.runForEntry(resolveSemanticVault(input, registry, { tool: spec.name }), input)
        : await spec.runForEntry(resolveVault(input, registry, { tool: spec.name }), input),
  };
}
```

(The `.trimStart()` bridges `describeMultiVault`'s current leading-space return; Task 4 moves that normalization into the helper and deletes the call.)

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/single-vault-tool.test.ts`
Expected: PASS (all 9 tests).

- [x] **Step 5: Full gates, then commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

```bash
git add src/lib/single-vault-tool.ts test/lib/single-vault-tool.test.ts
git commit -m "feat(lib): add buildSingleVaultTool owning the explicit-vault dispatch contract

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Migrate the seven operations tools

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts`, `create-note.ts`, `edit-note.ts`, `read-daily.ts`, `set-property.ts`, `remove-property.ts`, `get-note-links.ts`
- Tests exercised: `test/operations/**` (no new tests; existing ones must stay green)

**Interfaces:**
- Consumes: `buildSingleVaultTool`, `ISingleVaultToolSpec` from Task 1.
- Produces: unchanged exported `buildXTool(deps)` signatures and `ITool` return types — `src/modules/operations/tools/index.ts` needs no edits.

The transformation is identical for all seven (worked example below). Per file:

1. Delete the imports of `resolveVault` and of `describeMultiVault` / `EXPLICIT_VAULT_SUFFIX` / `vaultParamShape`; delete the `z` import only if nothing else in the file uses `z` (every file still does — the `inputShape` values are zod types).
2. Add `import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';` and drop the now-unused `ITool` type import **only if** it is no longer referenced (keep it — every build function's return annotation still uses it).
3. Replace the `return { name, title, description, inputSchema, handler }` object with `return buildSingleVaultTool<Input, <existing output type>>(registry, { name, title, description, inputShape, runForEntry })` where:
   - `inputShape` is the former `z.object({...})` body **minus** the `...vaultParamShape(registry),` line, passed as a bare shape object (not wrapped in `z.object`).
   - `description` is the former description **minus** the `+ describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX)` term — every word kept.
   - `runForEntry: async (entry, input) => { ... }` is the former handler body with the `const entry = resolveVault(...)` line deleted.

- [x] **Step 1: Migrate `remove-property.ts` (worked example)**

The file becomes:

```ts
import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  key: string;
}

export interface RemovePropertyDeps {
  registry: IVaultRegistry;
}

export function buildRemovePropertyTool(
  deps: RemovePropertyDeps,
): ITool<Input, { vault: string; ok: true }> {
  const { registry } = deps;
  return buildSingleVaultTool<Input, { vault: string; ok: true }>(registry, {
    name: 'remove_property',
    title: 'Remove Property',
    description:
      'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed. Returns `{ vault, ok: true }`.',
    inputShape: {
      name: z.string().optional(),
      path: z.string().optional(),
      key: z.string(),
    },
    runForEntry: async (entry, input) => {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await entry.provider.removeProperty({ identifier, name: input.key.trim() });
      return { vault: entry.name, ok: true as const };
    },
  });
}
```

- [x] **Step 2: Migrate `read-notes.ts`, `edit-note.ts`, `read-daily.ts`, `set-property.ts`** — pure applications of the recipe: in each, the `describeMultiVault(...)` term is already the final term of the description, so removing it leaves the domain prose byte-identical.

- [x] **Step 3: Migrate `create-note.ts` (suffix-order fix)** — apply the recipe, plus: the overwrite sentence currently *follows* the `describeMultiVault(...)` term (`create-note.ts:56-57`). Move it before it, dropping its leading space so the domain description's last term becomes:

```ts
      'Templates are not handled by this tool — render any template yourself (Obsidian Core Templates, Templater, or anything else) and pass the result as `content`. ' +
      'If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
```

Every word unchanged; only its position (and the space-vs-nothing join) moves.

- [x] **Step 4: Migrate `get-note-links.ts` (composition fix)** — apply the recipe, plus: the `DESCRIPTION` array's last element currently concatenates the suffix (`get-note-links.ts:39-41`). The last element becomes just its domain sentence:

```ts
    'Use `search_notes` / `query_notes` to find a starting note, then call `get_note_links` to traverse the graph around it.',
```

and the joined string is passed as `description`.

- [x] **Step 5: Run gates and inspect for collateral**

Run: `npm test && npm run lint && npm run typecheck`
Expected: green. If a description assertion fails, it must be an exact-string/ordering test tripped by whitespace or the two deliberate moves — fix the assertion. A failing **regex phrase** assertion (e.g. `test/operations/tools.test.ts` `toMatch(/VAULT_REQUIRED/)`) means dropped words: fix the source file, not the test.

- [x] **Step 6: Commit**

```bash
git add src/modules/operations/tools/ test/
git commit -m "refactor(operations): route the seven single-vault tools through buildSingleVaultTool

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migrate the two semantic tools

**Files:**
- Modify: `src/modules/semantic/tools/get-similar-notes.ts`, `find-duplicates.ts`
- Tests exercised: `test/semantic/**`

**Interfaces:**
- Consumes: `buildSingleVaultTool` with `semantic: true` (`ISemanticVaultToolSpec`) from Task 1.
- Produces: unchanged `buildGetSimilarNotesTool` / `buildFindDuplicatesTool` signatures.

Same recipe as Task 2 with `semantic: true`, deleting the `resolveSemanticVault` import and call; `entry.backend` stays typed with no casts. `find-duplicates.ts` becomes:

```ts
import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair, SearchEngine } from '../types.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';

const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

interface Input {
  vault?: string;
  threshold?: number;
}

type StampedDuplicatePair = DuplicatePair & { vault: string };

export interface FindDuplicatesDeps {
  registry: IVaultRegistry;
  searchEngine: SearchEngine;
  modelKey: string;
}

export function buildFindDuplicatesTool(
  deps: FindDuplicatesDeps,
): ITool<Input, StampedDuplicatePair[]> {
  const { registry, searchEngine, modelKey } = deps;
  return buildSingleVaultTool<Input, StampedDuplicatePair[]>(registry, {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description: 'Identify note pairs with high embedding similarity.',
    semantic: true,
    inputShape: {
      threshold: z.number().min(0).max(1).optional(),
    },
    runForEntry: async (entry, input) => {
      const backend = entry.backend;
      const threshold = readThreshold(input.threshold, DEFAULT_DUPLICATE_THRESHOLD, 'threshold');
      try {
        const { sources } = await backend.snapshot();
        const pairs = searchEngine.findDuplicates({
          sources: sources.values(),
          threshold,
        });
        const existing = await entry.filterExisting(pairs.flatMap((p) => [p.note_a, p.note_b]));
        return pairs
          .filter((p) => existing.has(p.note_a) && existing.has(p.note_b))
          .map((p) => ({ vault: entry.name, ...p }));
      } catch (error) {
        if (error instanceof ToolHandlerError) throw error;
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'Failed to find duplicate notes', {
          details: { modelKey, operation: 'find_duplicates' },
          cause: error,
        });
      }
    },
  });
}
```

- [x] **Step 1: Migrate `find-duplicates.ts`** as above.
- [x] **Step 2: Migrate `get-similar-notes.ts`** — same recipe: `semantic: true`; `runForEntry: async (entry, input) => { ... }` is the former handler body minus the `resolveSemanticVault` call (the `const backend = entry.backend;` line stays); `inputShape` is the former shape minus the `vaultParamShape` spread; description loses only the `describeMultiVault` term. The file's helper functions above the builder are untouched.
- [x] **Step 3: Run gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: green (same collateral rule as Task 2 Step 5).

- [x] **Step 4: Commit**

```bash
git add src/modules/semantic/tools/ test/
git commit -m "refactor(semantic): route get_similar_notes and find_duplicates through the builder

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Uniform paragraph placement; delete the separator heuristic

**Files:**
- Modify: `src/lib/vault-param.ts`, `src/lib/multi-vault-tool.ts`, `src/lib/single-vault-tool.ts`
- Modify: `test/lib/vault-param.test.ts`, `test/lib/multi-vault-tool.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `describeMultiVault(registry, suffix)` now returns the bare block `Registered vaults: …. <suffix>` (no leading space) — its only production callers are the two builders.

This task changes `describeMultiVault`'s return contract and both call sites together (a signature-behaviour change never ships apart from its call sites).

- [x] **Step 1: Update the exact-string expectations first** — in `test/lib/multi-vault-tool.test.ts`: the multi-line separator test keeps its expected string (already `\n\n` at column 0) but its name/comment now describes the uniform rule, and add/adjust a single-paragraph case asserting `Domain prose.\n\nRegistered vaults: "a", "b". ${FAN_OUT_SUFFIX}`. In `test/lib/vault-param.test.ts`: expectations drop the leading space. `test/lib/single-vault-tool.test.ts` from Task 1 already asserts the paragraph form and must not change.
- [x] **Step 2: Run to verify the new expectations fail**

Run: `npx vitest run test/lib/vault-param.test.ts test/lib/multi-vault-tool.test.ts`
Expected: FAIL on the updated assertions only.

- [x] **Step 3: Implement** —
  - `vault-param.ts`: `describeMultiVault` returns `` `Registered vaults: ${names}. ${suffix}` `` (leading space gone); rewrite its doc comment: the builders own placement (own final paragraph), callers no longer concatenate inline.
  - `multi-vault-tool.ts`: delete the `separator` heuristic (`spec.description.includes('\n')` branch and its comment, ~L75-83); compose `description: multiVaultBlock === '' ? spec.description : `${spec.description}\n\n${multiVaultBlock}``.
  - `single-vault-tool.ts`: drop the `.trimStart()`.
- [x] **Step 4: Run gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: green — `test/lib/fan-out-prose.test.ts` and `test/operations/tools.test.ts` use `toContain`/`toMatch` and must pass **untouched**; if one fails, wording regressed — fix source.

- [x] **Step 5: Commit**

```bash
git add src/lib/ test/lib/
git commit -m "refactor(lib): place the dispatch block as its own paragraph, drop the separator heuristic

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ESLint import boundary

**Files:**
- Modify: `eslint.config.js`

**Interfaces:**
- Consumes: the completed migrations (the rule is only satisfiable once no tool module imports the helpers).
- Produces: a CI-enforced boundary; `npm run lint` is the gate.

- [x] **Step 1: Add the override** to `eslint.config.js`, after the base TS block (before the `test/**` block):

```js
  {
    // The explicit-vault and fan-out dispatch contracts have exactly two
    // owners: buildSingleVaultTool and buildMultiVaultTool (src/lib). Tool
    // modules consume the contract through them, never compose it by hand.
    files: ['src/modules/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/lib/vault-param.js', '**/lib/resolve-vault.js'],
              message:
                'Compose vault dispatch through buildSingleVaultTool / buildMultiVaultTool (src/lib), not by hand.',
            },
          ],
        },
      ],
    },
  },
```

- [x] **Step 2: Probe the gate with the verbatim command** — temporarily add `import { resolveVault } from '../../../lib/resolve-vault.js';` to `src/modules/operations/tools/remove-property.ts`, run `npm run lint`, confirm it FAILS with the restriction message, then revert the probe line (`git checkout -- src/modules/operations/tools/remove-property.ts`).
- [x] **Step 3: Run gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: green.

- [x] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore(lint): ban direct vault-param/resolve-vault imports from tool modules

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs sweep + prose-preservation check

**Files:**
- Modify: `docs/architecture/fan-out.md` (and any file the sweep surfaces)
- Scratch (worktree root, untracked, deleted after): `describe-dump.ts`

- [x] **Step 1: Word-wise description diff against main** — prove prose bytes are unchanged. Write `describe-dump.ts` at the worktree root:

```ts
import { buildOperationsTools } from './src/modules/operations/tools/index.js';
import { buildSemanticTools } from './src/modules/semantic/tools/index.js';
import { makeTestRegistry } from './test/operations/tools/_test-registry.js';
import { makeFakeGraph } from './test/semantic/tools/_helpers.js';

const registry = makeTestRegistry(
  ['alpha', 'beta'].map((name) => ({
    name,
    path: `/vaults/${name}`,
    graph: makeFakeGraph(),
    listMatchingPaths: async () => new Set<string>(),
    provider: { listTags: async () => [], listProperties: async () => [] } as never,
  })),
);
const tools = [
  ...buildOperationsTools({ registry }),
  ...buildSemanticTools({
    registry,
    embeddingProvider: { initialize: () => {}, embed: () => {} } as never,
    searchEngine: {
      findNeighbors: () => [],
      findBlockNeighbors: () => [],
      findDuplicates: () => [],
    } as never,
    modelKey: 'bge-micro-v2',
  }),
];
for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`## ${t.name}\n${(t.spec.description ?? '').replace(/\s+/g, ' ').trim()}\n`);
}
```

Run `npx tsx describe-dump.ts > /private/tmp/claude-501/-Users-amostovenko-git-neuro-vault/a364deb0-a39f-4e50-a9f9-1e60a56a5805/scratchpad/after.txt`, then `git stash -u && npx tsx describe-dump.ts > .../before.txt && git stash pop` (the script is untracked; copy it aside first if stash removes it — `cp describe-dump.ts <scratchpad>/ && npx tsx <scratchpad>/describe-dump.ts` does not resolve relative imports, so run it from the worktree root both times).
`diff before.txt after.txt` — Expected: differences ONLY in `create_note` (overwrite sentence repositioned before the vault contract text). Any other word delta is a regression: fix the source. Delete `describe-dump.ts` afterwards.
- [x] **Step 2: Update `docs/architecture/fan-out.md`** — it documents `buildMultiVaultTool` as the (sole) builder and the separator behaviour; describe the two dispatch classes (fan-out vs explicit-vault), `buildSingleVaultTool` ownership, the uniform final-paragraph placement, and the lint-enforced boundary.
- [x] **Step 3: Sweep all of `docs/`** — `grep -rn "vaultParamShape\|describeMultiVault\|resolveVault\|EXPLICIT_VAULT_SUFFIX" docs/` and fix any passage describing the hand-rolled composition (known hits: `docs/adr/0010-context-delivery-channels.md`, `docs/architecture/input-coercion.md` — update only if they state the old mechanism; ADRs are immutable, so an ADR gets no edit unless the hit is a broken cross-reference).
- [x] **Step 4: Full gates one last time**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all green.

- [x] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(architecture): describe the two vault-dispatch builders

Refs #111

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify, retro, archive, PR

- [x] **Step 1:** Run `/opsx:verify` against this change's artifacts; resolve any mismatch.
- [x] **Step 2:** Write `retrospective.md`; archive the change (`/opsx:archive`), which syncs the delta into `openspec/specs/multi-vault-dispatch/spec.md`.
- [x] **Step 3:** Push the branch and open the PR:

```bash
git push -u origin HEAD
gh pr create --title "Add buildSingleVaultTool: one owner for the single-vault dispatch contract" --body "$(cat <<'EOF'
Consolidates the explicit-vault dispatch contract (vault param, suffix-last description, resolver call) into buildSingleVaultTool for all nine single-vault tools; deletes buildMultiVaultTool's separator heuristic; lint-enforces the import boundary; adds builder-level VAULT_REQUIRED coverage through the registration gate.

Change: openspec/changes/single-vault-dispatch-builder (archived on merge path).

Closes #111

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
