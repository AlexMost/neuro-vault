# Operations Tool-Contract Tests Through the Registration Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every tool test in `test/operations/tools/` and `test/semantic/tools/` cross the same registration gate an MCP client crosses, delete the `read_notes` post-gate validation that the gate makes unreachable, and record the gate's contract durably.

**Architecture:** Two shared test helpers (`callTool`, `expectToolError`) wrap `ToolRegistration.handler`, unwrapping `structuredContent` on success and re-throwing `{ code, message, details }` as a `ToolHandlerError` on failure — so a migrated call site changes from `tool.handler(x)` to `callTool(reg, x)` and its existing `rejects.toMatchObject({ code })` assertion still holds. `validateReadNotesInput` loses three unreachable branches and a fourth zod already performs, leaving a three-line widening inlined into its only caller. The contract the tests now describe is recorded in ADR-0015 and the two architecture pages that currently describe it wrongly.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 20), zod 4, vitest 3, `@modelcontextprotocol/sdk`, eslint (typescript-eslint type-checked), OpenSpec CLI 1.6.0.

**Spec:** `openspec/changes/operations-tests-through-gate/design.md`, with delta specs at `specs/read-notes-content-modes/spec.md` and `specs/tolerant-arguments/spec.md`. Task list: `tasks.md`. Tracking issue: #112.

## Global Constraints

- `npm test`, `npm run lint`, and `npm run typecheck` MUST all pass before any commit or PR. `npm run typecheck` (`tsc --noEmit`) is authoritative — a `tsup` build is not (isolatedModules, ADR-0002).
- The lint gate is `eslint .` over the whole repo, not a path subset. Run the verbatim command.
- No tool's input schema, output shape, or error code may change. This work makes tests and specs describe the contract that already ships.
- `.strict()` is never relaxed to make a migrated test pass. A test that fails because its input carries an undeclared key is a finding: fix the input, or rewrite the test to assert the rejection.
- Commits follow Conventional Commits (commitlint runs in CI). Every commit ends with the `Co-Authored-By` trailer for this session's primary model.
- PRs go to `main` via `gh pr create` — never push to `main` directly. PRs 1–3 carry `Refs #112`; PR 4 carries `Closes #112`.
- Under `test/**` eslint disables `@typescript-eslint/no-unsafe-*` and `require-await`, but keeps `no-floating-promises` and `no-misused-promises` on. Every `callTool` / `expect(...)` call must be awaited.

---

## Task 1: The gate helpers

**Files:**
- Create: `test/_gate.ts`
- Create: `test/gate-helpers.test.ts`

**Interfaces:**
- Consumes: `ToolRegistration` from `src/lib/tool-registration.ts`; `ToolHandlerError` from `src/lib/tool-response.ts`.
- Produces: `callTool<T>(reg: ToolRegistration, args: unknown): Promise<T>` and `expectToolError(reg: ToolRegistration, args: unknown): Promise<ToolErrorPayload>`, where `ToolErrorPayload = { code: string; message: string; details?: Record<string, unknown> }`. Every later task uses exactly these two names.
- Note for Tasks 15–19: `callTool` returns array payloads too (via the text channel), so `find_duplicates` and `get_similar_notes` migrate the same way every other tool does.

- [ ] **Step 1: Re-run the payload audit**

`toToolResponse` only sets `structuredContent` when `Object.getPrototypeOf(value) === Object.prototype`. Two tools resolve with an array and therefore travel in the text channel only:

```bash
grep -n "): ITool<" src/modules/operations/tools/*.ts src/modules/semantic/tools/*.ts
```

Expected: every operations tool and `search_notes` resolve with an object (including `IFanOutResult`, an object literal from `runFanOut`); `find_duplicates` resolves with `StampedDuplicatePair[]` and `get_similar_notes` with `StampedSimilarNoteResult[]`. `callTool` handles those two through the text-channel fallback in Step 4. If the grep shows a **third** non-object payload, record it in the PR body — the fallback covers it, but the reviewer should know.

- [ ] **Step 2: Write the failing helper test**

Create `test/gate-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerTool } from '../src/lib/tool-registry.js';
import { ToolHandlerError } from '../src/lib/tool-response.js';
import { callTool, expectToolError } from './_gate.js';

function regReturning<T>(value: T) {
  return registerTool({
    name: 'probe',
    description: 'probe',
    inputSchema: z.object({ q: z.string() }),
    handler: async () => value,
  });
}

describe('callTool', () => {
  it('unwraps structuredContent on success', async () => {
    const out = await callTool<{ ok: boolean }>(regReturning({ ok: true }), { q: 'x' });
    expect(out).toEqual({ ok: true });
  });

  it('re-throws a gate rejection as a ToolHandlerError carrying code and issues', async () => {
    const reg = regReturning({ ok: true });
    await expect(callTool(reg, { q: 1 })).rejects.toBeInstanceOf(ToolHandlerError);
    await expect(callTool(reg, { q: 1 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'q' }] },
    });
  });

  it('re-throws a handler error preserving its code and details', async () => {
    const reg = registerTool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({ q: z.string() }),
      handler: async () => {
        throw new ToolHandlerError('NOT_FOUND', 'nope', { details: { path: 'a.md' } });
      },
    });
    await expect(callTool(reg, { q: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'nope',
      details: { path: 'a.md' },
    });
  });

  it('falls back to the text channel for a non-record payload', async () => {
    const out = await callTool<Array<{ a: number }>>(regReturning([{ a: 1 }]), { q: 'x' });
    expect(out).toEqual([{ a: 1 }]);
  });

  it('returns undefined for the ok void sentinel', async () => {
    const reg = registerTool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({ q: z.string() }),
      handler: async () => undefined,
    });
    expect(await callTool(reg, { q: 'x' })).toBeUndefined();
  });
});

describe('expectToolError', () => {
  it('returns the structured error payload', async () => {
    const payload = await expectToolError(regReturning({ ok: true }), { q: 1 });
    expect(payload.code).toBe('INVALID_PARAMS');
    expect(payload.message).toContain('q');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/gate-helpers.test.ts`
