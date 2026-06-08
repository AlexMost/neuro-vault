# Tolerant Tool Arguments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP tool-input boundary forgiving — accept the `filters`→`filter` alias on `query_notes`, parse stringified arrays for plain-array params, and name the expected shape on unrecoverable input instead of bare-failing.

**Architecture:** All work lands at the single central coercion seam — `wrapSchemaWithCoercion`/`coerceFieldValue` in `src/lib/input-coercion.ts`, plumbed through `registerTool` in `src/lib/tool-registry.ts`. Aliases are declared per-tool via a new optional `ITool.inputAliases` and applied by a `z.preprocess` that runs _before_ the existing `.strict()` object. No per-tool handler logic; no `.strict()` relaxation.

**Tech Stack:** TypeScript (ESM, strict), zod, vitest. Verify with `npx tsc --noEmit` (authoritative), `npm run lint`, `npm test`.

---

### Task 1: Stringified-array coercion for plain `ZodArray`

**Files:**

- Modify: `src/lib/input-coercion.ts` (add a branch in `coerceFieldValue`, after the union branch at lines 105-118, before the final `return value`)
- Test: `test/lib/input-coercion.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/input-coercion.test.ts`:

```typescript
describe('coerceInput — plain array fields', () => {
  const schema = z.object({
    fields: z
      .array(z.enum(['frontmatter', 'content']))
      .min(1)
      .optional(),
  });

  it('parses a stringified JSON array', () => {
    expect(coerceInput(schema, { fields: '["frontmatter"]' })).toEqual({
      fields: ['frontmatter'],
    });
  });

  it('returns a parsed array verbatim so zod can validate its elements', () => {
    // 'bogus' is not a valid enum value, but coercion only parses the outer
    // string — element validation is left to zod downstream.
    expect(coerceInput(schema, { fields: '["bogus"]' })).toEqual({ fields: ['bogus'] });
  });

  it('throws CoerceError on a non-JSON string', () => {
    expect(() => coerceInput(schema, { fields: 'frontmatter' })).toThrow(CoerceError);
  });

  it('throws CoerceError when the JSON resolves to a non-array', () => {
    expect(() => coerceInput(schema, { fields: '{"a":1}' })).toThrow(CoerceError);
  });

  it('leaves a real array alone', () => {
    expect(coerceInput(schema, { fields: ['content'] })).toEqual({ fields: ['content'] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- input-coercion`
Expected: the four new `fields` cases fail — current code falls through to `return value`, so the string is passed unchanged (no parse, no throw).

- [ ] **Step 3: Add the plain-array branch**

In `src/lib/input-coercion.ts`, insert immediately **after** the union branch (after line 118, before the final `return value;` at line 120):

```typescript
if (inner instanceof z.ZodArray && typeof value === 'string') {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CoerceError(
      fieldName,
      `expected array or JSON-string of one, failed to parse: ${JSON.stringify(value)}`,
    );
  }
  if (Array.isArray(parsed)) return parsed;
  throw new CoerceError(
    fieldName,
    `expected array, parsed JSON resolved to ${describeJsonShape(parsed)}`,
  );
}
```

