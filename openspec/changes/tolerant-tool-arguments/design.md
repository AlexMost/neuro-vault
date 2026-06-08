## Context

`neuro-vault-mcp` validates every tool call through one seam:
`registerTool()` (`src/lib/tool-registry.ts`) wraps a tool's zod `inputSchema`
with `wrapSchemaWithCoercion()` (`src/lib/input-coercion.ts`), then `safeParse`s;
a failure becomes `ToolHandlerError('INVALID_PARAMS', …)` and reaches the client as
a structured `{ code, message, details }` payload (baseline invariant).

`coerceFieldValue()` already coerces, _before_ zod runs: numeric/boolean strings,
a stringified object for `filter` (`z.record`), and a stringified string-array for
the `paths` `string|string[]` union — each failure path producing a shape-naming
`CoerceError`. Two gaps remain:

1. The wrapper ends in `z.object(shape).strict()`, so an unknown key like `filters`
   is rejected outright — there is no alias support.
2. A _plain_ array parameter such as `read_notes` `fields` (`z.array(z.enum(...))`,
   not a union) falls through coercion untouched and zod bare-fails with
   "expected array, received string".

These two gaps are exactly the dead-end documented in `conv-1780003210445`: an agent
guessed `filters` for `filter` and passed a stringified array, and the session ended
with no recoverable hint. Stakeholders: MCP-client agents (the callers) and the
maintainer (contract owner; ADR-0005 governs parameter naming).

## Goals / Non-Goals

**Goals:**

- `query_notes({ filters })` behaves identically to `{ filter }`.
- A stringified JSON array for a plain-array parameter (`fields`) is parsed and
  accepted, with element types still validated.
- When a value cannot be recovered, the error _names the expected shape_ rather than
  emitting a bare zod message — the failure mode (`INVALID_PARAMS`) is unchanged.
- The fix lives at the central coercion seam, not in per-tool handlers.

**Non-Goals:**

- A general cross-tool alias registry or broad misnomer table (scope chosen: minimal).
- Relaxing `.strict()` / accepting arbitrary unknown keys.
- Reworking the MongoDB-style filter schema.
- Any change to error codes, the MCP transport, or dependencies.

## Decisions

### D1: Minimal scope — exactly the task DoD

- **Choice**: `filters→filter` alias on `query_notes`; extend coercion so stringified
  arrays parse like `filter`/`paths` already do; replace bare fails with shape-naming
  messages. Nothing broader.
- **Rationale**: narrowest contract surface, lowest risk; the two real dead-ends from
  the usage report are both closed.
- **Alternatives considered**: a curated cross-tool alias registry, and a general
  tolerance layer over every object schema — both rejected as larger blast radius for
  no demonstrated need.

### D2: Key aliasing via a declarative per-tool map at the central seam

- **Choice**: add optional `inputAliases?: Record<alias, canonical>` to the `ITool`
  interface; `query_notes` declares `{ filters: 'filter' }`. `wrapSchemaWithCoercion`
  wraps the strict object in a `z.preprocess` that, for a plain-object input, renames
  each declared alias key to its canonical name _before_ `.strict()` validates.
- **Rationale**: one explicit place; additive; testable; preserves `.strict()` for
  genuinely unknown keys; keeps the alias declared next to the tool it belongs to.
- **Alternatives considered**:
  - Relax `.strict()` to passthrough — rejected: hides real typos, erodes the
    dictionary discipline (ADR-0005).
  - Remap inside the `query_notes` handler — rejected: runs _after_ schema validation,
    so the strict object has already rejected the key; also scatters the logic.

### D3: Conflict rule — canonical wins

- **Choice**: if both `filter` and `filters` are present, keep `filter` and drop the
  alias key.
- **Rationale**: deterministic and safe; the canonical name is the source of truth.
  The collision is unlikely in practice.

### D4: Stringified-array coercion for plain `ZodArray`

- **Choice**: add a plain-`ZodArray` branch to `coerceFieldValue`: when the value is a
  string, `JSON.parse` it; an array result is returned (zod then validates element
  types); a parse failure or non-array result throws a `CoerceError` naming the
  expected shape ("expected array or JSON-string of one, got …"). The existing union
  branch (`paths`) is left untouched.
- **Rationale**: mirrors the object/union coercion already shipping; preserves precise
  per-element validation (e.g. a bad `fields` enum value still errors precisely rather
  than being swallowed).
- **Alternatives considered**: special-casing only enum/string arrays — rejected as
  arbitrary; the JSON-parse-then-let-zod-validate approach generalizes cleanly to any
  array element type.

### D5: Document `filters` as an accepted alias, no version bump

- **Choice**: record `filters` as an accepted alias of `filter` in
  `docs/architecture/mcp-parameter-dictionary.md`; no major-version bump.
- **Rationale**: ADR-0005 charges a major version for _renaming_ a shared parameter.
  Here the canonical name is unchanged and the alias is purely additive input.

## Risks / Trade-offs

- [Risk] The alias preprocess could clobber a legitimately-present canonical key →
  Mitigation: canonical-wins rule (D3) plus an explicit test for the `{filter, filters}`
  collision.
- [Risk] JSON-parsing a stringified array could mask a real type error in elements →
  Mitigation: we only parse the outer string; element validation stays with zod, so
  `["bogus"]` against the `fields` enum still produces a precise error (asserted by a
  test).
- [Trade-off] We accept a stray nonexistent key (e.g. `fields` on `query_notes`, which
  has no such param) still erroring as "unrecognized key" rather than being silently
  ignored → accepted: that is a correct signal that the parameter does not exist, not a
  dead-end this change targets, and silently ignoring it would hide typos.
- [Trade-off] Aliases live per-tool rather than in a shared table → accepted under the
  minimal scope; a registry can be introduced later if the misnomer set grows.

## Migration Plan

N/A for deployment — no endpoint, schema, dependency, or error-code change. Roll-out is
a normal release: merge to `main`, then `npm run release`. Rollback is a straight
revert; because every change is strictly additive (new accepted input, no removed or
renamed parameter), no client can break on upgrade _or_ downgrade.

## Open Questions

None. Scope, mechanism, conflict rule, and documentation impact are all resolved.
