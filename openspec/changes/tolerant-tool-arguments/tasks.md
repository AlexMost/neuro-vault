## 1. Key aliasing (`filters` → `filter`)

- [x] 1.1 Add optional `inputAliases?: Record<string, string>` (alias → canonical) to the `ITool` interface where tools are typed (`src/lib/tool-registry.ts` and any shared tool type), with a doc comment.
- [x] 1.2 In `src/lib/input-coercion.ts`, extend `wrapSchemaWithCoercion` (and `registerTool` plumbing in `src/lib/tool-registry.ts`) to accept the tool's `inputAliases` and wrap the strict object in a `z.preprocess` that, for a plain-object input, renames each declared alias key to its canonical name _before_ `.strict()` runs. When both alias and canonical keys are present, keep the canonical value and drop the alias key.
- [x] 1.3 Declare `inputAliases: { filters: 'filter' }` on the `query_notes` tool (`src/modules/operations/tools/query-notes.ts`).
- [x] 1.4 Tests: `query_notes({ filters })` behaves identically to `{ filter }`; the `{ filter, filters }` conflict keeps `filter`; a non-alias unknown key still errors as unrecognized (covers spec requirements "Declared parameter aliases are accepted" and "Unknown non-alias keys remain rejected").

## 2. Stringified-array coercion

- [x] 2.1 In `src/lib/input-coercion.ts`, add a plain-`ZodArray` branch to `coerceFieldValue`: when the value is a string, `JSON.parse` it; an array result is returned (element validation stays with zod); a parse failure or non-array result throws a `CoerceError` naming the expected shape (e.g. "expected array or JSON-string of one, got …"). Leave the existing `string | string[]` union branch unchanged.
- [x] 2.2 Tests in `test/lib/input-coercion.test.ts`: a stringified array parses; a JSON-string resolving to a non-array throws a shape-naming `CoerceError`; a non-JSON string throws a shape-naming `CoerceError`; the existing union (`paths`) and object (`filter`) coercion still pass (regression guard).
- [x] 2.3 Tests at the tool boundary in `test/operations/tools/read-notes.test.ts`: `read_notes({ fields: '["frontmatter"]' })` parses and succeeds; `read_notes({ fields: '["bogus"]' })` fails with `INVALID_PARAMS` identifying the invalid element; a non-array `fields` string fails with a shape-naming message (covers spec requirements "Stringified collections are parsed when unambiguous" and "Unrecoverable arguments fail with a shape-naming message").

## 3. Documentation & verification

- [x] 3.1 Record `filters` as an accepted alias of `filter` in `docs/architecture/mcp-parameter-dictionary.md` (additive note; canonical name unchanged, no version bump per ADR-0005).
- [x] 3.2 Run the full gate and confirm green: `npm test && npm run lint && npx tsc --noEmit`.

> Implementation note: `wrapSchemaWithCoercion` building a top-level `z.preprocess` for alias tools turned `spec.inputSchema` into a `ZodPipe`, which the MCP SDK could not advertise (empty params). Resolved by adding `wrapSchemaForSdk` — the SDK gets a `.loose()` coercing `ZodObject` (advertises canonical params, passes the alias key through) while the handler keeps the strict alias-renaming gate. See `design.md` D2 and the regression tests in `test/lib/tool-registry.test.ts`.
