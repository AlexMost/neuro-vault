# Brainstorm — route operations tool-contract tests through the registration gate

Raw capture. Source: GitHub issue #112 (already carries a formed problem
statement), plus a live probe of the real gate run during this session.

## Background

`registerTool` (`src/lib/tool-registry.ts`) is the seam an MCP client actually
crosses. It wraps a tool's declared `inputSchema` with
`wrapSchemaWithCoercion` (`src/lib/input-coercion.ts`), which does two things
the raw schema does not:

1. **Coerces four value shapes** per field — numeric string → number,
   `"true"`/`"false"` → boolean, JSON-string → object, JSON-string → array
   (including the array leg of a union).
2. **Closes the object** — `z.object(newShape).strict()`. Unknown keys are
   rejected, not stripped.

`registerTool`'s handler then `safeParse`s against that wrapped schema and,
on failure, throws `ToolHandlerError('INVALID_PARAMS', …)` with per-field
issues — *before* the tool's own handler runs. In production the schema is
double-layered: `server.ts` also hands the wrapped schema to the MCP SDK.

Errors that cross this seam are **returned**, not thrown: `invokeTool` catches
and renders them as `CallToolResult { isError: true, structuredContent: { code,
message, details } }` (ADR-0003).

## The finding

The operations test suite never crosses that seam. 100 handler-direct call
sites across the 10 files in `test/operations/tools/`; zero go through
`registerTool` / `reg.spec.inputSchema` for validation behaviour.

A probe run this session against the real gate (temporary test file, deleted)
confirmed every claim in the issue:

| Input | What `read-notes.test.ts` pins | What the gate actually returns |
| --- | --- | --- |
| `{ paths: '' }` | `INVALID_ARGUMENT` | `INVALID_PARAMS` — `paths: Too small: expected string to have >=1 characters` |
| `{ paths: [] }` | `INVALID_ARGUMENT` | `INVALID_PARAMS` — `paths: Too small: expected array to have >=1 items` |
| 51 paths | `INVALID_ARGUMENT` | `INVALID_PARAMS` — `paths: Too big: expected array to have <=50 items` |
| `{ content: 'none' }` | `INVALID_ARGUMENT` | `INVALID_PARAMS` — `content: Invalid option: expected one of "full"\|"preview"\|"frontmatter"` |
| `{ paths: ['a.md'], fields: [...] }` | silently stripped, `success: true` | `INVALID_PARAMS` — `<root>: Unrecognized key: "fields"` |
| `{ paths: ['a.md'], vault: 'v' }` (single-vault) | *no test anywhere* | `INVALID_PARAMS` — `<root>: Unrecognized key: "vault"` |

Consequences:

- All four `INVALID_ARGUMENT` branches in `validateReadNotesInput`
  (`src/modules/operations/tool-helpers.ts:124-153`) are **unreachable in
  production**. The tests keep them green by entering past the gate.
- `read-notes.test.ts:282-292` documents behaviour production does not have —
  it asserts on the *raw*, non-strict `tool.inputSchema`, where `.strict()` has
  not yet been applied.
- Never exercised per tool: coercion (`overwrite: "true"`, JSON-string
  arrays/objects) and the single-vault strict rejection of a supplied `vault`
  (`vaultParamShape` returns `{}` in single-vault mode → `.strict()` rejects).

The convention this violates is real and repo-old — it is stated in at least
four archived opsx plans (`2026-07-05-hybrid-search-notes/plan.md:18`,
`2026-08-10-split-leg-thresholds/plan.md:14`,
`2026-08-20-unify-retrieval-pipeline/plan.md:17`,
`2026-08-20-multi-vault-dispatch-builder/plan.md:17`). It appears in **no
durable doc** — not `AGENTS.md`, not `docs/`. That is a large part of why it
keeps being missed: an archived plan is not in anyone's context window.

## Decision chain

### Q1 — How deep does the migration go in `test/operations/tools/`?

Options weighed:

- **(a) Contract tests only** — validation tests go through the gate,
  result-shape and per-item-error tests stay handler-direct. Smallest diff,
  matches issue #112's acceptance wording verbatim. Leaves the judgment call
  *"is this test contract or semantics?"* in place for the next author — which
  is precisely the judgment that let the debt accumulate.
- **(b) All call sites, via typed helpers** — every test builds through
  `registerTool` and calls through `reg.handler`, using a shared
  `callTool<T>()` / `expectToolError()` pair. Removes the judgment call
  entirely: routing through the gate becomes the only idiom the test files
  contain. ~100 mechanical call-site edits.
