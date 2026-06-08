## Why

MCP tools hard-fail when an agent guesses the argument contract, and the agent
dead-ends instead of pivoting. In `conv-1780003210445` (W23 usage report) a
`query_notes` call used the key `filters` (schema wants `filter`) and a
stringified JSON value where a real array was expected → `status: error`, the
session ended with no retry. This is a recurring class of dead-end. The fix is to
make the input boundary forgiving: accept the common alias, parse a stringified
collection when it's unambiguous, and when a value genuinely can't be recovered,
return an error that _names the expected shape_ instead of a bare validation fail.

## What Changes

**Unknown alias key `filters`**

- From: `query_notes({ filters })` is rejected by the strict schema as an
  unrecognized key.
- To: `filters` is accepted as an alias of `filter` (canonical wins if both given).
- Reason: highest-frequency agent misnomer in the usage reports.
- Impact: non-breaking — additive accepted input, canonical name unchanged.

**Stringified array for a plain-array parameter (e.g. `read_notes` `fields`)**

- From: a JSON-string array falls through coercion and zod bare-fails with
  "expected array, received string".
- To: the string is `JSON.parse`d; an array is accepted (element types are still
  validated, so a bad element gives a precise error); a parse failure or non-array
  yields a `CoerceError` naming the expected shape.
- Reason: matches existing coercion already done for `filter` (object) and `paths`
  (string|array union); closes the gap for plain arrays.
- Impact: non-breaking — strictly widens accepted input.

**Error message on unrecoverable input**

- From: a bare zod validation message.
- To: a shape-naming `CoerceError` message; failure _mode_ is unchanged (still the
  fatal `INVALID_PARAMS` code clients already branch on).

Explicitly **not** changing: `.strict()` is kept. A key that is neither canonical
nor a declared alias still errors as unrecognized — a correct signal, not a
dead-end this change targets. The filter schema stays MongoDB-style as-is.

## Capabilities

### New Capabilities

- `tolerant-arguments`: how the tool-input boundary tolerates near-miss arguments —
  declared key aliases, stringified-collection coercion, and shape-naming errors
  when a value can't be recovered.

### Modified Capabilities

<!-- none — aliasing is additive and consistent with baseline's dictionary requirement; no existing requirement changes -->

## Impact

- **Code**: `src/lib/input-coercion.ts` (plain-array coercion branch + alias
  preprocess), `src/lib/tool-registry.ts` / the `ITool` interface (optional
  `inputAliases`), and `src/modules/operations/tools/query-notes.ts` (declares
  `{ filters: 'filter' }`).
- **Docs**: `docs/architecture/mcp-parameter-dictionary.md` — record `filters` as an
  accepted alias of `filter`.
- **Tests**: `test/lib/input-coercion.test.ts`, `test/lib/tool-registry.test.ts`,
  `test/operations/tools/query-notes.test.ts`, `test/operations/tools/read-notes.test.ts`.
- **No** dependency, MCP transport, or error-code changes. Acceptance gate:
  `npm test && npm run lint && npx tsc --noEmit`.
