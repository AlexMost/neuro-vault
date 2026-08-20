# Multi-Vault Dispatch Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the multi-vault dispatch contract one owner — a `buildMultiVaultTool` builder — so the dispatch branch, the fan-out description prose, and the fan-out generic constraint stop being copy-pasted across five tools.

**Architecture:** `runFanOut` (`src/lib/fan-out.ts`) stays exactly as it is; it is a good seam. A new thin builder in `src/lib/multi-vault-tool.ts` wraps it, owning the `vault === undefined && registry.isMulti()` branch, merging `vaultParamShape` into the input schema, and appending a single shared `FAN_OUT_SUFFIX` through the existing `describeMultiVault` helper. Each of the five tools then supplies only a per-vault function, its domain prose, and a named declaration of which single-vault return shape it follows.

**Tech Stack:** TypeScript (ESM, `strict`, `isolatedModules`), zod v4 input schemas, vitest, `@modelcontextprotocol/sdk`.

## Global Constraints

- Node ≥ 20, ESM only. Every relative import ends in `.js`, including type-only imports.
- `npm test`, `npm run lint`, and `npm run typecheck` must all pass before any commit. `npm run typecheck` (`tsc --noEmit`) is **authoritative** — `isolatedModules` means a successful `tsup` build proves nothing about types.
- MCP wire contract must not change apart from description text. No parameter is added, renamed, or repurposed, so `docs/architecture/mcp-parameter-dictionary.md` is untouched and no major version is owed.
- `skipped_vaults` stays in the `IFanOutResult` response shape. Only its mention in tool **descriptions** is removed.
- Tool assertions go through the SDK gate — assert against `reg.spec.inputSchema` and `reg.spec.description`, not handler-direct, so advertisement bugs are caught.
- Do not edit any file under `docs/adr/`. See design D6.
- Commit messages follow commitlint (conventional commits); CI enforces it.

---

### Task 1: `FAN_OUT_SUFFIX` — the one copy of the fan-out prose

**Files:**
- Modify: `src/lib/vault-param.ts` (append after `EXPLICIT_VAULT_SUFFIX`, currently the last export)
- Test: `test/lib/vault-param.test.ts` (create if absent)

**Interfaces:**
- Consumes: `describeMultiVault(registry, suffix)` and `vaultParamShape(registry)`, both already exported from `src/lib/vault-param.ts`.
- Produces: `export const FAN_OUT_SUFFIX: string` — consumed by Task 2's builder and asserted by Task 9.

- [ ] **Step 1: Write the failing test**

Create or append to `test/lib/vault-param.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { describeMultiVault, FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import type { IVaultRegistry } from '../../src/lib/vault-registry.js';

function registryOf(...names: string[]): IVaultRegistry {
  return {
    get: () => undefined,
    require: () => {
      throw new Error('unused');
    },
    list: () => names.map((name) => ({ name })) as never,
    names: () => names,
    isMulti: () => names.length > 1,
  };
}

describe('FAN_OUT_SUFFIX', () => {
  it('describes results_by_vault and failed_vaults but never skipped_vaults', () => {
    expect(FAN_OUT_SUFFIX).toContain('results_by_vault');
    expect(FAN_OUT_SUFFIX).toContain('failed_vaults');
    expect(FAN_OUT_SUFFIX).not.toContain('skipped_vaults');
  });

  it('is prefixed with the registered vault names in multi-vault mode', () => {
    const text = describeMultiVault(registryOf('alpha', 'beta'), FAN_OUT_SUFFIX);
    expect(text).toContain('Registered vaults: "alpha", "beta".');
    expect(text).toContain(FAN_OUT_SUFFIX);
  });

  it('collapses to an empty string in single-vault mode', () => {
    expect(describeMultiVault(registryOf('only'), FAN_OUT_SUFFIX)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/vault-param.test.ts`
Expected: FAIL — `FAN_OUT_SUFFIX` is not exported from `src/lib/vault-param.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/vault-param.ts`, directly below `EXPLICIT_VAULT_SUFFIX`:

```ts
/**
 * The shared suffix for tools that CAN fan out — the mirror of
 * `EXPLICIT_VAULT_SUFFIX`. Pass it to `describeMultiVault`, which prefixes the
 * registered vault names.
 *
 * It deliberately says nothing about `skipped_vaults`. That field is always
 * `[]` — `runFanOut` hard-codes it and no helper populates it since
 * `runSemanticFanOut` was removed — so describing it would spend the
 * per-`tools/list` description budget on a promise no code path keeps. The
 * field stays in the response shape for contract stability; see
 * `docs/architecture/fan-out.md`.
 *
 * This constant exists so the contract has exactly one copy. Five tool
 * descriptions previously carried three drifted variants of it.
 */
export const FAN_OUT_SUFFIX =
  'Omit `vault:` to fan out across all registered vaults — the response shape switches to ' +
  '`results_by_vault: [...]` with `failed_vaults: [...]` (per-vault runtime errors); one ' +
  'failing vault never aborts the call. Pass `vault: "<name>"` to target a specific vault.';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/vault-param.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/vault-param.ts test/lib/vault-param.test.ts
git commit -m "feat(lib): add FAN_OUT_SUFFIX as the single copy of the fan-out prose"
```

---

### Task 2: `buildMultiVaultTool` — the builder

