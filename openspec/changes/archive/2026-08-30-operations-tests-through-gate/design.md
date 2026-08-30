## Context

`registerTool` (`src/lib/tool-registry.ts`) is the seam an MCP client crosses. At registration it wraps the tool's declared `inputSchema` with `wrapSchemaWithCoercion` (`src/lib/input-coercion.ts`), which coerces four value shapes per field and then **closes the object** — `z.object(newShape).strict()`. At call time it `safeParse`s against that wrapped schema and, on failure, throws `ToolHandlerError('INVALID_PARAMS', …)` with per-field issues, *before* the tool's own handler runs. `invokeTool` catches it and returns `CallToolResult { isError: true, structuredContent: { code, message, details } }` (ADR-0003). In production the schema is double-layered — `src/server.ts` hands the same wrapped schema to the MCP SDK.

No operations test crosses that seam: 100 handler-direct call sites across the 10 files in `test/operations/tools/`. Consequences confirmed by a probe against the real gate this session:

- Four tests in `test/operations/tools/read-notes.test.ts` pin `INVALID_ARGUMENT` for `paths: ''`, `paths: []`, 51 paths, and `content: 'none'`. Every one dies at the gate as `INVALID_PARAMS` first. The three corresponding branches in `validateReadNotesInput` (`src/modules/operations/tool-helpers.ts:124-153`) are unreachable in production and green only because the tests enter past the gate.
- `read-notes.test.ts:282-292` asserts an unknown legacy `fields` key is silently stripped — on the *raw*, pre-`.strict()` schema. Production returns `INVALID_PARAMS: Unrecognized key: "fields"`.
- Never exercised per tool: coercion, and the single-vault rejection of a supplied `vault` (`vaultParamShape` returns `{}` when the registry holds one vault, so `.strict()` rejects the key).

Two `openspec/specs/read-notes-content-modes/spec.md` scenarios encode the same two errors, and the `fields` one directly contradicts `openspec/specs/tolerant-arguments/spec.md` §"Unknown keys remain rejected".

The constraint that would have caught this — "tool-contract tests go through the SDK gate, not handler-direct" — is stated in four archived opsx plans and in **no durable doc**. An archived plan is not in anyone's context window.

`docs/architecture/mcp-server-shape.md:55` currently propagates the confusion, describing each handler as one that "validates and normalizes its input … and throws `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input" — with no mention of the gate that already rejected malformed input two frames earlier. ADR-0003's Decision paragraph says the same thing.

## Goals / Non-Goals

**Goals:**

- Make "no tool test enters past the registration gate" a **structural** property of `test/operations/tools/` and `test/semantic/tools/`, not a per-test judgment call.
- Rewrite every false pin to the code and message production actually returns.
- Delete the post-gate validation zod already owns.
- Add the missing coverage: per-tool coercion, strict unknown-key rejection, and single-vault `vault` rejection.
- Correct the two spec scenarios, the architecture prose, and record the gate division durably (ADR-0015 + `AGENTS.md`).

**Non-Goals:**

- Any change to a tool's input schema, output shape, or error codes. The contract is already right; the tests and specs describe it wrongly.
- Reopening ADR-0003. ADR-0015 refines its boundary; 0003 stays Accepted.
- Loosening `.strict()` to make a migrated test pass.
- `test/lib/`, `test/server-*.test.ts`, `test/eval/` — none of these reach a tool through a registration.
- Extending coercion to new value shapes (`docs/architecture/input-coercion.md` §"Out of scope" stands).

## Decisions

### D1 — Every tool test routes through `registerTool`, via typed helpers

