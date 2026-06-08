<!--
Raw capture of superpowers:brainstorming output for change `tolerant-tool-arguments`.
Decision-log format: background → scope decision → mechanism design → boundary.
design.md reorganizes this into structured sections; do not copy verbatim.
-->

# Brainstorm — tolerant-tool-arguments

## Background

Source task: `Tasks/neuro-vault/Толерантність аргументів query_notes` (vault, type
`task`, priority 4). `query_notes` silently hard-fails when an agent guesses the
parameter contract, and the agent does not pivot — the session dead-ends.

Documented case — W23, `conv-1780003210445` ("Review svadlenka tasks"): a
`query_notes` call used the key `filters` (schema wants `filter`) and a stringified
JSON value (`"[…]"`) where a real array was expected → `status: error`, session
ended with no retry. This is a recurring class of dead-end in the tool-usage reports
(`Inbox/neuro-vault-usage/2026-W23`).

Goal: make the call **forgiving** — accept the common alias, and when a value can't be
recovered, return an error that _names the expected shape_ instead of a bare fail.

## What the codebase already does (explored before deciding)

Central validation seam: `src/lib/tool-registry.ts` → `registerTool()` wraps every
tool's zod `inputSchema` with `wrapSchemaWithCoercion()` (`src/lib/input-coercion.ts`),
then `safeParse`s; a failure throws `ToolHandlerError('INVALID_PARAMS', …)`.

`coerceFieldValue()` already coerces, before zod validation:

- numbers / booleans from strings, with shape-naming `CoerceError` on failure;
- **`filter`** (`z.record`) — a JSON-string is `JSON.parse`d to an object, else a
  `CoerceError` naming the parsed shape;
- **`paths`** (`z.union([string, string[]])`) — a JSON-string array is parsed via the
  union branch (`isStringArraySchema`).

Two gaps remain:

1. The wrapper ends in `z.object(newShape).strict()` → an unknown key like `filters`
   is rejected as "unrecognized key". No alias support.
2. **`fields`** (`read_notes`) is `z.array(z.enum([...]))` — a _plain_ array, not a
   union, so `coerceFieldValue` falls through (`return value`) and zod bare-fails with
   "expected array, received string". Stringified arrays for plain-array params aren't
   coerced.

## Decision 1 — Scope breadth: MINIMAL (match the DoD)

Asked the user: minimal (DoD only) vs. curated cross-tool alias registry vs. general
tolerance layer. **Chosen: minimal.** Exactly the task note — `filters→filter` alias on
`query_notes`; extend coercion so stringified arrays (`fields`) parse like
`filter`/`paths` already do; replace bare zod fails with a shape-naming message.
Narrowest contract surface, lowest risk. No general alias registry, no `.strict()`
relaxation.

## Decision 2 — Alias mechanism placement

Three options weighed:

- (A) Relax `.strict()` to passthrough unknown keys — **rejected**: hides real typos,
  defeats the dictionary discipline (ADR-0005).
- (B) Per-tool handler remap (rename `filters`→`filter` inside `query_notes` handler) —
  **rejected**: scatters the logic, runs _after_ schema validation so the strict object
  has already rejected the key.
- (C) **Central declarative alias map — chosen.** Add optional
  `inputAliases?: Record<alias, canonical>` to the `ITool` interface; `query_notes`
  declares `{ filters: 'filter' }`. `wrapSchemaWithCoercion` wraps the strict object in a
  `z.preprocess` that, for a plain-object input, renames any declared alias key to its
  canonical name _before_ `.strict()` runs. One place, explicit, additive, testable.

Conflict rule: if both `filter` and `filters` are present, **canonical wins** — the
alias key is dropped. (Unlikely; deterministic and safe.)

## Decision 3 — Stringified-array coercion

Extend `coerceFieldValue` with a plain-`ZodArray` branch: when the value is a string,
`JSON.parse` it.

- Parse yields an array → return it. zod then validates element types, so a bad element
  (e.g. `["bogus"]` against the `fields` enum) still produces a precise per-element
  error — we don't swallow type errors.
- Parse fails, or yields a non-array → throw `CoerceError` naming the expected shape
  ("expected array or JSON-string of one, got …").

The existing union branch (`paths`) is untouched — it already handles its case.

## Decision 4 — Error behavior

Failure _mode_ is unchanged: a genuinely unrecoverable value still ends in the fatal
`INVALID_PARAMS` response (clients already branch on this code). What changes is the
_message_ — it now names the expected shape via `CoerceError`, satisfying the task's
"не голий fail" (not a bare fail).

## Boundary (the honest edge of "minimal")

We do **not** relax `.strict()`. A key that is neither canonical nor a declared alias —
e.g. a stray `fields` passed to `query_notes`, which has no such parameter — still errors
as an unrecognized key. That is a _correct_ signal (the param genuinely doesn't exist),
not the dead-end this task targets. The two replay cases from `conv-1780003210445` — the
`filters` alias and the stringified-array value — are both fixed.

## Parameter dictionary

Add `filters` as a documented **accepted alias** of `filter` in
`docs/architecture/mcp-parameter-dictionary.md`. Additive only — the canonical parameter
name is unchanged, so no major version bump (ADR-0005).

## Acceptance criteria

- `query_notes({ filters: {…} })` behaves identically to `{ filter: {…} }`.
- Stringified JSON in `filter` / `fields` / `paths` either parses correctly or returns an
  error naming the expected form — never a bare fail.
- Tests cover both `conv-1780003210445` cases: the `filters` alias and the stringified
  array; plus a regression guard for already-working stringified `filter`, a precise
  enum error for a bad parsed element, and the `{filter, filters}` conflict rule.
- `npm test && npm run lint && npx tsc --noEmit` all pass.

## Connections

- `Inbox/neuro-vault-usage/2026-W23` — case source.
- `Tasks/neuro-vault/Preview-режим тіла для read_notes` — adjacent MCP optimization.