**Files:**
- Create: `src/lib/multi-vault-tool.ts`
- Test: `test/lib/multi-vault-tool.test.ts` (create)

**Interfaces:**
- Consumes: `FAN_OUT_SUFFIX` (Task 1); `runFanOut` / `IFanOutResult` from `src/lib/fan-out.ts`; `resolveVault` from `src/lib/resolve-vault.ts`; `ITool` from `src/lib/tool-registry.ts`; `ToolName` from `src/lib/tool-names.ts`.
- Produces, all relied on by Tasks 3–7:
  - `buildMultiVaultTool<TInput, TPayload, TSingle>(registry: IVaultRegistry, spec: IMultiVaultToolSpec<TInput, TPayload, TSingle>): ITool<TInput, TSingle | IFanOutResult<TPayload>>`
  - `withVaultName<T>(entry: IVaultEntry, payload: T): { vault: string } & T`
  - `payloadOnly<T>(entry: IVaultEntry, payload: T): T`
  - `IMultiVaultToolSpec` with fields `name`, `title`, `description`, `multiVaultNote?`, `inputShape`, `runForEntry`, `single`.

Note on the generic bound: `TPayload extends Record<string, unknown>` here matches `runFanOut`'s current constraint. Task 10 attempts relaxing both to `object`. Do **not** relax it early — the whole point of Task 10's ordering is that a typecheck failure is unambiguously attributable to that one change.

- [ ] **Step 1: Write the failing test**

Create `test/lib/multi-vault-tool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildMultiVaultTool,
  payloadOnly,
  withVaultName,
} from '../../src/lib/multi-vault-tool.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import type { IVaultEntry, IVaultRegistry } from '../../src/lib/vault-registry.js';

function registryOf(...names: string[]): IVaultRegistry {
  const list = names.map((name) => ({ name, path: `/vaults/${name}` })) as IVaultEntry[];
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

interface Input {
  vault?: string;
  n?: number;
}

type Single = (entry: IVaultEntry, payload: { results: string[] }) => unknown;

function toolFor(registry: IVaultRegistry, single: Single = withVaultName) {
  return buildMultiVaultTool<Input, { results: string[] }, unknown>(registry, {
    name: 'list_tags',
    title: 'List Tags',
    description: 'Domain prose.',
    inputShape: { n: z.number().optional() },
    runForEntry: async (entry) => ({ results: [entry.name] }),
    single,
  });
}

describe('buildMultiVaultTool', () => {
  it('fans out when vault is omitted and the registry holds more than one vault', async () => {
    const out = (await toolFor(registryOf('a', 'b')).handler({})) as {
      results_by_vault: unknown[];
      skipped_vaults: unknown[];
      failed_vaults: unknown[];
    };
    expect(out.results_by_vault).toEqual([
      { vault: 'a', results: ['a'] },
      { vault: 'b', results: ['b'] },
    ]);
    expect(out.skipped_vaults).toEqual([]);
    expect(out.failed_vaults).toEqual([]);
  });

  it('targets one vault when vault is supplied', async () => {
    const out = await toolFor(registryOf('a', 'b')).handler({ vault: 'b' });
    expect(out).toEqual({ vault: 'b', results: ['b'] });
  });

  it('never fans out in single-vault mode', async () => {
    const out = await toolFor(registryOf('only')).handler({});
    expect(out).toEqual({ vault: 'only', results: ['only'] });
  });

  it('fails the whole call for an unknown vault name', async () => {
    await expect(toolFor(registryOf('a', 'b')).handler({ vault: 'nope' })).rejects.toThrow(
      ToolHandlerError,
    );
  });

  it('payloadOnly returns the payload with no added top-level vault key', async () => {
    const out = await toolFor(registryOf('a', 'b'), payloadOnly).handler({ vault: 'a' });
    expect(out).toEqual({ results: ['a'] });
  });

  it('advertises vault in multi-vault mode alongside the domain params', () => {
    const shape = (toolFor(registryOf('a', 'b')).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape).sort()).toEqual(['n', 'vault']);
  });

  it('omits vault from the advertised schema in single-vault mode', () => {
    const shape = (toolFor(registryOf('only')).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape)).toEqual(['n']);
  });

  it('appends the fan-out prose in multi-vault mode only', () => {
    expect(toolFor(registryOf('a', 'b')).description).toContain('results_by_vault');
    expect(toolFor(registryOf('only')).description).toBe('Domain prose.');
  });

  it('appends a domain-specific multiVaultNote after the shared suffix', () => {
    const tool = buildMultiVaultTool<Input, { results: string[] }, unknown>(registryOf('a', 'b'), {
      name: 'search_notes',
      title: 'Search Notes',
      description: 'Domain prose.',
      multiVaultNote: 'Vaults without a semantic index still contribute lexically.',
      inputShape: {},
      runForEntry: async (entry) => ({ results: [entry.name] }),
      single: payloadOnly,
    });
    expect(tool.description.indexOf('results_by_vault')).toBeLessThan(
      tool.description.indexOf('still contribute lexically'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/multi-vault-tool.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/multi-vault-tool.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/multi-vault-tool.ts`:

