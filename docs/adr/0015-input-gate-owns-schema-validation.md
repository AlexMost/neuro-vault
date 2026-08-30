# ADR-0015 — The registration gate owns schema validation; `INVALID_ARGUMENT` is for semantic faults

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

Every tool reaches a client through `registerTool` (`src/lib/tool-registry.ts`), which wraps the tool's declared `inputSchema` with `wrapSchemaWithCoercion` — per-field coercion, then `z.object(shape).strict()` — and `safeParse`s the arguments before the handler runs. A failure there never reaches the handler: it becomes `ToolHandlerError('INVALID_PARAMS', …, { details: { issues } })`.

[ADR-0003](0003-structured-errors-toolhandlererror.md), written before that gate existed, states in its Decision that "handlers validate input and throw `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input". Both instructions were followed, and the result is validation no call can reach:

- `read_notes` grew four post-gate checks — empty `paths`, a `paths` count over the declared maximum, a `content` value outside the enum, and a `string → string[]` widening zod already performed. All four sat behind a schema that had already rejected the same inputs.
- `readThreshold` (`src/modules/semantic/tool-helpers.ts`) rejects `value < 0 || value > 1`, but all four of its call sites — `search_notes`' `threshold` and `expansion_floor`, `get_similar_notes`' `threshold`, `find_duplicates`' `threshold` — declare `z.number().min(0).max(1)`.
- All three `UNSUPPORTED_VALUE_TYPE` throws in `inferTypeAndValidate` (`src/modules/operations/tool-helpers.ts`) are excluded by `set_property`'s own `value` union, `z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())])`: it admits neither `null`/`undefined`, nor a list item that is not a string or number, nor any other type.

None of this was caught, because the tool tests called `buildXTool(deps).handler(args)` directly. A handler-direct call enters the tool one frame past coercion, `.strict()`, and `INVALID_PARAMS` — so a test could assert `INVALID_ARGUMENT` for an input that in production never gets that far, and stay green forever.

## Decision

Zod owns every constraint a schema can express — type, enum, bound, unknown key, coercion — and its failures reach the client as `INVALID_PARAMS` carrying `details.issues`. A handler MUST NOT re-check what its own schema already states.

`INVALID_ARGUMENT` is reserved for semantic argument faults a schema cannot express, such as:

- exactly-one-of constraints across fields (`name` xor `path`);
- a path that escapes the vault root after normalization;
- list items containing commas, which the storage format cannot round-trip;
- a value that does not match its separately declared `type` (a non-ISO string when `type: 'date'`).

Tool tests reach a tool through `registerTool(buildXTool(deps))` and the `callTool` / `expectToolError` helpers in `test/_gate.ts` — never through `buildXTool(deps).handler`. The one admissible exception is a test whose subject *is* the `CallToolResult` envelope rather than the tool's behaviour; it calls the handler directly and says so in a comment.

## Consequences

- One code per failure class, so a client can branch: `INVALID_PARAMS` means "the shape of my arguments was wrong, and `details.issues` says where"; `INVALID_ARGUMENT` means "the shape was fine, the meaning was not". This is also the split the MCP SDK itself enforces, so a schema-shaped rejection reads the same whichever layer produced it.
- Unreachable validation becomes visible, because the tests now cross the same seam a client does. The three sites listed above are exactly what that visibility surfaced; the tests that pinned them were corrected to assert what production does, and the dead branches themselves remain in `src/` for a separate change — together with `OperationsErrorCode.UNSUPPORTED_VALUE_TYPE`, which no reachable path can now emit.
- Refines [ADR-0003](0003-structured-errors-toolhandlererror.md) without superseding it. The `ToolHandlerError` envelope, the `{ code, message, details }` payload, and the server-side rendering are all unchanged; only the instruction about *which* code a handler owes to bad input is narrowed.
- A new constraint now has one obvious home. Expressible in zod → put it in the schema, and the gate reports it. Not expressible → the handler throws `INVALID_ARGUMENT` and the test asserts it through the gate.

## Alternatives considered

- **Loosen the schemas so the handler checks become reachable** — moves validation off the layer the SDK also enforces, discards `details.issues`, and makes the advertised `inputSchema` describe less than the tool actually requires.
- **Rename one code to the other** — a breaking change to a contract clients branch on, collapsing two genuinely different failure classes for no gain.
- **Keep calling handlers directly and audit reachability by review** — the audit is exactly what failed here for three separate tools; the seam has to be enforced by where the test calls in, not by vigilance.