- **Choice**: A new shared module (`test/_gate.ts`) exports two helpers. `callTool<T>(reg, args): Promise<T>` awaits `reg.handler(args)`; if `isError`, it reconstructs a `ToolHandlerError` from `structuredContent` and **throws** it; otherwise it returns `structuredContent as T`. `expectToolError(reg, args)` returns the raw `{ code, message, details }` for tests that assert on the envelope. Every test file in `test/operations/tools/` and `test/semantic/tools/` builds via `registerTool(buildXTool(deps))` and calls through these.
- **Rationale**: The property wanted is structural — *no* test can enter past the gate — not case-by-case. A structural property survives the next contributor; a judgment call is exactly what let 100 call sites accumulate. Re-throwing at the helper is what makes the migration cheap: existing `await expect(...).rejects.toMatchObject({ code })` assertions survive verbatim, and success assertions change only from `tool.handler(x)` to `callTool(reg, x)`.
- **Alternatives considered**:
  - *Contract tests only, semantics stay handler-direct* (issue #112's wording). Smaller diff, but preserves the judgment call "is this test contract or semantics?" — the same call the current suite got wrong.
  - *`read_notes` only, rest as follow-up.* Fastest to land; leaves nine files of identical debt.
  - *Assert on `CallToolResult` directly everywhere, no unwrap helper.* Every success assertion would need `structuredContent` casts inline — the ergonomic tax that made handler-direct attractive in the first place.

### D2 — Two gates collapse into one contract

- **Choice**: zod owns everything expressible in a schema — types, enums, string/array bounds, unknown keys, coercion — and its failures surface as `INVALID_PARAMS`. `INVALID_ARGUMENT` is reserved for semantic argument errors a schema cannot express: exactly-one-of `name`/`path`, path traversal, list items containing commas, a date value that does not match its declared `type`.
- **Rationale**: ADR-0003 makes `code` the client-facing contract. Today which code a caller sees for the same mistake depends on which gate fires first, and only one of the two is reachable. Collapsing removes the ambiguity without changing a single client-observable behaviour — production already returns `INVALID_PARAMS` for every case in question.
- **Alternatives considered**: *Make the post-gate branches reachable by loosening the schema* — would move validation away from the layer the MCP SDK also enforces, and lose the per-field `details.issues` payload. *Renaming one code to the other* — a breaking contract change for zero benefit.

### D3 — `validateReadNotesInput` is deleted, not slimmed

- **Choice**: Delete `validateReadNotesInput` and `VALID_CONTENT_MODES` from `src/modules/operations/tool-helpers.ts`. Only the `string → string[]` widening survives, inlined into `buildReadNotesTool`. `content` passes straight through — zod has already proven it is one of the three modes.
- **Rationale**: Three of its four branches are dead; the fourth is a type check zod performs. A surviving named validation helper is an attractive place for a future author to re-grow validation zod owns. `VALID_CONTENT_MODES` has no other consumer (`ContentMode` in `types.ts` is the type-level source).
- **Alternatives considered**: *Slim it to `normalizeReadNotesPaths()`* — keeps a unit-test seam for three lines, and keeps the invitation.

### D4 — The semantic suite is converted in the same change

- **Choice**: `test/semantic/tools/_helpers.ts`'s `runSearch` (handler-direct at line 291, ~120 call sites behind it) and the four `test/semantic/tools/*.test.ts` files move to the same helpers. Delivered as its own PR.
- **Rationale**: The `AGENTS.md` line should be true repo-wide the day it is written. A rule shipped with a large known exception is the state that produced this issue.
- **Alternatives considered**: *Operations only* (issue #112's boundary) — leaves the biggest single handler-direct helper in the repo untouched while the rule claims otherwise.

### D5 — The record goes to ADR-0015 and the existing architecture pages, not a new page

- **Choice**: A new `docs/adr/0015-*.md` states D2 as an accepted decision, with an INDEX row and a "refined in part by 0015" note on 0003's row (the precedent is 0001's row). `docs/architecture/mcp-server-shape.md` §"Tool handler contract" is corrected and gains the gate description plus the testing-seam rule; `docs/architecture/input-coercion.md` gains a sentence that the same wrapper applies `.strict()`. One line in `AGENTS.md` §"Run / check".
- **Rationale**: `docs/architecture/README.md` requires one concept to be understandable from exactly one file. A new `tool-input-gate.md` would split the registration concept across two files; the concept already lives in `mcp-server-shape.md`, whose current text is wrong. ADR-0003 is immutable, so the refinement is a new ADR that cites it.
- **Alternatives considered**: *New `docs/architecture/tool-input-gate.md`* — splits the concept. *Architecture docs only, no ADR* — leaves the rule in a layer explicitly designated as rewritable.

### D6 — Spec deltas correct the specs, not the code

- **Choice**: `read-notes-content-modes` — the invalid-`content` scenario becomes `INVALID_PARAMS`; the legacy-`fields` scenario becomes a rejection. `tolerant-arguments` — a requirement stating the strict/coercing boundary applies uniformly to every registered tool, and that a `vault` argument supplied in single-vault mode is an unknown key.
- **Rationale**: Both scenarios describe behaviour the shipped server does not have. The `fields` one also contradicts `tolerant-arguments`, so leaving it makes `openspec validate` pass over a self-contradictory spec set.

## Risks / Trade-offs

- **[Risk] The migration breaks currently-green tests whose inputs carry undeclared keys** → Mitigation: this is the change doing its job. Each failure is triaged as either a sloppy fixture (fix the input) or a documented contract the schema does not offer (fix the test to assert the rejection). `.strict()` is never relaxed to make one pass. Task-level acceptance requires each such failure to be named in the PR body, not silently patched.
- **[Risk] `structuredContent` is only populated for plain records** — `toToolResponse` checks `Object.getPrototypeOf(value) === Object.prototype`, and two semantic tools resolve with an array: `find_duplicates` (`StampedDuplicatePair[]`) and `get_similar_notes` (`StampedSimilarNoteResult[]`). Their payloads travel in the text channel only, so a naive `structuredContent` unwrap would hand those tests `undefined` → Mitigation: `callTool` falls back to `JSON.parse(content[0].text)` when a *successful* result carries no `structuredContent`, and returns `undefined` for the `'ok'` void sentinel. That is exactly what a client which ignores `structuredContent` reads, so the fallback widens what the tests exercise rather than narrowing it. `tool-response-envelope` §"non-object payload gets text only" is the requirement this honours. A parse failure raises a named error rather than an opaque `undefined` deref.
- **[Risk] `callTool<T>` casts `structuredContent` to `T`, so a return-shape drift no longer fails typecheck at the test call site** → Mitigation: the shape is still asserted at runtime by the same `toEqual`/`toMatchObject` assertions the tests already carry; and `test/operations/tools.test.ts` plus the output-schema advertisements remain the structural check. Accepted: the seam being tested is the client's, and a client sees `structuredContent` untyped too.
- **[Risk] `read_notes` projects reader items positionally** (`projected[projectedIdx++]`), so a mock reader returning fewer items than paths yields `Cannot use 'in' operator to search for 'error' in undefined` — surfaced during this session's probe → Mitigation: harmless in production (real readers return one item per path), but migrated fixtures must return one item per requested path. Called out in the plan's read-notes task.
- **[Trade-off] ~220 mechanical call-site edits across 14 test files** → Accepted: the edits are uniform and each PR is independently green, so review cost is per-file skim rather than per-call reasoning. Split across three PRs to keep any single review surface bounded.
- **[Trade-off] Scope exceeds issue #112's stated boundary** (semantic suite, ADR, spec deltas) → Accepted deliberately: #112 routed itself as a direct PR on the premise of "no tool-contract change", but the spec contradiction means requirements *do* change, which is what put this on the opsx path. The extra scope is recorded here and in the proposal rather than discovered mid-apply.

## Migration Plan

No deployment change — no runtime behaviour is altered, so there is nothing to roll back beyond a revert. Four PRs to `main`, each independently green on `npm test && npm run lint && npm run typecheck`:

1. **Foundation** — `test/_gate.ts` with `callTool` / `expectToolError`; the plain-record audit; `test/operations/tools/read-notes.test.ts` migrated; the four false pins rewritten to `INVALID_PARAMS`; the `fields` test rewritten to assert the strict rejection; `validateReadNotesInput` and `VALID_CONTENT_MODES` deleted and the widening inlined. `Refs #112`.
2. **Operations** — the other nine files in `test/operations/tools/`, plus the new per-tool coercion, strict unknown-key, and single-vault-`vault` coverage. `Refs #112`.
3. **Semantic** — `test/semantic/tools/_helpers.ts` (`runSearch`) and the four `test/semantic/tools/*.test.ts` files. `Refs #112`.
4. **Record** — ADR-0015 + INDEX rows, `docs/architecture/mcp-server-shape.md`, `docs/architecture/input-coercion.md`, `AGENTS.md`, and the two spec deltas synced. `Closes #112`.

PR 1 is delivered and paused on before 2–4 start, so the helper shape is reviewed against one real file before ~200 more call sites adopt it.

Acceptance for the change as a whole:

- `npm test`, `npm run lint`, `npm run typecheck` pass; `openspec validate --all` passes.
- `grep -rn '\.handler(' test/operations/tools/ test/semantic/tools/` returns only call sites whose subject is the `CallToolResult` envelope itself, each carrying a comment saying so.
- No test asserts an error code the gate makes unreachable.
- `validateReadNotesInput` and `VALID_CONTENT_MODES` are gone from the source tree.

## Open Questions

None blocking. One deliberate deferral: whether the "route through the gate" rule should be enforced mechanically (a lint rule or a CI grep) rather than by convention. Not proposed here — the grep in the acceptance list is a one-time check, and a durable enforcement mechanism deserves its own change once the convention has lived through a few PRs.