```ts
import { z } from 'zod';

import { runFanOut, type IFanOutResult } from './fan-out.js';
import { resolveVault } from './resolve-vault.js';
import type { ToolName } from './tool-names.js';
import type { ITool } from './tool-registry.js';
import { describeMultiVault, FAN_OUT_SUFFIX, vaultParamShape } from './vault-param.js';
import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

/**
 * Single-vault shape for a payload that has no vault identity of its own —
 * `list_tags`, `list_properties`, `get_vault_overview`.
 */
export function withVaultName<T extends Record<string, unknown>>(
  entry: IVaultEntry,
  payload: T,
): { vault: string } & T {
  return { vault: entry.name, ...payload };
}

/**
 * Single-vault shape for a payload whose result items each already carry their
 * own `vault` — `query_notes`, `search_notes`. Adding a top-level `vault` here
 * would state the same fact twice at two different granularities.
 */
export function payloadOnly<T extends Record<string, unknown>>(_entry: IVaultEntry, payload: T): T {
  return payload;
}

export interface IMultiVaultToolSpec<
  TInput extends { vault?: string },
  TPayload extends Record<string, unknown>,
  TSingle,
> {
  name: ToolName;
  title: string;
  /** Domain prose only. The multi-vault contract is appended by the builder. */
  description: string;
  /** Optional domain sentence appended after the shared fan-out suffix. */
  multiVaultNote?: string;
  /** Domain params. `vault` is contributed by the builder, never here. */
  inputShape: z.ZodRawShape;
  runForEntry: (entry: IVaultEntry, input: TInput) => Promise<TPayload>;
  /** `withVaultName` or `payloadOnly` — required, so the choice is explicit. */
  single: (entry: IVaultEntry, payload: TPayload) => TSingle;
}

/**
 * The one owner of the multi-vault dispatch contract.
 *
 * Five tools previously carried private copies of three things: this branch,
 * the fan-out description prose, and the `& Record<string, unknown>` bound
 * needed to satisfy `IFanOutResult`. The prose copies had already drifted into
 * three variants, two of them describing `skipped_vaults` semantics no code
 * path delivers. Under ADR-0010 a tool description is a delivery channel, so
 * that drift was a behaviour bug, not cosmetic debt.
 */
export function buildMultiVaultTool<
  TInput extends { vault?: string },
  TPayload extends Record<string, unknown>,
  TSingle,
>(
  registry: IVaultRegistry,
  spec: IMultiVaultToolSpec<TInput, TPayload, TSingle>,
): ITool<TInput, TSingle | IFanOutResult<TPayload>> {
  const suffix =
    spec.multiVaultNote === undefined ? FAN_OUT_SUFFIX : `${FAN_OUT_SUFFIX} ${spec.multiVaultNote}`;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + describeMultiVault(registry, suffix),
    inputSchema: z.object({ ...vaultParamShape(registry), ...spec.inputShape }),
    handler: async (input) => {
      if (input.vault === undefined && registry.isMulti()) {
        return await runFanOut(registry, (entry) => spec.runForEntry(entry, input));
      }
      const entry = resolveVault(input, registry, { tool: spec.name });
      return spec.single(entry, await spec.runForEntry(entry, input));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/multi-vault-tool.test.ts && npm run typecheck`
Expected: PASS (9 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/multi-vault-tool.ts test/lib/multi-vault-tool.test.ts
git commit -m "feat(lib): add buildMultiVaultTool owning the fan-out dispatch contract"
```

---

### Task 3: Migrate `list_tags`

Tasks 3, 4, 5, and 6 are **parallel-safe** with each other — one source file and one test file each, no shared state. All four depend on Task 2.

**Files:**
- Modify: `src/modules/operations/tools/list-tags.ts` (whole file)
- Test: `test/operations/tools/list-tags.test.ts`, `test/operations/tools.test.ts` (must stay green)

**Interfaces:**
- Consumes: `buildMultiVaultTool`, `withVaultName` (Task 2).
- Produces: `buildListTagsTool(deps: ListTagsDeps)` — signature unchanged; only its return type widens to the builder's.

- [ ] **Step 1: Add the regression test for the single-vault shape**

Append to `test/operations/tools/list-tags.test.ts`:

```ts
it('returns { vault, results } for a single vault and never a top-level fan-out envelope', async () => {
  const tool = buildListTagsTool({ registry: registryOf('only') });
  const out = await tool.handler({});
  expect(out).toEqual({ vault: 'only', results: [{ name: 'x', count: 1 }] });
});

it('carries the shared fan-out prose and never mentions skipped_vaults', () => {
  const tool = buildListTagsTool({ registry: registryOf('a', 'b') });
  expect(tool.description).toContain(FAN_OUT_SUFFIX);
  expect(tool.description).not.toContain('skipped_vaults');
});
```

Add the imports this needs at the top of that file: `FAN_OUT_SUFFIX` from `../../../src/lib/vault-param.js`. If the file has no `registryOf` helper, use `makeTestRegistry` from `./_test-registry.js` with `provider: { listTags: async () => [{ name: 'x', count: 1 }] }` on each entry.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/operations/tools/list-tags.test.ts`
Expected: FAIL on the prose assertion — the description still holds its own hand-written variant, not `FAN_OUT_SUFFIX`.

- [ ] **Step 3: Rewrite the tool through the builder**

Replace the whole of `src/modules/operations/tools/list-tags.ts`:

```ts
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

type TagEntry = { name: string; count: number };
type FlatOutput = { vault: string; results: TagEntry[] };
type FanOutPayload = { results: TagEntry[] } & Record<string, unknown>;

export interface ListTagsDeps {
  registry: IVaultRegistry;
}

async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await entry.provider.listTags();
  return { results };
}

export function buildListTagsTool(
  deps: ListTagsDeps,
): ITool<Input, FlatOutput | IFanOutResult<FanOutPayload>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'list_tags',
    title: 'List Tags',
    description:
      'List all tags used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }`. Counts aggregate frontmatter `tags:` values and inline body `#tags` (Obsidian grammar), deduplicated per note — each distinct tag counts once per note. Note: the `tags` filter of `query_notes`/`search_notes` matches frontmatter tags only, so a tag that exists only inline is reported here but not filterable there.',
    inputShape: {},
    runForEntry,
    single: withVaultName,
  });
}
```

The `FanOutPayload` alias stays for now — Task 10 decides whether it can go.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/operations/tools/list-tags.test.ts test/operations/tools.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/tools/list-tags.ts test/operations/tools/list-tags.test.ts
git commit -m "refactor(tools): build list_tags through buildMultiVaultTool"
```