(`describeJsonShape` already exists at lines 33-37. The `paths` union is a `ZodUnion`, not a `ZodArray`, so this branch never intercepts it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- input-coercion`
Expected: PASS, including the existing union/object cases (regression guard).

- [ ] **Step 5: Commit**

```bash
git add src/lib/input-coercion.ts test/lib/input-coercion.test.ts
git commit -m "feat(coercion): parse stringified arrays for plain-array params"
```

---

### Task 2: `read_notes` boundary tests for stringified `fields`

**Files:**

- Test: `test/operations/tools/read-notes.test.ts`

This task proves Task 1 works end-to-end through the registered tool (the path the MCP SDK takes), covering the spec's "Stringified collections are parsed" and "Unrecoverable arguments fail with a shape-naming message" requirements. `read_notes` is registered via `registerTool`, so `tool.handler` here goes through `coercingSchema.safeParse`.

- [ ] **Step 1: Write the failing tests**

Add to `test/operations/tools/read-notes.test.ts` (it already imports `buildReadNotesTool`, `makeReader`, `makeTestRegistry`, and `registerTool` patterns — mirror the existing setup at the top of that file). Use the registered form so coercion runs:

```typescript
import { registerTool } from '../../../src/lib/tool-registry.js';

it('parses a stringified fields array (coercion via registerTool)', async () => {
  const reader = makeReader({
    readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
  });
  const registry = makeTestRegistry([{ name: 'v', reader }]);
  const reg = registerTool(buildReadNotesTool({ registry }));

  const result = await reg.handler({ paths: 'Folder/n.md', fields: '["frontmatter"]' });

  expect(result.isError).not.toBe(true);
});

it('rejects a bad element in a parsed fields array with INVALID_PARAMS', async () => {
  const reader = makeReader({
    readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
  });
  const registry = makeTestRegistry([{ name: 'v', reader }]);
  const reg = registerTool(buildReadNotesTool({ registry }));

  const result = await reg.handler({ paths: 'Folder/n.md', fields: '["bogus"]' });

  expect(result.isError).toBe(true);
  expect((result.structuredContent as { code: string }).code).toBe('INVALID_PARAMS');
});

it('names the expected shape for a non-array fields string', async () => {
  const reader = makeReader({
    readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
  });
  const registry = makeTestRegistry([{ name: 'v', reader }]);
  const reg = registerTool(buildReadNotesTool({ registry }));

  const result = await reg.handler({ paths: 'Folder/n.md', fields: 'frontmatter' });

  expect(result.isError).toBe(true);
  expect((result.structuredContent as { message: string }).message).toMatch(/array/i);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- read-notes`
Expected: PASS — Task 1's coercion already powers these. (If the first test fails because the handler path differs, confirm `read_notes` is exercised through `registerTool(...).handler`, not the raw `buildReadNotesTool(...).handler` which skips coercion.)

- [ ] **Step 3: Commit**

```bash
git add test/operations/tools/read-notes.test.ts
git commit -m "test(read_notes): cover stringified fields coercion at the tool boundary"
```

---

### Task 3: `inputAliases` on the `ITool` interface + alias preprocess

**Files:**

- Modify: `src/lib/tool-registry.ts:8-16` (interface), `:40` (pass aliases)
- Modify: `src/lib/input-coercion.ts:165-173` (`wrapSchemaWithCoercion` signature + alias preprocess; add `applyAliases` helper)
- Test: `test/lib/tool-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/tool-registry.test.ts`:

```typescript
describe('registerTool — inputAliases', () => {
  const schema = z.object({
    filter: z.record(z.string(), z.unknown()).optional(),
  });
  function makeTool(): ITool<{ filter?: Record<string, unknown> }, { received: unknown }> {
    return {
      name: 'aliased',
      description: 'aliased',
      inputSchema: schema,
      inputAliases: { filters: 'filter' },
      handler: async (input) => ({ received: input.filter }),
    };
  }

  it('renames an alias key to its canonical parameter', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ filters: { a: 1 } });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { received: unknown }).received).toEqual({ a: 1 });
  });

  it('keeps the canonical value when both alias and canonical are present', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ filter: { keep: true }, filters: { drop: true } });
    expect((result.structuredContent as { received: unknown }).received).toEqual({ keep: true });
  });

  it('still rejects a genuinely unknown, non-alias key', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ totally_unknown: 1 });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe('INVALID_PARAMS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tool-registry`
Expected: FAIL — `inputAliases` is not yet on `ITool`, and `filters` currently trips `.strict()` as an unrecognized key.

- [ ] **Step 3: Add `inputAliases` to the `ITool` interface**

In `src/lib/tool-registry.ts`, add to the `ITool` interface (after `inputSchema`, around line 12):

```typescript
  /** Optional map of accepted alias keys → canonical parameter name. An alias is
   *  renamed to its canonical key before strict validation; the canonical value
   *  wins if both are present. Additive only — does not relax unknown-key rejection. */
  inputAliases?: Record<string, string>;
```

- [ ] **Step 4: Thread aliases through `registerTool`**

In `src/lib/tool-registry.ts`, change line 40:

```typescript
const coercingSchema = wrapSchemaWithCoercion(tool.inputSchema, tool.inputAliases);
```

- [ ] **Step 5: Implement the alias preprocess in `wrapSchemaWithCoercion`**

In `src/lib/input-coercion.ts`, add the helper above `wrapSchemaWithCoercion`:

```typescript
function applyAliases(value: unknown, aliases: Record<string, string>): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in out) {
      if (!(canonical in out)) out[canonical] = out[alias];
      delete out[alias];
    }
  }
  return out;
}
```

Then change the signature and return of `wrapSchemaWithCoercion` (lines 165-173):

```typescript
export function wrapSchemaWithCoercion(
  schema: ZodTypeAny,
  aliases?: Record<string, string>,
): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const newShape: Record<string, ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    newShape[key] = wrapField(field, key);
  }
  const strict = z.object(newShape).strict();
  if (!aliases || Object.keys(aliases).length === 0) return strict;
  return z.preprocess((v) => applyAliases(v, aliases), strict);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tool-registry`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tool-registry.ts src/lib/input-coercion.ts test/lib/tool-registry.test.ts
git commit -m "feat(coercion): support declared input aliases at the tool boundary"
```

---

### Task 4: Declare `filters`→`filter` on `query_notes` + boundary test

**Files:**

- Modify: `src/modules/operations/tools/query-notes.ts:75-92` (add `inputAliases` to the returned tool)
- Test: `test/operations/tools/query-notes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/operations/tools/query-notes.test.ts`, exercising the registered tool so the alias preprocess runs:

```typescript
import { registerTool } from '../../../src/lib/tool-registry.js';

it('accepts `filters` as an alias of `filter`', async () => {
  const reader = makeReader({
    scan: vi.fn().mockResolvedValue(['Notes/a.md']),
    readNotes: vi
      .fn()
      .mockResolvedValue([{ path: 'Notes/a.md', frontmatter: { type: 'idea' }, content: '' }]),
  });
  const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);
  const reg = registerTool(buildQueryNotesTool({ registry }));

  const result = await reg.handler({ filters: { 'frontmatter.type': { $eq: 'idea' } } });

  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as { count: number }).count).toBe(1);
});

