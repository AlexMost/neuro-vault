# Input Coercion (MCP tool params)

How tool input is reshaped at the boundary so realistic MCP-client stringification does not turn unambiguous calls into `INVALID_PARAMS`.

## What it is

A single shared layer in `src/lib/input-coercion.ts` that the tool registry wraps around every tool's `inputSchema` before validation. For each top-level field on the schema, it inspects the declared type and, if the incoming value is a string that has an obvious target shape, converts it before zod sees it. When conversion is intended but impossible, the layer raises a `CoerceError` whose message is surfaced as a `custom` zod issue — `tool-registry.ts` then turns the validation failure into a `ToolHandlerError('INVALID_PARAMS', …)` with the field name, what was expected, and what arrived.

The wrapper lives in one place — `wrapSchemaWithCoercion` — so coercion is a property of the dispatcher, not of any individual tool definition.

## Why it exists

Some MCP clients (and intermediate runtimes) serialize every tool argument as a string, even when the schema declares the field as `number`, `boolean`, `object`, or `string[]`. The agent's intent is unambiguous in all of these cases:

- `limit: "5"` clearly means `5`.
- `filter: '{"x":1}'` clearly means `{x:1}`.
- `include_content: "true"` clearly means `true`.
- `paths: '["a.md","b.md"]'` clearly means `["a.md","b.md"]`.

Without coercion, every such call returns the same generic zod error, and the agent has no signal that the schema is the contract — only that "the tool is broken." Adding `z.preprocess` per field would (a) bloat each tool, (b) leave room for drift between tools, (c) not solve the error-shape problem. A central wrapper keeps the rule global by construction.

The companion goal is **error legibility**: when coercion cannot succeed, the resulting `INVALID_PARAMS` message must name the field, the expected shape, and the offending value, so the LLM can self-correct on the first retry instead of falling back to `Read`/`Glob` workarounds.

## Coverage

The layer walks the **top-level** input object (`z.object({...})`) and, for each declared field present in the input, applies one of the rules below. `z.optional`, `z.nullable`, `z.default` are unwrapped first.

| Schema leaf                           | Coerced from         | Coerced to                                          | If the conversion fails                                                 |
| ------------------------------------- | -------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `z.number()`                          | non-empty string     | `Number(value)` if finite                           | `CoerceError` → `INVALID_PARAMS` with the offending value               |
| `z.boolean()`                         | `"true"` / `"false"` | `true` / `false`                                    | `CoerceError` if the string is anything else                            |
| `z.object({...})` or `z.record(...)`  | string               | `JSON.parse(value)` if the result is a plain object | `CoerceError` with parse failure or shape mismatch                      |
| `z.union([..., z.array(z.string())])` | string               | `JSON.parse(value)` if the result is `string[]`     | left unchanged — the union's other branches (e.g. `string`) still match |

The union rule is the addition that covers the `read_notes.paths: string \| string[]` pattern: when at least one branch of the union accepts an array of strings, a stringified JSON array of strings is taken to be the array branch. JSON failure does not throw here — the string branch of the union may still legitimately accept it.

## Predicting realistic stringification

When designing a new tool, assume any field may arrive as a string from a client that flattens its arguments. Concretely:

- Numeric and boolean fields will sometimes arrive quoted. The layer covers this.
- Object/record fields will sometimes arrive as a JSON-string. The layer covers this.
- An array-of-strings field that is part of a `string | string[]` union (for "single or many" ergonomics) will sometimes arrive as a JSON-string. The layer covers this.
- An array of objects (e.g. a list of items) is **not** covered; if a future tool needs that, the layer must be extended deliberately. Keep the array-of-strings rule narrow until a real second case arrives.

If a tool genuinely needs to accept a stringified-JSON-array of objects, prefer adding a new explicit rule here over working around it inside the tool — coercion belongs at the boundary, not inside the handler.

## Out of scope (by design)

- **Recursion into parsed structures.** Once a JSON-string parses to an object, its inner fields are not coerced. The layer is "lenient at the boundary, strict thereafter."
- **Ambiguous unions.** When a string is itself a valid value for some branch (e.g. `set_property.value: string | number | boolean`), the raw string wins. The layer never tries to guess which branch the agent meant.
- **Reverse coercion.** `number → string` and similar are not performed. Coercion is one-directional — toward the strict declared type.
- **Per-tool customization.** The wrapper has no escape hatch for tool-specific rules. If a rule is needed, it goes here so every tool inherits it.

## Error path

When coercion is intended but fails, the layer raises `CoerceError(fieldName, bareMessage)`. The wrapper catches this inside `z.preprocess`, calls `ctx.addIssue({ code: 'custom', message: bareMessage })`, and returns `z.NEVER` to short-circuit the inner schema. `tool-registry.ts` then formats every issue as `<path>: <message>` and produces:

```ts
ToolHandlerError('INVALID_PARAMS', message, { details: { issues: [{ path, message, expected? }] } })
```

The MCP response carries `code`, `message`, and `details.issues` so machine callers can branch per field. The bare message lives on `CoerceError.bareMessage` so the path-prefix added by the formatter does not duplicate the field name (`filter: filter: …`).

## Boundaries

- The coercion module has no dependence on the tool registry; it is a pure function over `(ZodTypeAny, value)` pairs and is tested in isolation in `test/lib/input-coercion.test.ts`.
- The tool registry calls the wrapper exactly once per registered tool, at registration time. The MCP SDK validates against the wrapped schema, so coercion is applied along whichever path the SDK takes — there is no "outside the dispatcher" code path.
- The strict-typed contract is unchanged: callers passing the declared types continue to work without any coercion firing. Coercion is a one-way fallback that tightens, never loosens, the data the handler sees.