---

### Task 4: Migrate `list_properties`

**Files:**
- Modify: `src/modules/operations/tools/list-properties.ts` (whole file)
- Test: `test/operations/tools.test.ts` (must stay green — it asserts `ALL frontmatter properties`, `complete inventory`, `get_vault_overview`, `count`)

**Interfaces:**
- Consumes: `buildMultiVaultTool`, `withVaultName` (Task 2).
- Produces: `buildListPropertiesTool(deps: ListPropertiesDeps)` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/operations/tools.test.ts`, inside the existing top-level `describe`:

```ts
it('list_properties carries the shared fan-out prose and no skipped_vaults', () => {
  const tools = buildOperationsTools({ registry: multiRegistry });
  const listProperties = tools.find((t) => t.name === 'list_properties')!;
  expect(listProperties.spec.description).toContain(FAN_OUT_SUFFIX);
  expect(listProperties.spec.description).not.toContain('skipped_vaults');
});
```

Import `FAN_OUT_SUFFIX` from `../../src/lib/vault-param.js`. If the file has no two-vault registry in scope, build one from the existing `noopEntry` pattern with two differently-named entries and name it `multiRegistry`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/operations/tools.test.ts`
Expected: FAIL — the description holds its own prose variant.

- [ ] **Step 3: Rewrite the tool through the builder**

Replace the whole of `src/modules/operations/tools/list-properties.ts`:

```ts
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

type PropertyEntry = { name: string; count: number };
type FlatOutput = { vault: string; results: PropertyEntry[] };
type FanOutPayload = { results: PropertyEntry[] } & Record<string, unknown>;

export interface ListPropertiesDeps {
  registry: IVaultRegistry;
}

async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await entry.provider.listProperties();
  return { results };
}

export function buildListPropertiesTool(
  deps: ListPropertiesDeps,
): ITool<Input, FlatOutput | IFanOutResult<FanOutPayload>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'list_properties',
    title: 'List Properties',
    description:
      'List ALL frontmatter properties used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }` — the complete inventory, unlike `get_vault_overview` which truncates properties to the top entries. Rare and one-off keys are included, which is what property-consistency audits need.',
    inputShape: {},
    runForEntry,
    single: withVaultName,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/operations/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/tools/list-properties.ts test/operations/tools.test.ts
git commit -m "refactor(tools): build list_properties through buildMultiVaultTool"
```

---

### Task 5: Migrate `query_notes` — the first `payloadOnly` tool

**Files:**
- Modify: `src/modules/operations/tools/query-notes.ts` (whole file)
- Test: `test/operations/tools/query-notes.test.ts`, `test/operations/tools.test.ts`

**Interfaces:**
- Consumes: `buildMultiVaultTool`, `payloadOnly` (Task 2).
- Produces: `buildQueryNotesTool(deps: QueryNotesDeps)` — signature unchanged. `QueryNotesResultWithVault` and `QueryNotesResultItemWithVault` stay exported; other modules may import them.

This is the first tool where the single-vault return must NOT gain a top-level `vault` — each result item carries its own.

- [ ] **Step 1: Write the failing test**

Append to `test/operations/tools/query-notes.test.ts`:

```ts
it('returns the payload unchanged for a single vault — vault rides on each item', async () => {
  const tool = buildQueryNotesTool({ registry: registryOf('only') });
  const out = (await tool.handler({ filter: {} })) as {
    results: Array<{ vault: string }>;
    count: number;
    truncated: boolean;
  };
  expect(Object.keys(out).sort()).toEqual(['count', 'results', 'truncated']);
  expect(out).not.toHaveProperty('vault');
  for (const item of out.results) expect(item.vault).toBe('only');
});

