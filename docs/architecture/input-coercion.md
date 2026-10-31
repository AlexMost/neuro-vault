# Input Coercion (MCP tool params)

How tool input is reshaped at the boundary so realistic MCP-client stringification does not turn unambiguous calls into `INVALID_PARAMS`.

## What it is

A single shared layer in `src/lib/input-coercion.ts` that the tool registry wraps around every tool's `inputSchema` before validation. For each top-level field on the schema, it inspects the declared type and, if the incoming value is a string that has an obvious target shape, converts it before zod sees it. When conversion is intended but impossible, the layer raises a `CoerceError` whose message is surfaced as a `custom` zod issue — `tool-registry.ts` then turns the validation failure into a `ToolHandlerError('INVALID_PARAMS', …)` with the field name, what was expected, and what arrived.

The wrapper lives in one place — `wrapSchemaWithCoercion` — so coercion is a property of the dispatcher, not of any individual tool definition.

Coercion is not all it does. `wrapSchemaWithCoercion` returns `z.object(shape).strict()`, so the object it hands to zod is **closed**: an unknown key is *rejected* with `INVALID_PARAMS`, not silently stripped. That includes a `vault` key sent to a single-vault server — `vaultParamShape` (`src/lib/vault-param.ts`) contributes a `vault` parameter only when the registry is multi-vault, so on a single-vault server the key is not merely ignored, it is not part of the schema at all. Leniency is therefore about the *shape of a value*, never about which fields exist: the declared schema is the whole contract, and [`mcp-server-shape.md`](./mcp-server-shape.md) describes the gate this wrapper sits inside.

## Why it exists

Some MCP clients (and intermediate runtimes) serialize every tool argument as a string, even when the schema declares the field as `number`, `boolean`, `object`, or `string[]`. The agent's intent is unambiguous in all of these cases:

- `limit: "5"` clearly means `5`.
- `filter: '{"x":1}'` clearly means `{x:1}`.
- `include_content: "true"` clearly means `true`.
- `paths: '["a.md","b.md"]'` clearly means `["a.md","b.md"]`.

Without coercion, every such call returns the same generic zod error, and the agent has no signal that the schema is the contract — only that "the tool is broken." Adding `z.preprocess` per field would (a) bloat each tool, (b) leave room for drift between tools, (c) not solve the error-shape problem. A central wrapper keeps the rule global by construction.

The companion goal is **error legibility**: when coercion cannot succeed, the resulting `INVALID_PARAMS` message must name the field, the expected shape, and the offending value, so the LLM can self-correct on the first retry instead of falling back to `Read`/`Glob` workarounds.

## Coverage

The layer walks the **top-level** input object (`z.object({...})`) and, for each declared field present in the input, applies one of the rules below. `z.optional`, `z.nullable`, `z.default` are unwrapped first, then re-applied around the coerced field in their original order, each with its own `.describe()`/`.meta()` metadata — the registry advertises the wrapped schema, so a field description must survive the rebuild. One loss is zod's, not ours: an input-mode JSON Schema omits `default` for any transforming schema, so a `z.default` value is honoured at parse time but not advertised.

| Schema leaf                          | Coerced from         | Coerced to                                                                                                                                  | If the conversion fails                                                 |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `z.number()`                         | non-empty string     | `Number(value)` if finite                                                                                                                   | `CoerceError` → `INVALID_PARAMS` with the offending value               |
| `z.boolean()`                        | `"true"` / `"false"` | `true` / `false`                                                                                                                            | `CoerceError` if the string is anything else                            |
| `z.object({...})` or `z.record(...)` | string               | `JSON.parse(value)` if the result is a plain object — its contents kept as parsed                                                           | `CoerceError` with parse failure or shape mismatch                      |
| `z.array(...)`                       | string               | `JSON.parse(value)` if the result is an array, then each element by the beneath-an-array rules                                             | `CoerceError` with parse failure or shape mismatch                      |
| `z.array(...)` / `z.tuple([...])`    | array                | each element by the beneath-an-array rules                                                                                                  | as for that element                                                     |
| `z.union([..., z.array(X), ...])`    | string               | `JSON.parse(value)` if the result is an array whose every element is a string or a plain object, taken to be the first array branch whose element `X` can hold every one of them; then each element by the beneath-an-array rules | left unchanged if the string is not such a JSON array; once parsed, an element's failure is a `CoerceError` |
| `z.union([...])`                     | array                | unchanged if some branch already accepts it; else each element by the beneath-an-array rules of the first array or tuple branch             | as for that element                                                     |

A top-level object field is never descended into: an object value, or one parsed from a JSON-string, reaches zod with its contents exactly as sent. So `search_notes.filter: { tags: '["a"]' }` still fails `INVALID_PARAMS`, and `filter.path_prefix: '["A/","B/"]'` stays one literal prefix string. A non-array, non-string union value is left alone.

