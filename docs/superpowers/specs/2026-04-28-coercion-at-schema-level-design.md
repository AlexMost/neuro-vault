# Apply Lenient Input Coercion at the Schema Level

Status: design
Date: 2026-04-28
Supersedes: [2026-04-28-mcp-input-coercion-design.md](./2026-04-28-mcp-input-coercion-design.md)

## Problem

The 3.2.0 lenient-input-coercion implementation is dead code on the live MCP path. Reproduced in the 2026-04-28 session against `query_notes`:

```jsonc
// args sent
{
  "filter": "{\"frontmatter.status\": \"evergreen\", \"frontmatter.type\": \"note\"}",
  "limit": "5",
  "include_content": "false"
}

// response
Invalid arguments for tool query_notes:
- filter: expected record, received string
- limit: expected number, received string
- include_content: expected boolean, received string
```

The error message format is the MCP SDK's, not ours — `Invalid arguments for tool ${name}: ${zodErrorMessage}` (`McpError(ErrorCode.InvalidParams, ...)`). This proves the SDK is rejecting the call before our dispatcher runs.

Tracing the SDK call path (`@modelcontextprotocol/sdk/dist/esm/server/mcp.js`):

```
CallToolRequestSchema handler
 └─ args = await this.validateToolInput(tool, request.params.arguments, name)
     └─ safeParseAsync(tool.inputSchema, args)        ← rejects here
 └─ this.executeToolHandler(tool, args, extra)        ← never runs
     └─ our `cb` (registration.handler)
         └─ coerceInput(...) + safeParse(...)         ← never runs either
```

The previous spec assumed we owned the validation step. We don't — the SDK validates first, against the same `inputSchema` we hand it. Coercion has to live **on the schema itself**, not in code that runs after validation.

## Goal

Move lenient coercion from the dispatcher into the schema, so the SDK's own `safeParseAsync` accepts stringified primitives and JSON-stringified objects. Keep the JSON-schema advertised to clients clean (no `unknown` / `anyOf` blow-up for fields that previously advertised as `number`/`boolean`/`object`).

## Non-goals

- No public API changes. Tool authors continue to write plain `z.object({ ... })` schemas with `z.number()`, `z.boolean()`, `z.record()`, etc. — the registry transforms them on registration.
- No new coercion rules beyond those already specified in the previous design (string→number, "true"/"false"→boolean, JSON string→record/object).
- No cross-field or nested-object coercion. Same one-pass, top-level rule as before.

## Decision

### Wrap each field with `z.preprocess`

In `registerTool`, before handing the schema to the SDK, walk `inputSchema.shape` and rebuild it as a new `z.object({ ... })` whose fields are `z.preprocess(coerceFn, innerNonOptional)` — re-wrapped in `.optional()` if the original was optional.

```ts
function wrapSchemaWithCoercion(schema: ZodTypeAny): ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const newShape: Record<string, ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    newShape[key] = wrapField(field as ZodTypeAny);
  }
  return z.object(newShape);
}

function wrapField(field: ZodTypeAny): ZodTypeAny {
  let inner = field;
  let isOptional = false;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    if (inner instanceof z.ZodOptional) isOptional = true;
    inner = inner.unwrap();
  }
  const wrapped = z.preprocess((v) => coerceFieldValue(inner, v), inner);
  return isOptional ? wrapped.optional() : wrapped;
}
```

`coerceFieldValue` is the same logic the existing dispatcher used per field (number/boolean/record), extracted from `coerceInput` and exported.

### Why this preserves the JSON schema

Probed against `zod@4.3.6` + `zod/v4-mini.toJSONSchema` (the SDK's converter for v4):

| Field source                                                                  | Advertised JSON schema                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `z.preprocess(fn, z.number().int().min(1).max(1000))`                         | `{type: integer, minimum:1, maximum:1000}`                     |
| `z.preprocess(fn, z.boolean())`                                               | `{type: boolean}`                                              |
| `z.preprocess(fn, z.record(z.string(), z.unknown()))`                         | `{type: object, propertyNames: ..., additionalProperties: {}}` |
| `z.preprocess(fn, z.number().int().optional())` (optional re-wrapped outside) | `{type: integer, minimum:1, ...}`, NOT in `required`           |

The optional must be on the **outside** of the preprocess; otherwise zod's JSON-schema converter still emits the field as required.

### Why central, still

Coercion stays in one shared layer (`src/lib/input-coercion.ts`). Tool authors don't see it — `registerTool` does the transformation centrally. No per-tool drift.

### Error mapping

Unchanged from 3.2.0: when a value can't be coerced (e.g. `limit: "abc"`), the inner schema rejects after preprocess no-ops. `formatZodError` in `tool-registry.ts` continues to emit `INVALID_PARAMS` with `details.issues`. The SDK now surfaces this via its `McpError(InvalidParams, ...)` wrapper around our message — same end-user experience as today, but now reachable for stringified-but-validatable inputs.

## Implementation

- `src/lib/input-coercion.ts` — keep `coerceInput` for backward-compat and direct-call tests. Export `coerceFieldValue(schema, value)` as the per-field primitive (refactored out of the existing `coerceField`). Add `wrapSchemaWithCoercion(schema)`.
- `src/lib/tool-registry.ts`:
  - Compute `wrapped = wrapSchemaWithCoercion(tool.inputSchema)` once per registration.
  - Set `spec.inputSchema = wrapped` so the SDK validates through it.
  - In the registration's `handler`, use `wrapped.safeParse(args)` (no separate `coerceInput` call — redundant, the schema does it).
- Tests:
  - `test/lib/input-coercion.test.ts` — new section covering `wrapSchemaWithCoercion` directly: optional preserved, string→number, JSON string→record, "true"→boolean, untouched union fields, unparseable JSON falls through to schema rejection.
  - `test/lib/tool-registry.test.ts` — new test asserting `reg.spec.inputSchema.safeParse(stringifiedArgs).success === true`. Drop the `expect(reg.spec.inputSchema).toBe(schema)` identity assertion (we now return a wrapped object, not the original).

## Tests

- [x] `query_notes` end-to-end (schema-level): `{filter: '{"a":1}', limit: '5', include_content: 'false'}` → `{filter:{a:1}, limit:5, include_content:false}`.
- [x] `search_notes` end-to-end: `{query:"hello", limit:"3", threshold:"0.35"}` → coerced.
- [x] Optional preserved: omitted optional fields don't end up in `required` of the advertised JSON schema.
- [x] `union` fields untouched: `read_notes.paths` still accepts both string and array (no regression).
- [x] Unparseable values fall through to zod rejection with `INVALID_PARAMS` and a structured `issues` list.

## Release

- Single Conventional Commit: `fix(lib): apply input coercion at the schema level so MCP SDK accepts stringified args`. Patch bump (no behaviour change for strict callers; lenient callers that were broken now succeed).
- `CHANGELOG.md` entry under "Bug Fixes".
- Release flow per AGENTS.md: PR → merge to `main` → `npm run release` on `main`.

## Definition of Done

- `query_notes` accepts the repro shape from the 2026-04-28 session and returns results.
- All existing `coerceInput` tests still pass — the helper is preserved as a public function.
- `wrapSchemaWithCoercion` covered by direct unit tests.
- A registry test proves `spec.inputSchema.safeParse(stringifiedArgs)` succeeds end-to-end.
- `npm test`, `npm run lint`, `npx tsc --noEmit` green.