it('prefers `filter` over a conflicting `filters`', async () => {
  const scan = vi.fn().mockResolvedValue([]);
  const reader = makeReader({ scan, readNotes: vi.fn().mockResolvedValue([]) });
  const registry = makeTestRegistry([{ name: 'v', reader, graph: makeGraph() }]);
  const reg = registerTool(buildQueryNotesTool({ registry }));

  const result = await reg.handler({
    filter: { 'frontmatter.type': { $eq: 'idea' } },
    filters: { 'frontmatter.type': { $eq: 'task' } },
  });

  expect(result.isError).not.toBe(true);
  // canonical `filter` wins; the call succeeds with the `filter` predicate applied
});
```

(Match the existing `makeReader`/`makeGraph`/`makeTestRegistry`/`vi` imports already at the top of `query-notes.test.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- query-notes`
Expected: FAIL — `filters` is rejected as an unrecognized key until the alias is declared.

- [ ] **Step 3: Declare the alias on the tool**

In `src/modules/operations/tools/query-notes.ts`, add `inputAliases` to the returned object (alongside `name`, `title`, `inputSchema`, `handler` at lines 75-92):

```typescript
    inputAliases: { filters: 'filter' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- query-notes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/tools/query-notes.ts test/operations/tools/query-notes.test.ts
git commit -m "feat(query_notes): accept `filters` as an alias of `filter`"
```

---

### Task 5: Document the alias + full verification

**Files:**

- Modify: `docs/architecture/mcp-parameter-dictionary.md`

- [ ] **Step 1: Record the accepted alias**

Open `docs/architecture/mcp-parameter-dictionary.md`, find the `filter` entry, and add a short note that `filters` is an accepted alias of `filter` on `query_notes` (additive; canonical name unchanged, so no major-version bump per ADR-0005). Match the file's existing entry style.

- [ ] **Step 2: Run the full gate**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: all three green — full vitest suite passes (no test-count drop), eslint clean, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/mcp-parameter-dictionary.md
git commit -m "docs(params): record `filters` as an accepted alias of `filter`"
```

---

## Self-Review

- **Spec coverage:**
  - "Declared parameter aliases are accepted" → Task 3 (mechanism) + Task 4 (query_notes alias, conflict rule).
  - "Stringified collections are parsed when unambiguous" → Task 1 (coercion) + Task 2 (`fields` boundary) — the existing `filter`/`paths` cases are covered by the Task 1 regression guard.
  - "Unrecoverable arguments fail with a shape-naming message" → Task 1 (CoerceError messages) + Task 2 (non-array `fields` → shape message).
  - "Unknown non-alias keys remain rejected" → Task 3 (unknown-key test; `.strict()` retained).
- **Placeholder scan:** none — every code step shows the actual code.
- **Type consistency:** `inputAliases?: Record<string, string>` is defined in Task 3 and consumed identically in Tasks 3 (registerTool) and 4 (query_notes); `applyAliases`/`wrapSchemaWithCoercion(schema, aliases?)` signatures match across steps.