**Beneath an array** — an array element, then a declared key of an object element, then a tuple item, to any depth — the one conversion is a numeric string to a number:

| Schema there                    | Value            | Result                                                                                                                                         |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `z.number()`                    | non-empty string | `Number(value)` if finite; else `CoerceError`                                                                                                  |
| `z.object({...})`               | plain object     | each declared key by these rules; undeclared keys kept as sent                                                                                 |
| `z.array(...)` / `z.tuple(...)` | array            | each element by these rules (a tuple: its item schema by position, then its rest schema; extras kept as sent)                                  |
| `z.union([...])`                | non-string       | unchanged if some branch already accepts it; else by the first branch it fits structurally (an array → array or tuple, an object → object or record) |
| anything else                   | any              | unchanged: a nested string is never JSON-parsed, a nested `"true"` stays a string, a `z.record` is left alone                                    |

These two rules are the whole of design D4: the union-string rule parses the stringified mixed `read_notes.paths` array — `'["a.md",{"path":"b.md","lines":["3","9"]}]'` arrives as `['a.md', { path: 'b.md', lines: [3, 9] }]` — and the beneath-an-array rule turns the numeric strings of a `lines` pair into numbers, whether the array arrived as JSON or not. `'[1,2]'` and `'not json'` stay strings. Coercion never changes a value's shape otherwise: it never adds, drops, or reorders an element or a key, so a short `lines` pair, an extra item key, or an inverted range still reaches zod as sent and fails there.

## Predicting realistic stringification

When designing a new tool, assume any field may arrive as a string from a client that flattens its arguments. Concretely:

- Numeric and boolean fields will sometimes arrive quoted. The layer covers this.
- Object/record fields will sometimes arrive as a JSON-string. The layer covers this, but not the values inside them.
- An array field, or the array branch of a `string | X[]` union (for "single or many" ergonomics), will sometimes arrive as a JSON-string, and its elements may themselves be strings, objects, or a mix (`read_notes.paths` items). The layer covers this.
- Numbers beneath an array (a `lines: [start, end]` pair in a `paths` item) will sometimes arrive quoted. The layer covers this. Nested booleans and nested JSON-strings are **not** covered: a value nested in a top-level object, or a quoted array or object beneath an array, reaches zod as sent.

If a tool needs another shape coerced, prefer adding a new explicit rule here over working around it inside the tool — coercion belongs at the boundary, not inside the handler.

## Out of scope (by design)

- **Recursion outside an array.** The contents of a top-level object or record field are not coerced, whether it arrived as an object or a JSON-string: `filter: '{"limit":"5"}'` keeps `"5"`, and `search_notes.filter.tags: '["a"]'` stays a string. Beneath an array, only numeric strings become numbers; nothing nested is JSON-parsed, and a `z.record` is left alone.
- **Ambiguous unions.** When a string is itself a valid value for some branch (e.g. `set_property.value: string | number | boolean`), the raw string wins; the one exception is the union-string rule above, where a JSON array is taken to be the array branch. A non-string value that some branch already accepts is likewise left alone (`['1', '2']` for `number[] | string[]` stays strings). The layer never tries to guess which branch the agent meant.
- **Reverse coercion.** `number → string` and similar are not performed. Coercion is one-directional — toward the strict declared type.
- **Per-tool customization.** The wrapper has no escape hatch for tool-specific rules. If a rule is needed, it goes here so every tool inherits it.

## Error path

When coercion is intended but fails, the layer raises `CoerceError(fieldName, bareMessage, path)`, where `path` is the value's place below the field (`[1, 'lines', 0]`, empty for the field itself). The wrapper catches this inside `z.preprocess`, calls `ctx.addIssue({ code: 'custom', message: bareMessage, path })`, and returns `z.NEVER` to short-circuit the inner schema — so a nested failure is reported at `paths.1.lines.0`, the way zod reports its own nested issues. `tool-registry.ts` then formats every issue as `<path>: <message>` and produces:

```ts
ToolHandlerError('INVALID_PARAMS', message, { details: { issues: [{ path, message, expected? }] } })
```

The MCP response carries `code`, `message`, and `details.issues` so machine callers can branch per field. The bare message lives on `CoerceError.bareMessage` so the path-prefix added by the formatter does not duplicate the field name (`filter: filter: …`).

## Boundaries

- The coercion module has no dependence on the tool registry; it is a pure function over `(ZodTypeAny, value)` pairs and is tested in isolation in `test/lib/input-coercion.test.ts`.
- The tool registry calls the wrapper exactly once per registered tool, at registration time. The MCP SDK validates against the wrapped schema, so coercion is applied along whichever path the SDK takes — there is no "outside the dispatcher" code path.
- The strict-typed contract is unchanged: callers passing the declared types continue to work without any coercion firing. Coercion is a one-way fallback that tightens, never loosens, the data the handler sees.