- **(c) `read_notes` only now, rest as a follow-up** — fastest to land, leaves
  most of the debt standing.

**Decision: (b).** The property we want is *structural* ("no operations test
can enter past the gate"), not *case-by-case*. A structural property survives
the next contributor; a judgment call does not.

The ergonomic objection to (b) — that gate calls return `CallToolResult`, not
the tool's typed payload — dissolves with the right helper. `callTool` unwraps
`structuredContent` with a generic cast and **re-throws** error results as a
`ToolHandlerError`, so existing `await expect(...).rejects.toMatchObject({ code })`
assertions survive the migration almost verbatim.

### Q2 — What happens to `validateReadNotesInput`?

Options: delete it and inline the surviving logic, vs. slim it to a named
`normalizeReadNotesPaths()` helper that keeps a unit-test seam.

**Decision: delete.** Only the string→array widening survives — three lines
inside `buildReadNotesTool`. Keeping a named validation helper leaves an
attractive place for a future author to re-grow post-gate validation that zod
already owns. `VALID_CONTENT_MODES` goes with it (it has no other consumer).

### Q3 — Where does the SDK-gate convention get recorded?

**Decision: both.** One line in `AGENTS.md` (the file already loaded into every
agent session) plus a short `docs/architecture/` page explaining the two-gate
collapse — which gate owns what, and why `INVALID_PARAMS` is the client-facing
code for a schema failure. `docs/architecture/` is the living how-it-works
record (ADR-0008), and this is a mechanism, not a decision.

### Q4 — Is the semantic suite in scope?

Issue #112 calls this "repo-wide debt, worst in operations" and scopes itself
to operations. But `test/semantic/tools/_helpers.ts:291` — the shared
`runSearch` helper behind ~120 call sites — is handler-direct too, and the four
semantic test files add ~119 more direct `.handler(` calls.

**Decision: in scope.** Converting semantic in the same change means the
`AGENTS.md` line is *true repo-wide the day it is written*, rather than being a
rule with a large known exception. Roughly doubles the diff; delivered as its
own PR so the review surface stays bounded.

## Design trade-offs

**Two gates, one contract.** ADR-0003 makes the error `code` the client-facing
contract. Today which of `INVALID_PARAMS` / `INVALID_ARGUMENT` a caller sees
for the same mistake depends on which gate fires first. No ADR is reopened —
the gates collapse instead:

- **zod (`INVALID_PARAMS`)** owns everything expressible in a schema: types,
  enums, string/array bounds, unknown keys, coercion.
- **`INVALID_ARGUMENT`** stays for semantic argument errors zod cannot express:
  exactly-one-of `name`/`path`, path traversal, list items containing commas,
  date-format-versus-declared-`type`.

**Errors are returned, not thrown, at the gate.** The migration hinges on
`callTool` re-throwing them, so the two call styles converge on one assertion
idiom. Tests whose subject genuinely *is* the `CallToolResult` envelope (the
`edit_note` `WRITE_FAILED` block already does this) keep calling
`reg.handler` directly and assert `isError` / `structuredContent`.

**Expect the migration to break currently-green tests.** Any test input
carrying a key the schema does not declare will now fail with `Unrecognized
key`. Each such failure is the change doing its job: either the test input was
sloppy, or it documents a contract the schema does not actually offer. Neither
should be papered over by loosening `.strict()`.

**Fixture arity is now load-bearing.** Surfaced by the probe: `read_notes`
projects reader items positionally (`projected[projectedIdx++]`), so a mock
reader returning fewer items than paths yields an opaque
`Cannot use 'in' operator to search for 'error' in undefined`. Harmless in
production (real readers return one item per path) but it will make sloppy
migrated fixtures fail confusingly rather than clearly.

## Delivery shape

Four PRs against `main`, each independently green on
`npm test && npm run lint && npm run typecheck`:

1. Shared gate helpers + `read_notes` migrated + dead branches deleted + false
   pins rewritten to the real codes.
2. The other nine operations test files + new per-tool coercion, strict, and
   single-vault-`vault` coverage.
3. Semantic suite: `runSearch` and the four `test/semantic/tools/` files.
4. Docs: `AGENTS.md` line + `docs/architecture/` page. `Closes #112`.

## Out of scope

- Any change to a tool's input schema, output shape, or error codes. This
  change makes the tests describe the contract that already exists.
- Reopening ADR-0003.
- `test/lib/`, `test/server-*.test.ts`, `test/eval/` — these do not test tools
  through a registration.