it('drops the skipped_vaults sentence from its description', () => {
  const tool = buildQueryNotesTool({ registry: registryOf('a', 'b') });
  expect(tool.description).not.toContain('skipped_vaults');
  expect(tool.description).toContain(FAN_OUT_SUFFIX);
});
```

Import `FAN_OUT_SUFFIX` from `../../../src/lib/vault-param.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/operations/tools/query-notes.test.ts`
Expected: FAIL — the description still contains `` `skipped_vaults: [...]` (pre-filtered out) ``.

- [ ] **Step 3: Rewrite the tool through the builder**

In `src/modules/operations/tools/query-notes.ts`, keep everything from `queryNotesSortSchema` through `runQueryForEntry` and `queryNotesPrefixSchema` **unchanged**. Replace only the `buildQueryNotesTool` function and swap the imports:

```ts
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';
```

(Delete the now-unused `resolveVault`, `runFanOut`, `describeMultiVault`, and `vaultParamShape` imports; `z` and `runQueryNotes` stay.)

```ts
export function buildQueryNotesTool(
  deps: QueryNotesDeps,
): ITool<Input, QueryNotesResultWithVault | IFanOutResult<QueryNotesResultRecord>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'query_notes',
    title: 'Query Notes',
    description: QUERY_NOTES_DESCRIPTION,
    inputShape: {
      filter: z.record(z.string(), z.unknown()),
      path_prefix: queryNotesPrefixSchema.optional(),
      exclude_path_prefix: queryNotesPrefixSchema.optional(),
      sort: queryNotesSortSchema.optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      include_content: z.boolean().optional(),
    },
    runForEntry: (entry, input: QueryNotesToolInput & { vault?: string }) =>
      runQueryForEntry(entry, input),
    single: payloadOnly,
  });
}
```

Lift the existing long description string verbatim into a module-level `const QUERY_NOTES_DESCRIPTION = '...'` above the function, **deleting only** the trailing `describeMultiVault(registry, '...')` call and its argument — the sentence that mentions `skipped_vaults`. Change no other character of that description; `test/operations/tools.test.ts` asserts `MongoDB`, `$and`, `$exists`, `truncated`, and `include_content` against it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/operations/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/tools/query-notes.ts test/operations/tools/query-notes.test.ts
git commit -m "refactor(tools): build query_notes through buildMultiVaultTool"
```

---

### Task 6: Migrate `get_vault_overview`

**Files:**
- Modify: `src/modules/operations/tools/get-vault-overview.ts` (whole file)
- Test: `test/operations/tools/get-vault-overview.test.ts`

**Interfaces:**
- Consumes: `buildMultiVaultTool`, `withVaultName` (Task 2).
- Produces: `buildGetVaultOverviewTool(deps: GetVaultOverviewDeps)` — signature unchanged.

The `conventions` sentence in this description is load-bearing: `openspec/specs/vault-conventions-delivery/spec.md` has requirements riding on it. It must survive character-for-character.

- [ ] **Step 1: Write the failing test**

Append to `test/operations/tools/get-vault-overview.test.ts`:

```ts
it('keeps the conventions sentence and drops the skipped_vaults sentence', () => {
  const tool = buildGetVaultOverviewTool({ registry: registryOf('a', 'b') });
  expect(tool.description).toContain(
    "the response carries them in `conventions` — the vault owner's rules for how this vault is organised.",
  );
  expect(tool.description).not.toContain('skipped_vaults');
  expect(tool.description).toContain(FAN_OUT_SUFFIX);
});
```

Import `FAN_OUT_SUFFIX` from `../../../src/lib/vault-param.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/operations/tools/get-vault-overview.test.ts`
Expected: FAIL on the `skipped_vaults` assertion.

- [ ] **Step 3: Rewrite the tool through the builder**

Replace the whole of `src/modules/operations/tools/get-vault-overview.ts`:

```ts
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { computeVaultOverview, type VaultOverview } from '../../../lib/obsidian/vault-overview.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

export interface GetVaultOverviewDeps {
  registry: IVaultRegistry;
}

// VaultOverview & Record<string, unknown> satisfies the FanOut constraint
type VaultOverviewRecord = VaultOverview & Record<string, unknown>;

async function runOverviewForEntry(entry: IVaultEntry): Promise<VaultOverviewRecord> {
  const overview = await computeVaultOverview({
    reader: entry.reader,
    provider: entry.provider,
    graph: entry.graph,
    readConventions: entry.readConventions,
  });
  return overview as VaultOverviewRecord;
}

export function buildGetVaultOverviewTool(
  deps: GetVaultOverviewDeps,
): ITool<Input, ({ vault: string } & VaultOverview) | IFanOutResult<VaultOverviewRecord>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'get_vault_overview',
    title: 'Get Vault Overview',
    description:
      'Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties (top entries only — use `list_properties` for the full inventory), total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`.' +
      " When the vault owner has written conventions for external agents, the response carries them in `conventions` — the vault owner's rules for how this vault is organised. Follow them when reading, writing, or organising notes here.",
    inputShape: {},
    runForEntry: runOverviewForEntry,
    single: withVaultName,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/operations/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/tools/get-vault-overview.ts test/operations/tools/get-vault-overview.test.ts
git commit -m "refactor(tools): build get_vault_overview through buildMultiVaultTool"
```

---

### Task 7: Sweep the test suite for stale `skipped_vaults` description assertions

**Files:**
- Modify: whichever files the grep in Step 1 turns up under `test/`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task exists so Task 8 starts from a green suite.

- [ ] **Step 1: Find every assertion on the removed sentence**

Run: `grep -rn "skipped_vaults" test/ src/ docs/`
Expected: hits in `src/lib/fan-out.ts` (the shape — keep), `test/lib/fan-out.test.ts` (the shape — keep), and `docs/architecture/fan-out.md` (Task 12). Any hit asserting **description** text is stale and must be updated to assert its absence instead.

- [ ] **Step 2: Update each stale assertion**

For every description-level hit, replace the positive assertion with:

```ts
expect(tool.description).not.toContain('skipped_vaults');
```

Leave every response-shape assertion (`expect(out.skipped_vaults).toEqual([])`) untouched — the field stays.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: assert skipped_vaults is absent from descriptions, present in responses"
```

