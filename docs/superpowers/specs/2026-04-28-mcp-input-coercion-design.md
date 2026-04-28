# Lenient Input Coercion for MCP Tool Params

Status: design
Date: 2026-04-28
Supersedes: —

## Problem

Some MCP clients (and intermediate runtimes) serialize every tool-call argument as a string, even when the tool's schema declares the parameter as a `number`, `boolean`, or `object`. The result is a stream of `INVALID_PARAMS` errors on calls whose intent is unambiguous:

```
search_notes:  limit: expected number, received string
query_notes:   filter: expected record, received string
search_notes:  threshold: expected number, received string
```

This was observed live in the 2026-04-27 session against `search_notes` and `query_notes` from a known-good caller. The agent has to fall back to `Glob`/`Read` workarounds. The bug is on the wire format, not in the LLM's logic — but the user-visible effect is "the tool is broken".

A second pain point: when zod rejects the input, the error currently bubbles through `invokeTool` as `error.message` on a generic `Error`, producing the raw multi-line zod dump in `structuredContent.message` with no `code` field. Callers cannot distinguish a validation error from any other failure.

## Goal

1. Accept stringified primitives where the schema clearly expects a primitive, and stringified JSON where the schema expects a record/object. Coerce in **one** place — the central tool dispatcher — not per-tool.
2. When validation still fails after coercion, return a clean `ToolHandlerError('INVALID_PARAMS', …)` so callers see `{ code: 'INVALID_PARAMS', message, details }` instead of a raw zod dump.

## Non-goals

- No reverse coercion (`number → string`, `object → JSON string`).
- No nested coercion inside arrays-of-objects, and no recursion into `z.record`/`z.unknown` values. Filter contents (`{tags: 'x'}`) are passed through untouched once the outer string has been parsed.
- No change to the public contract: strict-typed callers continue to work unchanged. Coercion is a one-way fallback that tightens, never loosens, the data the handler sees.
- No coercion for ambiguous unions (e.g. `set_property.value: string | number | boolean | …`). When the schema accepts the raw shape as-is, the raw shape wins.

## Decision

### Coercion rules

The dispatcher walks the **top-level** input schema (`z.object({...})`) and, for each declared field present in the input, applies one of the following based on the field's declared type. `z.optional`, `z.nullable`, `z.default` are unwrapped first.

| Schema leaf                          | Input shape          | Coerced to                                    | If coercion impossible       |
| ------------------------------------ | -------------------- | --------------------------------------------- | ---------------------------- |
| `z.number()` (any constraints)       | non-empty `string`   | `Number(value)` if finite                     | leave as-is, zod will reject |
| `z.boolean()`                        | `"true"` / `"false"` | `true` / `false`                              | leave as-is, zod will reject |
| `z.object({...})` or `z.record(...)` | `string`             | `JSON.parse(value)` if result is plain object | leave as-is, zod will reject |

For nested `z.object({...})` (e.g. `query_notes.sort`): if a coerced object emerges, the dispatcher does **not** recurse into its fields. The spec is "lenient at the boundary, strict thereafter". One pass, one level. Adding deeper recursion is a future spec if the need arises.

For `z.union([...])`: the dispatcher does not try to be clever. If any option in the union accepts the raw value, the value passes through. Concretely: `search_notes.query` is `string | string[]` — both shapes are common; no coercion needed.

For `z.array(...)`: only string-to-array JSON parse, no per-item coercion. (Out of scope per spec; `read_notes.paths` already accepts arrays natively.)

### Error mapping

`tool-registry.ts` uses `safeParse`. On failure it raises:

```ts
throw new ToolHandlerError('INVALID_PARAMS', formatIssues(result.error), {
  details: { issues: result.error.issues.map(formatIssue) },
});
```

`formatIssues` produces a one-line summary like `filter: expected object or JSON string; limit: expected number or numeric string`. `details.issues` carries a structured array `[{ path, message, expected }]` so machine callers can distinguish per-field problems.

### Why central, not per-schema

Adding `z.preprocess` per field would (a) bloat every tool definition, (b) leave room for drift between tools, (c) not solve the error-wrapping problem. The dispatcher already calls `inputSchema.parse(args)` in exactly one place — extending that call site keeps the coercion rule global by construction.

## Implementation

### Files touched

- `src/lib/input-coercion.ts` (new) — `coerceInput(schema, value)` walking zod 4 schemas (`ZodObject.shape`, `ZodOptional/Nullable/Default._def.innerType`, `ZodNumber`, `ZodBoolean`, `ZodObject`, `ZodRecord`, `ZodArray`).
- `src/lib/tool-registry.ts` — call `coerceInput` before `safeParse`; wrap zod failure in `ToolHandlerError('INVALID_PARAMS', …)`.
- `test/lib/input-coercion.test.ts` (new) — covers each coercion rule + edge cases (empty string, unparseable JSON, JSON that parses to an array, NaN).
- `test/lib/tool-registry.test.ts` — add cases for: end-to-end coercion of a `limit: "5"` style call; INVALID_PARAMS error mapping when coercion is impossible.
- `README.md` — short "Lenient input coercion" note in the MCP-client section.
- `docs/architecture/` — no new file; coercion lives entirely inside the dispatcher and does not introduce a new architectural concept worth its own page. The dictionary in `AGENTS.md` is unchanged.

### Coercion module surface

```ts
export function coerceInput(schema: ZodTypeAny, value: unknown): unknown;
```

Pure function, no side effects, no dependence on the tool registry. Tested in isolation.

## Tests

Per the Obsidian task's test list, plus error-wrapping coverage:

- [x] `limit: "5"` coerced to `5`; same result as `limit: 5`.
- [x] `limit: "abc"` → `INVALID_PARAMS` (zod still rejects post-coercion).
- [x] `filter: '{"tags":"x"}'` coerced to `{tags: "x"}`.
- [x] `filter: 'not json'` → `INVALID_PARAMS` with `details.issues[].expected` mentioning `object`.
- [x] `expansion: "true"` coerced to `true` (and analogous for `include_content`, `overwrite`).
- [x] Strict-typed callers (`limit: 5`, `filter: {tags: "x"}`) continue to pass without change — regression guard.
- [x] `set_property.value: "5"` stays as the string `"5"` (union accepts strings; coercion does not fire).
- [x] `query: ["a", "b"]` stays as array (union of string|string[]); no coercion fires.
- [x] `INVALID_PARAMS` error response carries `code`, `message`, and `details.issues` array.

## Release

- Single Conventional Commit: `feat: coerce primitive types in MCP tool params`. Minor bump (additive — strict callers unchanged, lenient callers now succeed).
- `CHANGELOG.md` entry under "Features" only.
- Release flow per `AGENTS.md`: PR → merge to `main` → `npm run release` on `main` → `git push --follow-tags`.

## Definition of Done

- Coercion lives in one shared layer (`src/lib/input-coercion.ts`), not duplicated in tool schemas.
- All `number`, `boolean`, and `record/object` parameters across all currently-registered tools are covered, verified by the dispatcher walking each tool's schema.
- Validation failures return `ToolHandlerError('INVALID_PARAMS', message, { details: { issues } })` — no raw zod dumps.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- README mentions the lenient behaviour so callers know stringified primitives are accepted.
- A patch / minor version is published per the AGENTS.md release flow.
