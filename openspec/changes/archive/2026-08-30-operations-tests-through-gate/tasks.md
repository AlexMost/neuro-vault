Delivery is four PRs. Groups 1–4 are **sequential with respect to each other** —
group 1 must be reviewed and merged before group 2 starts, so the helper shape is
validated against one real file before ~200 more call sites adopt it. Within a
group, parallel-safety is marked per group.

## 1. Foundation — gate helpers, `read_notes`, dead-branch deletion (PR 1)

**Sequential.** 1.1 → 1.2 gate everything after them; 1.7 must land in the same
commit as 1.3–1.6 (deleting `validateReadNotesInput` breaks `read-notes.ts` and
its tests at the same instant).

- [x] 1.1 Confirm the payload audit: only a plain record populates `structuredContent` (`src/lib/tool-response.ts`, `Object.getPrototypeOf(value) === Object.prototype`), and two semantic tools resolve with an array — `find_duplicates` and `get_similar_notes`. `callTool` must therefore fall back to the text channel. Re-run the audit over `src/modules/*/tools/*.ts` return types and record any third case in the PR body before writing the helper.
- [x] 1.2 Add `test/_gate.ts` exporting `callTool<T>(reg, args): Promise<T>` (awaits `reg.handler(args)`; on `isError` reconstructs and throws a `ToolHandlerError` from `structuredContent`; on success returns `structuredContent`, falling back to `JSON.parse(content[0].text)` for non-record payloads and to `undefined` for the `'ok'` void sentinel) and `expectToolError(reg, args)` (asserts `isError` and returns `{ code, message, details }`). Cover it in `test/gate-helpers.test.ts`: record unwrap, array-payload text fallback, `'ok'` sentinel, error re-throw preserving `code`/`message`/`details`, and a non-JSON text payload raising a named error.
- [x] 1.3 Migrate all 19 handler-direct call sites in `test/operations/tools/read-notes.test.ts` to `registerTool(buildReadNotesTool(deps))` + `callTool`. Fixtures MUST return one reader item per requested path — `read_notes` projects positionally (`projected[projectedIdx++]`), so a short fixture fails opaquely.
- [x] 1.4 Rewrite the four false pins (`paths: ''`, `paths: []`, 51 paths, `content: 'none'`) to assert `INVALID_PARAMS` and the offending field, per the `read-notes-content-modes` delta.
- [x] 1.5 Rewrite `read-notes.test.ts:282-292` — assert that a legacy `fields` key is rejected through the gate with `INVALID_PARAMS` and an unrecognized-key message, replacing the raw-schema strip assertion.
- [x] 1.6 Add `read_notes` coverage the suite has never had: `paths: '["a.md","b.md"]'` coerces to a two-path array, and `vault: 'v'` against a single-vault registry is rejected as an unrecognized key.
- [x] 1.7 Delete `validateReadNotesInput` and `VALID_CONTENT_MODES` from `src/modules/operations/tool-helpers.ts` and inline the surviving `string → string[]` widening into `buildReadNotesTool`; `content` passes through untouched. (Delivered as its own commit rather than folded into 1.3–1.6: 1.3–1.6 touch no `src/` file and are green on their own, so no intermediate commit is broken.)
- [x] 1.8 Run `npm test && npm run lint && npm run typecheck`. Open PR 1 to `main` with `Refs #112`, naming in the body every previously-green test the migration broke and how each was triaged. **Pause for review before group 2.**

## 2. Operations suite — remaining nine files plus new coverage (PR 2)

**Parallel-safe: 2.1–2.10 touch disjoint files** and may be dispatched
concurrently. 2.11 is sequential after all of them.

Each of 2.1–2.9 does the same three things for its file: (a) build through
`registerTool` and route every call through `callTool` / `expectToolError`;
(b) add a strict unknown-key rejection case; (c) add a single-vault `vault`-key
rejection case. Tools with coercible fields also get (d), named per task.