Expected: FAIL — `Failed to resolve import "./_gate.js"`.

- [ ] **Step 4: Implement the helpers**

Create `test/_gate.ts`:

```ts
import { expect } from 'vitest';

import type { ToolRegistration } from '../src/lib/tool-registration.js';
import { ToolHandlerError } from '../src/lib/tool-response.js';

export interface ToolErrorPayload {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function firstText(result: Awaited<ReturnType<ToolRegistration['handler']>>): string {
  const block = result.content?.find((c): c is { type: 'text'; text: string } => c.type === 'text');
  if (block === undefined) {
    throw new Error('callTool: tool result carried no text content block');
  }
  return block.text;
}

/**
 * Call a tool the way an MCP client does: through the registration, so the
 * coercing, `.strict()` input gate runs first. Success payloads come back
 * unwrapped; gate and handler rejections are re-thrown so `await expect(...)
 * .rejects.toMatchObject(...)` reads the same as it did when tests called the
 * raw handler.
 *
 * `toToolErrorResponse` (`src/lib/tool-response.ts`) produces one of two
 * envelope shapes, and the reconstruction here must stay faithful to both:
 *   - a `ToolHandlerError` → `structuredContent: { code, message, details }`.
 *     Re-thrown as a `ToolHandlerError` carrying that same code/message/details.
 *   - anything else (a plain `Error`, a `TypeError`, any non-`ToolHandlerError`
 *     `invokeTool` catches) → `structuredContent: { message }` with **no**
 *     `code` key. Re-thrown as a plain `Error` with that message. No code is
 *     invented — production never emits one for this shape, so a test must
 *     not be able to pin one either.
 *
 * `toToolResponse` only sets `structuredContent` for a plain record, so array
 * payloads (`find_duplicates`, `get_similar_notes`) arrive in the text channel
 * alone — read them the way a client that ignores `structuredContent` does.
 */
export async function callTool<T>(reg: ToolRegistration, args: unknown): Promise<T> {
  const result = await reg.handler(args);
  if (result.isError === true) {
    const payload = result.structuredContent as Partial<ToolErrorPayload> | undefined;
    const message = payload?.message ?? 'tool returned isError with no structured payload';
    if (payload?.code === undefined) {
      throw new Error(message);
    }
    throw new ToolHandlerError(
      payload.code,
      message,
      payload.details === undefined ? undefined : { details: payload.details },
    );
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = firstText(result);
  if (text === 'ok') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `callTool: ${reg.name} resolved with no structuredContent and non-JSON text: ${text}`,
    );
  }
}

/** For tests whose subject is the error envelope itself rather than a throw. */
export async function expectToolError(
  reg: ToolRegistration,
  args: unknown,
): Promise<ToolErrorPayload> {
  const result = await reg.handler(args);
  expect(result.isError).toBe(true);
  return result.structuredContent as unknown as ToolErrorPayload;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/gate-helpers.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass. `test/_gate.ts` is not matched by vitest's `**/*.{test,spec}.*` include, so it is a module, not a suite.

- [ ] **Step 7: Commit**

```bash
git add test/_gate.ts test/gate-helpers.test.ts
git commit -m "test(lib): add callTool/expectToolError gate helpers

Refs #112"
```

---

## Task 2: Migrate `read_notes` tests to the gate and fix the false pins

**Files:**
- Modify: `test/operations/tools/read-notes.test.ts` (all 19 handler-direct call sites)

**Interfaces:**
- Consumes: `callTool` from `test/_gate.ts` (Task 1); `registerTool` from `src/lib/tool-registry.ts`.
- Produces: nothing other tasks depend on. Establishes the migration idiom that Tasks 4–13 and 15–19 copy.

- [ ] **Step 1: Add the imports and a local registration builder**

At the top of `test/operations/tools/read-notes.test.ts`, add:

```ts
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import type { ReadNotesResult } from '../../../src/modules/operations/types.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';

type ReadNotesOut = { vault: string } & ReadNotesResult;

function buildReg(reader: VaultReader = makeReader()) {
  return registerTool(buildReadNotesTool({ registry: makeTestRegistry([{ name: 'v', reader }]) }));
}
```

- [ ] **Step 2: Convert every success call site**

Mechanical substitution — for each test, replace the three-line build plus call:

```ts
    const registry = makeTestRegistry([{ name: 'v', reader }]);
    const tool = buildReadNotesTool({ registry });

    const result = await tool.handler({ paths: ['Folder/n.md'] });
```

with:

```ts
    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['Folder/n.md'] });
```

Assertions below the call are unchanged. **Every fixture must return one reader item per requested path** — `read_notes` projects reader items positionally (`src/modules/operations/tools/read-notes.ts`, `projected[projectedIdx++]`), so a short fixture fails with an opaque `Cannot use 'in' operator to search for 'error' in undefined` rather than a useful assertion diff.

- [ ] **Step 3: Rewrite the four false `INVALID_ARGUMENT` pins**

Replace the tests at roughly L44-50 and L204-227 with:

```ts
  it('rejects an empty string for paths at the gate', async () => {
    await expect(callTool(buildReg(), { paths: '' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('rejects zero paths at the gate', async () => {
    await expect(callTool(buildReg(), { paths: [] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('rejects 51 paths at the gate', async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `n${i}.md`);
    await expect(callTool(buildReg(), { paths })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('rejects an invalid content value at the gate', async () => {
    await expect(callTool(buildReg(), { paths: ['a.md'], content: 'none' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'content' }] },
    });
  });
```

- [ ] **Step 4: Rewrite the legacy `fields` test**

Replace the `'schema strips a legacy fields key and leaves content undefined'` test (roughly L282-292) — it asserts on the raw, pre-`.strict()` schema — with the rejection production performs:

```ts
  it('rejects a legacy fields key as an unrecognized key', async () => {
    await expect(
      callTool(buildReg(), { paths: ['a.md'], fields: ['content'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('fields') }] },
    });
  });
```

- [ ] **Step 5: Add the two never-tested cases**

```ts
  it('coerces a stringified paths array', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: null, content: 'a' },
        { path: 'b.md', frontmatter: null, content: 'b' },
      ],
    });
    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: '["a.md","b.md"]' });

    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(buildReg(), { paths: ['a.md'], vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 6: Run the file and triage every failure**

Run: `npx vitest run test/operations/tools/read-notes.test.ts`
Expected: PASS. Any test that now fails with `Unrecognized key` is a fixture carrying an undeclared parameter — remove the key from the input; do not touch `wrapSchemaWithCoercion`. Write each such triage down for the PR body.

- [ ] **Step 7: Commit**

```bash
git add test/operations/tools/read-notes.test.ts
git commit -m "test(operations): route read_notes tests through the registration gate

The suite called buildReadNotesTool(...).handler directly, entering past
the coercing, strict, INVALID_PARAMS-throwing gate every MCP client
crosses. Four tests pinned INVALID_ARGUMENT for inputs zod rejects first,
and one asserted an unknown 'fields' key is stripped when production
rejects it.

Refs #112"
```

---

## Task 3: Delete the unreachable `read_notes` validation

**Files:**
- Modify: `src/modules/operations/tool-helpers.ts` (delete `VALID_CONTENT_MODES` at L122 and `validateReadNotesInput` at L124-153; drop the now-unused `ContentMode` and `ReadNotesToolInput` type imports)
- Modify: `src/modules/operations/tools/read-notes.ts` (its only caller)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildReadNotesTool` unchanged in signature; `validateReadNotesInput` and `VALID_CONTENT_MODES` no longer exported from `src/modules/operations/tool-helpers.ts`.

This task must land in the same commit as Task 2's file — the deletion breaks `read-notes.ts` the instant it happens, and the typecheck gate cannot be satisfied by either half alone.

- [ ] **Step 1: Confirm the tests already prove the branches are dead**

Run: `npx vitest run test/operations/tools/read-notes.test.ts -t "at the gate"`
Expected: PASS, 4 tests — each asserting `INVALID_PARAMS`. These are the assertions that make the deletion safe: nothing reaches the branches being removed.

- [ ] **Step 2: Inline the widening in `read-notes.ts`**

In `src/modules/operations/tools/read-notes.ts`, change the import:

```ts
import { normalizePath } from '../tool-helpers.js';
```

and replace the first two lines of the handler body:

```ts
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'read_notes' });
      // The registration gate has already enforced the schema: `paths` is a
      // non-empty string or a 1-50 string array, `content` is one of the three
      // modes. All that is left is widening the single-string form.
      const paths = typeof input.paths === 'string' ? [input.paths] : input.paths;
      const content = input.content;
```

- [ ] **Step 3: Delete the helper and its constant**

In `src/modules/operations/tool-helpers.ts`, remove `VALID_CONTENT_MODES` and `validateReadNotesInput` in full, then trim the type import to what remains in use:

```ts
import type { OperationsErrorCode, SetPropertyToolInput } from './types.js';
```

(`ContentMode` and `ReadNotesToolInput` have no other consumer in this file. `ReadNotesToolInput` stays exported from `types.ts` — `IOperationsModule`'s `readNotes` signature still uses it.)

- [ ] **Step 4: Verify nothing else referenced them**

Run: `grep -rn "validateReadNotesInput\|VALID_CONTENT_MODES" src/ test/`
Expected: no output.

- [ ] **Step 5: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/operations/tool-helpers.ts src/modules/operations/tools/read-notes.ts
git commit -m "refactor(operations): drop read_notes validation zod already owns

validateReadNotesInput re-checked the paths type, the empty-string case,
the 1-50 bound and the content enum after the registration gate had
already rejected each one as INVALID_PARAMS. Three branches were
unreachable in production; the fourth duplicated a zod type check. Only
the string-to-array widening survives, inlined into its one caller.

Refs #112"
```

- [ ] **Step 7: Open PR 1 and pause**

```bash
gh pr create --base main --title "test(operations): route read_notes through the registration gate" --body "$(cat <<'BODY'
First of four PRs for #112.

Adds `test/_gate.ts` (`callTool` / `expectToolError`), migrates
`read-notes.test.ts` to call tools the way an MCP client does, rewrites the
five tests that documented behaviour production does not have, and deletes the
`read_notes` post-gate validation the gate makes unreachable.

Payload audit (Task 1 Step 1): list any tool resolving with a non-record beyond the
known two (find_duplicates, get_similar_notes).
Tests broken by the migration: list each one and how it was triaged.

Refs #112

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

**STOP here.** Tasks 4+ do not start until PR 1 is reviewed and merged — the helper shape should be validated against one real file before ~200 more call sites adopt it.

---

## Tasks 4–13: Operations suite migration (PR 2)

**Parallel-safe.** Tasks 4–13 touch disjoint files and may run concurrently.

Every one of these tasks follows the same five-step cycle. The per-task sections
below give the file, its call-site count, and the exact new tests that file gains.

**The shared cycle (apply to the file named in each task):**

1. Add `import { registerTool } from '../../../src/lib/tool-registry.js';` and
   `import { callTool } from '../../_gate.js';`.
2. Replace each `const tool = buildXTool({ registry });` + `await tool.handler(args)`
   pair with `await callTool<Out>(registerTool(buildXTool({ registry })), args)`,
   hoisting a local `buildReg(...)` where the file repeats the same rig. Existing
   `rejects.toMatchObject({ code })` assertions are unchanged — `callTool` re-throws.
3. Append the file's new tests (given per task below).
4. Run `npx vitest run <file>` and triage every failure: an `Unrecognized key`
   failure means the fixture passed an undeclared parameter — fix the fixture.
5. Commit with `test(operations): route <tool> tests through the registration gate` and `Refs #112`.

### Task 4: `create_note`

**Files:** Modify `test/operations/tools/create-note.test.ts` (17 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2** — the result type is `{ vault: string; path: string }`.
- [ ] **Step 2: Add the coercion and strict tests**

```ts
  it('coerces overwrite from the string "true"', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/idea.md' }),
    });
    const reg = registerTool(
      buildCreateNoteTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
    );

    await callTool(reg, { path: 'Inbox/idea.md', content: 'hello', overwrite: 'true' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ overwrite: true }),
    );
  });

  it('parses frontmatter supplied as a JSON string', async () => {
    const provider = makeProvider({
      createNote: vi.fn().mockResolvedValue({ path: 'Inbox/idea.md' }),
    });
    const reg = registerTool(
      buildCreateNoteTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
    );

    await callTool(reg, { path: 'Inbox/idea.md', frontmatter: '{"type":"idea"}' });

    expect(provider.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ frontmatter: { type: 'idea' } }),
    );
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const reg = registerTool(
      buildCreateNoteTool({ registry: makeTestRegistry([{ name: 'v', provider: makeProvider() }]) }),
    );
    await expect(
      callTool(reg, { path: 'a.md', content: 'x', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('rejects an unknown key', async () => {
    const reg = registerTool(
      buildCreateNoteTool({ registry: makeTestRegistry([{ name: 'v', provider: makeProvider() }]) }),
    );
    await expect(callTool(reg, { path: 'a.md', tags: ['x'] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('tags') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/create-note.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route create_note tests through the registration gate` with `Refs #112`.

### Task 5: `query_notes`

**Files:** Modify `test/operations/tools/query-notes.test.ts` (6 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2** — replace `(await tool.handler({...})) as QueryNotesResultWithVault` with `await callTool<QueryNotesResultWithVault>(reg, {...})`, dropping the now-redundant cast.
- [ ] **Step 2: Add the coercion and strict tests**

```ts
  it('parses filter, limit and include_content from their string forms', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { type: 'idea' }, content: 'body' }]),
    });
    const reg = registerTool(
      buildQueryNotesTool({
        registry: makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]),
      }),
    );

    const result = await callTool<QueryNotesResultWithVault>(reg, {
      filter: '{"frontmatter.type":{"$eq":"idea"}}',
      limit: '5',
      include_content: 'true',
    });

    expect(result.count).toBe(1);
    expect(result.results[0].content).toBe('body');
  });

  it('parses path_prefix supplied as a JSON string array', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Tasks/a.md', 'Other/b.md']),
      readNotes: vi.fn().mockResolvedValue([{ path: 'Tasks/a.md', frontmatter: {}, content: '' }]),
    });
    const reg = registerTool(
      buildQueryNotesTool({
        registry: makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]),
      }),
    );

    const result = await callTool<QueryNotesResultWithVault>(reg, {
      filter: {},
      path_prefix: '["Tasks/"]',
    });

    expect(result.results.map((r) => r.path)).toEqual(['Tasks/a.md']);
  });

  it('rejects an unknown key', async () => {
    const reg = registerTool(buildQueryNotesTool({ registry: registryOf('v') }));
    await expect(callTool(reg, { filter: {}, order: 'asc' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('order') }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const reg = registerTool(buildQueryNotesTool({ registry: registryOf('v') }));
    await expect(callTool(reg, { filter: {}, vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/query-notes.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route query_notes tests through the registration gate` with `Refs #112`.

### Task 6: `set_property`

**Files:** Modify `test/operations/tools/set-property.test.ts` (16 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2** — most calls are `await tool.handler(...)` with no result use; they become `await callTool(reg, ...)`.
- [ ] **Step 2: Add the union-coercion and strict tests**

`value` is `z.union([string, number, boolean, string[], number[]])`. The coercion layer takes the array branch only for a JSON-string that parses to `string[]`; a plain string stays a string (`docs/architecture/input-coercion.md` §"Ambiguous unions").

```ts
  it('parses a JSON-string array into the list branch of value', async () => {
    const provider = makeProvider();
    const reg = registerTool(
      buildSetPropertyTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
    );

    await callTool(reg, { path: 'a.md', key: 'tags', value: '["x","y"]' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['x', 'y'], type: 'list' }),
    );
  });

  it('leaves a plain string on the string branch of value', async () => {
    const provider = makeProvider();
    const reg = registerTool(
      buildSetPropertyTool({ registry: makeTestRegistry([{ name: 'v', provider }]) }),
    );

    await callTool(reg, { path: 'a.md', key: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'done', type: 'text' }),
    );
  });

  it('rejects an out-of-enum type at the gate', async () => {
    const reg = registerTool(
      buildSetPropertyTool({ registry: makeTestRegistry([{ name: 'v', provider: makeProvider() }]) }),
    );
    await expect(
      callTool(reg, { path: 'a.md', key: 'k', value: 'v', type: 'timestamp' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'type' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const reg = registerTool(
      buildSetPropertyTool({ registry: makeTestRegistry([{ name: 'v', provider: makeProvider() }]) }),
    );
    await expect(
      callTool(reg, { path: 'a.md', key: 'k', value: 'v', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/set-property.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route set_property tests through the registration gate` with `Refs #112`.

### Task 7: `edit_note`

**Files:** Modify `test/operations/tools/edit-note.test.ts` (14 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2** for every call *except* the `edit_note: disk write failures` block.
- [ ] **Step 2: Annotate the envelope-subject block**

The `buildWithFailingDisk()` block already registers the tool and asserts on
`result.isError` / `result.structuredContent`. Its subject *is* the
`CallToolResult` envelope, so it keeps calling `reg.handler` directly. Add above it:

```ts
  // Intentionally handler-direct on the registration: the subject here is the
  // CallToolResult envelope itself (isError + structuredContent), not the
  // unwrapped payload, so `callTool` would hide what is under test.
```

- [ ] **Step 3: Add the strict tests**

```ts
  it('rejects an unknown key', async () => {
    const { tool } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: 'n.md', content: 'x', append: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('append') }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const { tool } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: 'n.md', content: 'x', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

`buildTool()` already returns `{ tool, reader, writer }` where `tool` is the raw `ITool`, and the file already imports `registerTool` — no change to the fixture is needed.

- [ ] **Step 4: Run** `npx vitest run test/operations/tools/edit-note.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `test(operations): route edit_note tests through the registration gate` with `Refs #112`.

### Task 8: `read_daily`

**Files:** Modify `test/operations/tools/read-daily.test.ts` (9 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2.** `read_daily`'s schema is `z.object({ ...vaultParamShape(registry) })` — in single-vault mode that is the empty object, so **every** input key is unknown.
- [ ] **Step 2: Add the strict tests**

```ts
  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([
      { name: 'v', provider: dailyProvider('Daily/2026-08-28.md'), reader: buildReader([]), graph: makeGraph() },
    ]);
    await expect(
      callTool(registerTool(buildReadDailyTool({ registry })), { vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('rejects an unknown key', async () => {
    const registry = makeTestRegistry([
      { name: 'v', provider: dailyProvider('Daily/2026-08-28.md'), reader: buildReader([]), graph: makeGraph() },
    ]);
    await expect(
      callTool(registerTool(buildReadDailyTool({ registry })), { date: '2026-08-28' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('date') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/read-daily.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route read_daily tests through the registration gate` with `Refs #112`.

### Task 9: `get_vault_overview`

**Files:** Modify `test/operations/tools/get-vault-overview.test.ts` (6 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2.** The existing `registerTool(...).spec.description` assertion at L189 already crosses the gate — leave it as is.
- [ ] **Step 2: Add the strict test**

```ts
  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), provider: makeProvider() }]);
    await expect(
      callTool(registerTool(buildGetVaultOverviewTool({ registry })), { vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/get-vault-overview.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route get_vault_overview tests through the registration gate` with `Refs #112`.

### Task 10: `list_tags`

**Files:** Modify `test/operations/tools/list-tags.test.ts` (5 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2.** `expect(await tool.handler({})).toEqual({...})` becomes `expect(await callTool(reg, {})).toEqual({...})`.
- [ ] **Step 2: Add the strict test**

```ts
  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', provider: makeProvider() }]);
    await expect(
      callTool(registerTool(buildListTagsTool({ registry })), { vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/list-tags.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route list_tags tests through the registration gate` with `Refs #112`.

### Task 11: `get_note_links`

**Files:** Modify `test/operations/tools/get-note-links.test.ts` (5 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2.**
- [ ] **Step 2: Add the strict and bound tests**

```ts
  it('rejects an empty path at the gate', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeGraph() }]);
    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: '' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'path' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', graph: makeGraph() }]);
    await expect(
      callTool(registerTool(buildGetNoteLinksTool({ registry })), { path: 'A.md', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/get-note-links.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route get_note_links tests through the registration gate` with `Refs #112`.

### Task 12: `remove_property`

**Files:** Modify `test/operations/tools/remove-property.test.ts` (5 call sites)

- [ ] **Step 1: Run the shared cycle steps 1–2.**
- [ ] **Step 2: Add the strict tests**

```ts
  it('rejects a missing key at the gate', async () => {
    const registry = makeTestRegistry([{ name: 'v', provider: makeProvider() }]);
    await expect(
      callTool(registerTool(buildRemovePropertyTool({ registry })), { path: 'a.md' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'key' }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const registry = makeTestRegistry([{ name: 'v', provider: makeProvider() }]);
    await expect(
      callTool(registerTool(buildRemovePropertyTool({ registry })), {
        path: 'a.md',
        key: 'k',
        vault: 'v',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

- [ ] **Step 3: Run** `npx vitest run test/operations/tools/remove-property.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(operations): route remove_property tests through the registration gate` with `Refs #112`.

### Task 13: `list_properties` — a file the suite never had

**Files:** Create `test/operations/tools/list-properties.test.ts`

`list_properties` is the one operations tool with no dedicated test file (`test/operations/tools.test.ts` only asserts it is registered), so "per-tool coverage" is otherwise false for it.

- [ ] **Step 1: Write the file**

```ts
import { describe, expect, it, vi } from 'vitest';

import { buildListPropertiesTool } from '../../../src/modules/operations/tools/list-properties.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import { makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildReg(names: string[] = ['v']) {
  const registry = makeTestRegistry(
    names.map((name) => ({
      name,
      provider: makeProvider({
        listProperties: vi.fn().mockResolvedValue([{ name: 'status', count: 2 }]),
      }),
    })),
  );
  return registerTool(buildListPropertiesTool({ registry }));
}

describe('list_properties through the registration gate', () => {
  it('returns the vault-scoped property list', async () => {
    expect(await callTool(buildReg(), {})).toEqual({
      vault: 'v',
      results: [{ name: 'status', count: 2 }],
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(buildReg(), { vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });

  it('accepts a vault argument in multi-vault mode', async () => {
    const out = await callTool<{ vault: string }>(buildReg(['a', 'b']), { vault: 'b' });
    expect(out.vault).toBe('b');
  });

  it('rejects an unknown key', async () => {
    await expect(callTool(buildReg(), { prefix: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('prefix') }] },
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/operations/tools/list-properties.test.ts`

Expected: PASS, 4 tests. If the shape assertion in the first test fails, read `src/modules/operations/tools/list-properties.ts` and match its actual payload rather than changing the tool.

- [ ] **Step 3: Commit** `test(operations): cover list_properties through the registration gate` with `Refs #112`.

### Task 14: Close out PR 2

**Sequential — after Tasks 4–13.**

- [ ] **Step 1: Confirm no test enters past the gate**

Run: `grep -rn '\.handler(' test/operations/tools/`
Expected: only the `edit_note` `WRITE_FAILED` block, which carries the comment added in Task 7 Step 2.

- [ ] **Step 2: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 3: Open PR 2**

```bash
gh pr create --base main --title "test(operations): route the remaining operations tests through the gate" --body "$(cat <<'BODY'
Second of four PRs for #112. Migrates the nine remaining files in
test/operations/tools/ to `callTool`, adds a list_properties suite (the one
operations tool with no test file), and adds the coverage the suite never had:
per-tool coercion, strict unknown-key rejection, and rejection of a `vault`
argument in single-vault mode.

Refs #112

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Task 15: Convert `runSearch` (PR 3 foundation)

**Files:**
- Modify: `test/semantic/tools/_helpers.ts:286-293`

**Interfaces:**
- Consumes: `callTool` from `test/_gate.ts`.
- Produces: `runSearch` keeps its exact current signature and `Promise<SearchNotesOutput>` return type, so its ~120 call sites are untouched.

**Sequential — Tasks 16–19 depend on it.**

- [ ] **Step 1: Change the call inside `runSearch`**

Replace:

```ts
  try {
    const tool = buildSearchNotesTool(deps);
    return (await tool.handler(opts.input)) as SearchNotesOutput;
  } finally {
    await cleanup();
  }
```

with:

```ts
  try {
    const reg = registerTool(buildSearchNotesTool(deps));
    return await callTool<SearchNotesOutput>(reg, opts.input);
  } finally {
    await cleanup();
  }
```

adding `import { registerTool } from '../../../src/lib/tool-registry.js';` and
`import { callTool } from '../../_gate.js';` at the top.

- [ ] **Step 2: Run the whole semantic suite before touching any test file**

Run: `npx vitest run test/semantic/`
Expected: PASS. One helper change now routes ~120 call sites through the gate; any failure here is a real finding about `search_notes`'s advertised schema. Triage each: a `SearchNotesInput` field the tests pass but the schema does not declare is a bug in the test input or a genuine gap in the schema — report it rather than relaxing `.strict()`.

- [ ] **Step 3: Commit**

```bash
git add test/semantic/tools/_helpers.ts
git commit -m "test(semantic): route runSearch through the registration gate

Refs #112"
```

## Tasks 16–19: Semantic test files (PR 3)

**Parallel-safe.** These four tasks touch disjoint files. Each follows the same
cycle as Tasks 4–13: add the two imports, replace `buildXTool(deps).handler(args)`
with `callTool<Out>(registerTool(buildXTool(deps)), args)`, run the file, triage,
commit with `Refs #112`.

### Task 16: `search-notes-hybrid.test.ts`

**Files:** Modify `test/semantic/tools/search-notes-hybrid.test.ts` (44 direct calls)

- [ ] **Step 1:** Run the shared cycle. Leave the existing `reg.spec.inputSchema` axis assertions (roughly L769-778, L1052-1053) exactly as they are — they already assert against the wrapped schema.
- [ ] **Step 2:** Run `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts` — expect PASS.
- [ ] **Step 3:** Commit `test(semantic): route search_notes hybrid tests through the gate` with `Refs #112`.

### Task 17: `search-notes.test.ts`

**Files:** Modify `test/semantic/tools/search-notes.test.ts` (32 direct calls)

- [ ] **Step 1:** Run the shared cycle. The `registerTool(tool).spec.description` helper at L1297-1301 and the `spec` assertion at L1381 stay as they are.
- [ ] **Step 2:** Run `npx vitest run test/semantic/tools/search-notes.test.ts` — expect PASS.
- [ ] **Step 3:** Commit `test(semantic): route search_notes tests through the gate` with `Refs #112`.

### Task 18: `get-similar-notes.test.ts` and `find-duplicates.test.ts`

**Files:** Modify `test/semantic/tools/get-similar-notes.test.ts` (19), `test/semantic/tools/find-duplicates.test.ts` (6)

- [ ] **Step 1:** Run the shared cycle on both. `get-similar-notes.test.ts` already has SDK-gate coercion cases at L566-581 — keep them.
- [ ] **Step 2:** Add the single-vault `vault` rejection to each file:

```ts
  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(reg, { path: 'Notes/a.md', vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
```

(For `find_duplicates`, drop the `path` argument — its schema has no required path; check `src/modules/semantic/tools/find-duplicates.ts` for the required fields and supply exactly those.)

- [ ] **Step 3:** Run `npx vitest run test/semantic/tools/get-similar-notes.test.ts test/semantic/tools/find-duplicates.test.ts` — expect PASS.
- [ ] **Step 4:** Commit `test(semantic): route get_similar_notes and find_duplicates through the gate` with `Refs #112`.

### Task 19: `search-notes-filter.test.ts` and `search-notes-e2e.test.ts`

**Files:** Modify `test/semantic/tools/search-notes-filter.test.ts` (14), `test/semantic/tools/search-notes-e2e.test.ts` (4)

- [ ] **Step 1:** Run the shared cycle on both.
- [ ] **Step 2:** Run `npx vitest run test/semantic/tools/search-notes-filter.test.ts test/semantic/tools/search-notes-e2e.test.ts` — expect PASS.
- [ ] **Step 3:** Commit `test(semantic): route the remaining search_notes suites through the gate` with `Refs #112`.

### Task 20: Close out PR 3

**Sequential — after Tasks 16–19.**

- [ ] **Step 1:** Run `grep -rn '\.handler(' test/semantic/tools/` — expect no output, or only envelope-subject call sites each carrying a comment.
- [ ] **Step 2:** Run `npm test && npm run lint && npm run typecheck` — expect all pass.
- [ ] **Step 3:** Open PR 3:

```bash
gh pr create --base main --title "test(semantic): route the semantic tool tests through the gate" --body "$(cat <<'BODY'
Third of four PRs for #112. Converts `runSearch` (~120 call sites behind it) and
the six files in test/semantic/tools/ to reach tools through the registration,
so the repo-wide rule PR 4 records has no exception.

Refs #112

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Task 21: ADR-0015

**Files:**
- Create: `docs/adr/0015-input-gate-owns-schema-validation.md`
- Modify: `docs/adr/INDEX.md`

- [ ] **Step 1: Write the ADR from the template**

Follow `docs/adr/0000-template.md`. Content:

- **Status**: Accepted. **Date**: the date of the commit.
- **Context**: `registerTool` wraps every schema with coercion and `.strict()` and rejects violations as `INVALID_PARAMS` before the handler runs, while ADR-0003's Decision paragraph directs handlers to "validate input and throw `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input". Both instructions were followed, so `read_notes` grew four post-gate checks that no call could reach, and the test suite kept them green by calling handlers directly.
- **Decision**: zod owns every constraint a schema can express — type, enum, bound, unknown key, coercion — and its failures reach the client as `INVALID_PARAMS` with `details.issues`. `INVALID_ARGUMENT` is reserved for semantic argument faults a schema cannot express (exactly-one-of `name`/`path`, path traversal, list items containing commas, a value that does not match its declared `type`). A handler MUST NOT re-check what its schema already states. Tool tests reach tools through `registerTool`, never through `buildXTool(...).handler`.
- **Consequences**: one code per failure class, so a client can branch; the same rule the MCP SDK enforces; unreachable validation becomes visible because the tests cross the same seam. Refines ADR-0003 without superseding it — the `ToolHandlerError` envelope is unchanged.
- **Alternatives considered**: loosening schemas so the handler checks become reachable (moves validation off the layer the SDK also enforces, and drops `details.issues`); renaming one code to the other (a breaking contract change for no gain).

- [ ] **Step 2: Add the INDEX rows**

Append the 0015 row to the table in `docs/adr/INDEX.md`, and extend the 0003 row's Status cell to `Accepted; refined by [0015](0015-input-gate-owns-schema-validation.md)` — matching the formatting the 0001 row already uses for a partial supersession.

- [ ] **Step 3: Run** `npm run format` — expect PASS (prettier formats markdown tables).
- [ ] **Step 4: Commit** `docs(adr): record that the input gate owns schema validation` with `Refs #112`.

## Task 22: Correct the architecture pages

**Files:**
- Modify: `docs/architecture/mcp-server-shape.md` §"Tool handler contract" (L52-60)
- Modify: `docs/architecture/input-coercion.md`

- [ ] **Step 1: Fix `mcp-server-shape.md`**

Its first bullet currently reads "Validates and normalizes its input (paths, queries, thresholds) and throws `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input" — with no mention of the gate that rejected malformed input two frames earlier. Replace it with a paragraph describing the gate (`registerTool` wraps the schema with `wrapSchemaWithCoercion`, which coerces then `.strict()`-closes it; `safeParse` failures become `INVALID_PARAMS` with `details.issues` before the handler runs) followed by a bullet saying handlers throw `INVALID_ARGUMENT` only for semantic faults the schema cannot express, with the four current examples. Cite ADR-0015.

- [ ] **Step 2: Add the testing-seam rule to the same section**

The section already ends with "Tests inject mocks; runtime injects the real implementations." Extend it: tool tests reach a tool through `registerTool(buildXTool(deps))` and the `callTool` / `expectToolError` helpers in `test/_gate.ts`, never through `buildXTool(deps).handler` — a handler-direct call enters past coercion, `.strict()`, and `INVALID_PARAMS`, so it can pin behaviour production does not have.

- [ ] **Step 3: Add the `.strict()` sentence to `input-coercion.md`**

Its "What it is" section describes the wrapper as coercion only. Add that `wrapSchemaWithCoercion` also returns `z.object(shape).strict()`, so unknown keys are **rejected**, not stripped — including a `vault` key against a single-vault server, where `vaultParamShape` contributes no `vault` parameter at all. Cross-link `mcp-server-shape.md`.

- [ ] **Step 4: Run** `npm run format && npm run lint` — expect PASS.
- [ ] **Step 5: Commit** `docs(architecture): describe the tool input gate and its testing seam` with `Refs #112`.

## Task 23: `AGENTS.md` and a docs sweep

**Files:**
- Modify: `AGENTS.md` §"Run / check"
- Possibly modify: files found by the sweep in Step 2

- [ ] **Step 1: Add the one-line rule**

Append to the `AGENTS.md` §"Run / check" bullet list:

```markdown
- Tool tests reach a tool through `registerTool(buildXTool(deps))` and the `callTool` / `expectToolError` helpers in [`test/_gate.ts`](test/_gate.ts) — never `buildXTool(deps).handler`. The registration gate coerces, closes the schema with `.strict()`, and fails as `INVALID_PARAMS`; a handler-direct call enters past all three. See [ADR-0015](docs/adr/0015-input-gate-owns-schema-validation.md).
```

- [ ] **Step 2: Sweep all of `docs/` for the same wrong claim**

Run: `grep -rn "INVALID_ARGUMENT" docs/ README.md`

An architecture-scoped grep alone misses the model-facing `docs/guide/` layer. For each hit, decide whether it describes a semantic fault (correct, leave it) or a schema-shaped one — wrong type, out-of-enum value, out-of-range bound, unknown key (fix to `INVALID_PARAMS`).

- [ ] **Step 3: Run** `npm run format && npm run lint` — expect PASS.
- [ ] **Step 4: Commit** `docs: record the gate-routed test convention` with `Refs #112`.

## Task 24: Verify, archive, and close

**Sequential — last task.**

- [ ] **Step 1: Run the full acceptance list**

```bash
npm test && npm run lint && npm run typecheck && npm run format && openspec validate --all
```

Expected: all pass. Then confirm each of the four acceptance conditions from `design.md` §"Migration Plan":

```bash
grep -rn '\.handler(' test/operations/tools/ test/semantic/tools/
grep -rn "validateReadNotesInput\|VALID_CONTENT_MODES" src/ test/
```

Expected: the first returns only commented envelope-subject call sites; the second returns nothing.

- [ ] **Step 2: Run `/opsx:verify`** for this change, then write `retrospective.md`.
- [ ] **Step 3: Run `/opsx:archive`** — this syncs `specs/read-notes-content-modes/spec.md` and `specs/tolerant-arguments/spec.md` into `openspec/specs/` and moves the change directory under `openspec/changes/archive/`.
- [ ] **Step 4: Run** `openspec validate --all` again after the sync — expect PASS.
- [ ] **Step 5: Open PR 4**

```bash
gh pr create --base main --title "docs: record the tool input gate contract" --body "$(cat <<'BODY'
Last of four PRs for #112. Adds ADR-0015 (zod owns schema validation and fails
as INVALID_PARAMS; INVALID_ARGUMENT is reserved for semantic faults a schema
cannot express), corrects the two architecture pages that described the old
split, adds the one-line rule to AGENTS.md, and archives the opsx change —
syncing the read-notes-content-modes and tolerant-arguments spec deltas.

Closes #112

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```