---

### Task 8: Migrate `search_notes`

Sequential — do this after Tasks 3–7. Largest description surface and the only tool with mid-description position-dependent text.

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts:486-588` (`buildSearchNotesTool` only)
- Test: `test/semantic/tools/search-notes.test.ts`, `test/semantic/tools/index.test.ts`

**Interfaces:**
- Consumes: `buildMultiVaultTool`, `payloadOnly` (Task 2).
- Produces: `buildSearchNotesTool(deps: SearchNotesDeps)` — signature unchanged.

Do not touch anything above line 480. The in-flight `unify-retrieval-pipeline` change edits `runSearchForEntry` and the node-shape code in that region; keeping to `buildSearchNotesTool` makes the two a textual merge rather than a semantic conflict.

- [ ] **Step 1: Write the failing test**

Append to `test/semantic/tools/search-notes.test.ts`:

```ts
it('names the registered vaults exactly once', () => {
  const tool = buildSearchNotesTool(depsFor('alpha', 'beta'));
  const occurrences = tool.description.split('Registered vaults:').length - 1;
  expect(occurrences).toBe(1);
});

it('carries the shared fan-out prose followed by its semantic-index note', () => {
  const tool = buildSearchNotesTool(depsFor('alpha', 'beta'));
  expect(tool.description).toContain(FAN_OUT_SUFFIX);
  expect(tool.description.indexOf(FAN_OUT_SUFFIX)).toBeLessThan(
    tool.description.indexOf('still contributes lexically-sourced matches'),
  );
});

it('keeps the vault parameter line in the PARAMETERS block, gated on multi-vault mode', () => {
  const multi = buildSearchNotesTool(depsFor('alpha', 'beta'));
  const single = buildSearchNotesTool(depsFor('only'));
  expect(multi.description).toContain(
    '- vault: target a specific vault by name when multiple are registered.',
  );
  expect(single.description).not.toContain('- vault:');
  expect(single.description).not.toContain('Registered vaults:');
});
```

Reuse the file's existing deps helper; if it has none, mirror `toolsFor` from `test/semantic/tools/index.test.ts` and name it `depsFor`. Import `FAN_OUT_SUFFIX` from `../../../src/lib/vault-param.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/semantic/tools/search-notes.test.ts`
Expected: FAIL — the description holds its own prose variant and its hand-rolled `Registered vaults:` block.

- [ ] **Step 3: Rewrite `buildSearchNotesTool`**

In the `SEARCH_NOTES_DESCRIPTION` array, delete the final `...(registry.isMulti() ? [...] : [])` spread entirely — the block containing the fan-out sentence and the hand-built `Registered vaults: ...` template literal. Keep the earlier `...(registry.isMulti() ? ['- vault: target a specific vault by name when multiple are registered.'] : [])` spread inside `PARAMETERS:` exactly where it is.

End the array with a bare `''` so the join leaves a blank line before the appended suffix:

```ts
    '  - frontmatter: sift filter on frontmatter keys, same operator allow-list as query_notes.',
    '',
  ].join('\n');
```

Then replace the returned object:

```ts
  return buildMultiVaultTool(registry, {
    name: 'search_notes',
    title: 'Search Notes',
    description: SEARCH_NOTES_DESCRIPTION,
    multiVaultNote:
      'A vault without a semantic index still contributes lexically-sourced matches; none are skipped.',
    inputShape: {
      query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
      mode: z.enum(['hybrid', 'lexical']).optional(),
      effort: z.enum(['quick', 'deep']).optional(),
      limit: z.number().int().positive().optional(),
      threshold: z.number().min(0).max(1).optional(),
      expansion_floor: z.number().min(0).max(1).optional(),
      filter: filterSchema.optional(),
    },
    runForEntry: (entry, input: SearchNotesInput) => runSearchForEntry(entry, input, entryDeps),
    single: payloadOnly,
  });
```

Delete the now-dead local `inputSchema` const, and the `resolveVault` / `runFanOut` / `vaultParamShape` imports if nothing above line 480 still uses them. Keep `lexicalIndexes`, `lexicalFor`, and `entryDeps` exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/semantic/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/tools/search-notes.ts test/semantic/tools/search-notes.test.ts
git commit -m "refactor(tools): build search_notes through buildMultiVaultTool"
```

---

### Task 9: The drift guarantee — the load-bearing test