- [x] 2.1 `test/operations/tools/create-note.test.ts` (17 call sites) — plus (d) `overwrite: "true"` coerces to `true`, and `frontmatter` as a JSON-string object parses.
- [x] 2.2 `test/operations/tools/query-notes.test.ts` (6) — plus (d) `filter` as a JSON-string object, `limit: "5"` → `5`, `include_content: "true"` → `true`, `path_prefix` as a JSON-string array.
- [x] 2.3 `test/operations/tools/set-property.test.ts` (16) — plus (d) `value` as a JSON-string array parses to the array branch of the union, while a plain string still resolves to the string branch (`docs/architecture/input-coercion.md` §"Ambiguous unions").
- [x] 2.4 `test/operations/tools/edit-note.test.ts` (14) — no coercible field. Keep the existing `WRITE_FAILED` block calling `reg.handler` directly (its subject *is* the `CallToolResult` envelope) and add a comment saying so.
- [x] 2.5 `test/operations/tools/read-daily.test.ts` (9) — no coercible field.
- [x] 2.6 `test/operations/tools/get-vault-overview.test.ts` (6) — no coercible field; the existing `registerTool(...).spec.description` assertion stays.
- [x] 2.7 `test/operations/tools/list-tags.test.ts` (5) — no coercible field.
- [x] 2.8 `test/operations/tools/get-note-links.test.ts` (5) — no coercible field.
- [x] 2.9 `test/operations/tools/remove-property.test.ts` (5) — no coercible field.
- [x] 2.10 Add `test/operations/tools/list-properties.test.ts` — `list_properties` is the one operations tool with no dedicated test file, so "per-tool" coverage is otherwise false for it. Gate-routed happy path, strict unknown-key rejection, and single-vault `vault` rejection.
- [x] 2.11 Run `npm test && npm run lint && npm run typecheck`; confirm `grep -rn '\.handler(' test/operations/tools/` returns only envelope-subject call sites, each commented. Open PR 2 with `Refs #112`.

## 3. Semantic suite (PR 3)

**3.1 is sequential** (every file below depends on the converted helper);
**3.2–3.5 are parallel-safe** across disjoint files.

- [x] 3.1 Convert `runSearch` in `test/semantic/tools/_helpers.ts:291` to build through `registerTool` and return via `callTool<SearchNotesOutput>`, keeping its current signature and return type so its ~120 call sites are unchanged. Verify the whole semantic suite still passes before touching any test file.
- [x] 3.2 `test/semantic/tools/search-notes-hybrid.test.ts` (44 direct calls) — migrate; keep the existing `reg.spec.inputSchema` axis assertions as they are.
- [x] 3.3 `test/semantic/tools/search-notes.test.ts` (32) — migrate.
- [x] 3.4 `test/semantic/tools/get-similar-notes.test.ts` (19) and `test/semantic/tools/find-duplicates.test.ts` (6) — migrate; add the single-vault `vault`-rejection case to each.
- [x] 3.5 `test/semantic/tools/search-notes-filter.test.ts` (14) and `test/semantic/tools/search-notes-e2e.test.ts` (4) — migrate.
- [x] 3.6 Run `npm test && npm run lint && npm run typecheck`; confirm the `grep` acceptance over `test/semantic/tools/`. Open PR 3 with `Refs #112`.

## 4. Record the contract (PR 4)

**Parallel-safe: 4.1–4.4 touch disjoint files.** 4.5–4.7 are sequential after them.

- [x] 4.1 Write `docs/adr/0015-<slug>.md` from `docs/adr/0000-template.md`: zod owns schema shape and fails as `INVALID_PARAMS`; `INVALID_ARGUMENT` is reserved for semantic argument faults a schema cannot express. Status Accepted. Add its `docs/adr/INDEX.md` row and append "refined in part by [0015]" to the 0003 row (follow the 0001 row's existing formatting).
- [x] 4.2 Correct `docs/architecture/mcp-server-shape.md` §"Tool handler contract" — its first bullet currently says handlers throw `INVALID_ARGUMENT` on bad input with no mention of the gate. Describe the gate (coercion, `.strict()`, `INVALID_PARAMS` before the handler), the division of responsibility, and the rule that tool tests cross the same seam a client does.
- [x] 4.3 Add to `docs/architecture/input-coercion.md` that the same wrapper closes the object with `.strict()`, so unknown keys are rejected rather than stripped, and cross-link `mcp-server-shape.md`.
- [x] 4.4 Add one line to `AGENTS.md` §"Run / check": tool tests reach tools through `registerTool`, never `buildXTool(...).handler` — the gate coerces, closes the schema, and returns `INVALID_PARAMS`.
- [x] 4.5 Sweep all of `docs/` for other prose asserting `INVALID_ARGUMENT` for schema-shaped failures; an architecture-scoped grep alone misses `docs/guide/`.
- [x] 4.6 Run `openspec validate --all` and `npm test && npm run lint && npm run typecheck`.
- [x] 4.7 `/opsx:verify` → retrospective → `/opsx:archive` (which syncs both delta specs into `openspec/specs/`), then open PR 4 with `Closes #112`.
