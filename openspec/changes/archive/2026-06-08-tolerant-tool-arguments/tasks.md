> **Descoped after implementation (Group 1, key aliasing).** The `filters`→`filter`
> alias was built and reviewed, then **removed** before merge: it was justified by a
> single usage-report data point, carried disproportionate complexity (it forced a
> dual-schema `wrapSchemaForSdk` and was where all three review-caught Criticals lived),
> and "legalized" a non-canonical name. The shipped change is **stringified-array
> coercion only** (Group 2). Group 1 tasks are struck through to reflect this; see
> `retrospective.md` §Update.

## 1. ~~Key aliasing (`filters` → `filter`)~~ — DESCOPED, reverted before merge

- [~] 1.1 ~~Add optional `inputAliases?` to the `ITool` interface.~~ (reverted)
- [~] 1.2 ~~Extend `wrapSchemaWithCoercion` to rename declared alias keys before `.strict()`.~~ (reverted)
- [~] 1.3 ~~Declare `inputAliases: { filters: 'filter' }` on `query_notes`.~~ (reverted)
- [~] 1.4 ~~Alias tests (rename, conflict, unknown-key).~~ (reverted)

## 2. Stringified-array coercion

- [x] 2.1 In `src/lib/input-coercion.ts`, add a plain-`ZodArray` branch to `coerceFieldValue`: when the value is a string, `JSON.parse` it; an array result is returned (element validation stays with zod); a parse failure or non-array result throws a `CoerceError` naming the expected shape (e.g. "expected array or JSON-string of one, got …"). Leave the existing `string | string[]` union branch unchanged.
- [x] 2.2 Tests in `test/lib/input-coercion.test.ts`: a stringified array parses; a JSON-string resolving to a non-array throws a shape-naming `CoerceError`; a non-JSON string throws a shape-naming `CoerceError`; the existing union (`paths`) and object (`filter`) coercion still pass (regression guard).
- [x] 2.3 Tests at the tool boundary in `test/semantic/tools/get-similar-notes.test.ts`: a stringified `exclude_folders` array parses at the registration boundary; a non-array `exclude_folders` string fails with a shape-naming message (covers spec requirements "Stringified collections are parsed when unambiguous" and "Unrecoverable arguments fail with a shape-naming message"). _Re-pointed from the originally-planned `read_notes.fields` after the `read-notes-preview` merge removed that param._

## 3. Documentation & verification

- [~] 3.1 ~~Record `filters` as an accepted alias of `filter` in the parameter dictionary.~~ (reverted with the alias)
- [x] 3.2 Run the full gate and confirm green: `npm test && npm run lint && npx tsc --noEmit`.