**Files:**
- Create: `test/lib/fan-out-prose.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `buildOperationsTools` from `src/modules/operations/tools/index.js`, `buildSemanticTools` from `src/modules/semantic/tools/index.js`, `FAN_OUT_SUFFIX`, `makeTestRegistry` from `test/operations/tools/_test-registry.js`.
- Produces: nothing consumed downstream.

Without this test the change buys tidiness, not a drift guarantee. It is the deliverable, not an extra.

- [ ] **Step 1: Write the test**

Create `test/lib/fan-out-prose.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import { buildSemanticTools } from '../../src/modules/semantic/tools/index.js';
import { FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import { makeTestRegistry } from '../operations/tools/_test-registry.js';
import { makeFakeGraph } from '../semantic/tools/_helpers.js';

const FAN_OUT_TOOLS = [
  'list_tags',
  'list_properties',
  'query_notes',
  'get_vault_overview',
  'search_notes',
];

function allTools(...names: string[]) {
  const registry = makeTestRegistry(
    names.map((name) => ({
      name,
      path: `/vaults/${name}`,
      smartEnvPath: `/vaults/${name}/.smart-env`,
      graph: makeFakeGraph(),
      listMatchingPaths: async () => new Set<string>(),
      provider: { listTags: async () => [], listProperties: async () => [] } as never,
    })),
  );
  return [
    ...buildOperationsTools({ registry }),
    ...buildSemanticTools({
      registry,
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn() },
      searchEngine: {
        findNeighbors: vi.fn().mockReturnValue([]),
        findBlockNeighbors: vi.fn().mockReturnValue([]),
        findDuplicates: vi.fn().mockReturnValue([]),
      },
      modelKey: 'bge-micro-v2',
    }),
  ];
}

describe('fan-out prose has exactly one copy', () => {
  it('every fan-out tool carries FAN_OUT_SUFFIX byte for byte', () => {
    const tools = allTools('alpha', 'beta');
    for (const name of FAN_OUT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      expect(tool!.spec.description, `${name} description`).toContain(FAN_OUT_SUFFIX);
    }
  });

  it('no tool advertises skipped_vaults', () => {
    for (const tool of allTools('alpha', 'beta')) {
      expect(tool.spec.description, `${tool.name} description`).not.toContain('skipped_vaults');
    }
  });

  it('but the fan-out response still carries the field', async () => {
    const listTags = allTools('alpha', 'beta').find((t) => t.name === 'list_tags')!;
    const out = await listTags.handler({});
    const payload = JSON.parse(out.content[0].text as string) as { skipped_vaults: unknown[] };
    expect(payload.skipped_vaults).toEqual([]);
    expect(payload).toHaveProperty('results_by_vault');
    expect(payload).toHaveProperty('failed_vaults');
  });

  it('every fan-out tool advertises vault in multi-vault mode', () => {
    const tools = allTools('alpha', 'beta');
    for (const name of FAN_OUT_TOOLS) {
      const schema = tools.find((t) => t.name === name)!.spec.inputSchema as z.ZodObject<
        z.ZodRawShape
      >;
      expect(Object.keys(schema.shape), `${name} schema`).toContain('vault');
    }
  });

  it('no fan-out tool advertises vault or the fan-out prose in single-vault mode', () => {
    const tools = allTools('only');
    for (const name of FAN_OUT_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      const schema = tool.spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(schema.shape), `${name} schema`).not.toContain('vault');
      expect(tool.spec.description, `${name} description`).not.toContain(FAN_OUT_SUFFIX);
    }
  });
});
```

Assertions go through `spec.inputSchema` / `spec.description` — the SDK gate — so an advertisement bug cannot pass by satisfying the handler alone. If `spec.inputSchema` arrives wrapped by `wrapSchemaWithCoercion` and `.shape` is not directly reachable, unwrap with the same accessor the existing suites use rather than falling back to the raw tool object.

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/lib/fan-out-prose.test.ts`
Expected: PASS (5 tests). If a schema test fails on unwrapping, fix the accessor — do not weaken the assertion to `tool.inputSchema`.

- [ ] **Step 3: Verify it actually catches drift**

Temporarily edit `src/modules/operations/tools/list-tags.ts` to append `+ ' Extra drifted sentence.'` to its `description`, then run the test.
Expected: still PASS (appending is allowed). Now temporarily change `FAN_OUT_SUFFIX`'s wording in `src/lib/vault-param.ts` and re-run.
Expected: FAIL for all five tools — proving the shared constant is genuinely the single source. Revert both edits.

- [ ] **Step 4: Commit**

```bash
git add test/lib/fan-out-prose.test.ts
git commit -m "test: assert the fan-out prose has exactly one copy across all five tools"
```

---

### Task 10: Relax the `IFanOutResult` generic — contingent (design D4)

**Files:**
- Modify: `src/lib/fan-out.ts:20` (`IFanOutResult`), `src/lib/fan-out.ts:70` (`runFanOut`), `src/lib/multi-vault-tool.ts` (the `TPayload` bound in three places)
- Then, only if typecheck is clean: `src/modules/operations/tools/{list-tags,list-properties,query-notes,get-vault-overview}.ts`, `src/modules/semantic/tools/search-notes.ts:81`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces: no signature change. Either the aliases disappear or they stay; both outcomes are acceptable, and only the line-count win is contingent.

- [ ] **Step 1: Relax the constraint**

In `src/lib/fan-out.ts`, change both occurrences:

```ts
export interface IFanOutResult<T extends object> {
```

```ts
export async function runFanOut<T extends object>(
```

In `src/lib/multi-vault-tool.ts`, change `TPayload extends Record<string, unknown>` to `TPayload extends object` in `IMultiVaultToolSpec`, in `buildMultiVaultTool`, and in the `withVaultName` / `payloadOnly` signatures.

