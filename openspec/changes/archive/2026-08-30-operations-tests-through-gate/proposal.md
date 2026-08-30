Tracked by: #112

## Why

`registerTool` wraps every tool's schema with coercion and `.strict()`, then rejects bad input as `INVALID_PARAMS` before the handler runs. The operations test suite never crosses that seam — 100 handler-direct call sites, zero through the registration. So four `read_notes` tests pin `INVALID_ARGUMENT` for inputs the gate kills first as `INVALID_PARAMS`, one asserts an unknown `fields` key is silently stripped when production rejects it, and three post-gate validation branches are unreachable yet green. Coercion and single-vault `vault` rejection are untested per tool. Two spec scenarios encode the wrong behaviour, one of them contradicting `tolerant-arguments`. The convention that would have prevented this exists only in archived plans.

## What Changes

**Test entry point**
- From: tests call `buildXTool(deps).handler(input)` — past the coercing, strict, `INVALID_PARAMS`-throwing gate.
- To: tests build through `registerTool` and call through `reg.handler`, via shared `callTool<T>()` / `expectToolError()` helpers.
- Reason: make "no tool test enters past the gate" a structural property, not a per-test judgment call.
- Impact: non-breaking; test-only. ~100 call sites in `test/operations/tools/`, ~120 more in `test/semantic/tools/`.

**`read_notes` post-gate validation**
- From: `validateReadNotesInput` re-checks empty `paths`, the 1–50 bound, the `paths` type, and the `content` enum, throwing `INVALID_ARGUMENT`.
- To: deleted. Only the string→array widening survives, inlined into `buildReadNotesTool`. `VALID_CONTENT_MODES` goes with it.
- Reason: all four branches are unreachable — zod rejects each case first.
- Impact: non-breaking. No client-observable behaviour changes; production already returns `INVALID_PARAMS`.

**`read-notes-content-modes` spec**
- From: an invalid `content` value "fails with an `INVALID_ARGUMENT` error"; a legacy `fields` key "is ignored".
- To: `INVALID_PARAMS`; and `fields` is rejected as an unrecognized key.
- Reason: both scenarios describe behaviour production does not have, and the `fields` one contradicts `tolerant-arguments` §"Unknown keys remain rejected".
- Impact: spec correction only — the code is already right.

**New coverage**
- Per-tool coercion (`overwrite: "true"`, JSON-string arrays and objects), strict unknown-key rejection, and rejection of a `vault` param in single-vault mode (`vaultParamShape` returns `{}`, so `.strict()` rejects it).

**Convention recorded durably**
- `docs/adr/0015-*.md` states the gate division as an accepted decision refining ADR-0003; `docs/architecture/mcp-server-shape.md` §"Tool handler contract" is corrected (it currently says handlers throw `INVALID_ARGUMENT` on bad input, with no mention of the gate that rejected it first) and gains the testing-seam rule; `docs/architecture/input-coercion.md` gains the `.strict()` sentence; one line in `AGENTS.md`.

## Capabilities

### New Capabilities

None. This change makes the tests and specs describe the contract that already ships.

### Modified Capabilities

- `read-notes-content-modes`: two scenarios corrected — the invalid-`content` code becomes `INVALID_PARAMS`, and the legacy `fields` key is rejected rather than ignored.
- `tolerant-arguments`: the strict/coercing boundary is stated as applying uniformly to every registered tool, and a `vault` argument supplied in single-vault mode is named as an unknown key.

## Impact

**Production code** — `src/modules/operations/tool-helpers.ts` (delete `validateReadNotesInput` and `VALID_CONTENT_MODES`), `src/modules/operations/tools/read-notes.ts` (inline the widening). No schema, output shape, or error code changes.

**Tests** — new shared gate helper module; all 10 files in `test/operations/tools/`, `_helpers.ts` in both tool suites, and the 4 files in `test/semantic/tools/`. Expect currently-green tests to fail where their input carried keys the schema does not declare; each such failure is a finding, not a reason to relax `.strict()`.

**Docs** — new `docs/adr/0015-*.md` plus its `docs/adr/INDEX.md` rows (including a "refined in part by 0015" note on 0003), `docs/architecture/mcp-server-shape.md`, `docs/architecture/input-coercion.md`, `AGENTS.md`.

**Not touched** — any tool contract, `test/lib/`, `test/server-*.test.ts`, `test/eval/`. ADR-0003 stays Accepted; ADR-0015 refines its boundary rather than superseding it.