- [ ] **Step 2: Run the authoritative check**

Run: `npm run typecheck`
Expected: clean. If it errors on the `{ vault, ...outcome.value }` spread inside `runFanOut`, D4's hypothesis is wrong — go to Step 4.

- [ ] **Step 3: If clean — delete the workarounds**

Delete `type FanOutPayload = ... & Record<string, unknown>` from `list-tags.ts` and `list-properties.ts` (replace uses with the bare object type), `type QueryNotesResultRecord` from `query-notes.ts` (use `QueryNotesResultWithVault`), `type VaultOverviewRecord` from `get-vault-overview.ts` (use `VaultOverview`, and drop the now-unneeded `as VaultOverviewRecord` cast), and the index-signature workaround plus its comment at `src/modules/semantic/tools/search-notes.ts:81`.

Then run: `npm run typecheck && npm test`
Expected: clean and green. Skip Step 4.

- [ ] **Step 4: If it errors — revert and record**

```bash
git checkout -- src/lib/fan-out.ts src/lib/multi-vault-tool.ts
```

The aliases stay where they are; the builder keeps declaring `TPayload extends Record<string, unknown>` once. Paste the exact `tsc` diagnostic into `openspec/changes/multi-vault-dispatch-builder/verify.md` under a "D4 outcome" heading, so the next reader does not re-litigate the hypothesis from scratch.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green, whichever branch was taken.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(lib): relax IFanOutResult to T extends object"
```

If Step 4 was taken instead, commit only `verify.md` with: `docs(openspec): record the D4 typecheck outcome`.

---

### Task 11: Update `docs/architecture/fan-out.md`

Parallel-safe with Task 10 — different files, no code dependency.

**Files:**
- Modify: `docs/architecture/fan-out.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

Per ADR-0008 this is the living current-state layer, and it is the **only** doc that must state the new current state. Do not touch `docs/adr/` (design D6).

- [ ] **Step 1: Add the builder section**

Insert a new `## The builder` section after `## What it is`:

```markdown
## The builder

Tools do not call `runFanOut` directly. `src/lib/multi-vault-tool.ts` exports
`buildMultiVaultTool`, which owns the whole dispatch contract: it contributes the
`vault` parameter via `vaultParamShape`, appends the shared `FAN_OUT_SUFFIX`
through `describeMultiVault`, and chooses between `runFanOut` and `resolveVault`.
A tool supplies only `runForEntry`, its domain description, and which
single-vault shape it follows.

Two single-vault shapes exist, and each tool names its own — there is no default:

| shape           | tools                                              | why                                     |
| --------------- | -------------------------------------------------- | --------------------------------------- |
| `withVaultName` | `list_tags`, `list_properties`, `get_vault_overview` | the payload has no vault identity of its own |
| `payloadOnly`   | `query_notes`, `search_notes`                        | each result item already carries `vault` |

`search_notes` additionally passes a `multiVaultNote` — one domain sentence
appended after the shared suffix — and keeps its own `- vault: ...` line inside
its mid-description `PARAMETERS:` block, which a generic builder cannot place.

Before the builder, all five tools carried private copies of the dispatch
branch, the prose, and the `IFanOutResult` type bound; the prose copies had
drifted into three variants. `test/lib/fan-out-prose.test.ts` now asserts all
five carry `FAN_OUT_SUFFIX` byte for byte, so the drift cannot recur.
```

- [ ] **Step 2: Correct the `skipped_vaults` section**

The existing `## skipped vs failed` section and its "always `[]` today" paragraph stay — they explain why the field remains in the shape, which is still true. Append one sentence to that paragraph:

```markdown
No tool description advertises the field, precisely because nothing populates it;
`FAN_OUT_SUFFIX` describes `results_by_vault` and `failed_vaults` only.
```

- [ ] **Step 3: Sweep the rest of the docs**

Run: `grep -rn "fan-out\|fan out\|skipped_vaults\|describeMultiVault" docs/`
Check every hit — **including `docs/guide/`**, which architecture-scoped greps miss — for claims that each tool composes its own fan-out prose, or that repeat the removed `skipped_vaults` description wording. Fix what is stale; leave `docs/adr/` alone.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(architecture): document buildMultiVaultTool as the fan-out entry point"
```

---

### Task 12: Final gates

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: everything.
- Produces: a green branch ready for `gh pr create`.

- [ ] **Step 1: Run the full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all three green. All three are required by AGENTS.md before any commit or PR, and CI enforces them plus `npm run build`.

- [ ] **Step 2: Validate the change artifacts**

Run: `npx openspec validate --all`
Expected: green, including `change/multi-vault-dispatch-builder`.

- [ ] **Step 3: Confirm the acceptance criteria**

Run: `npx vitest run test/lib/fan-out-prose.test.ts`
Expected: PASS — five tools registered, byte-identical fan-out prose, no `skipped_vaults` in any description, `vault` advertised in multi-vault mode and absent in single-vault mode.

Then run: `grep -rn "registry.isMulti()" src/modules/`
Expected: exactly one hit — the `PARAMETERS:` gate in `search-notes.ts`. Any other hit is a dispatch branch that escaped the migration.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "refactor(tools): one owner for the multi-vault dispatch contract" --body "Implements openspec/changes/multi-vault-dispatch-builder. Report item 2."
```

Never push directly to `main`.
