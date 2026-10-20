# Resource error envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resource read that fails with a `ToolHandlerError` gives the client its `code` and
`details` in JSON-RPC `error.data`.

**Architecture:** `registerResource`'s handler wrapper catches a `ToolHandlerError` and throws a
local `ResourceReadError` (numeric `code`, `data`) that the SDK puts on the wire as is (design
D1–D4). Everything else is rethrown. ADR-0023 records the contract (D5).

**Tech Stack:** TypeScript ESM, vitest, `@modelcontextprotocol/sdk` 1.29.0 (`McpServer`,
`Client`, `InMemoryTransport`).

**Spec:** `specs/tool-response-envelope/spec.md` (ADDED) and
`specs/shared-wikilink-graph/spec.md` (MODIFIED) in this change, plus `design.md`.

**Execution:** native. This runs in a side session, and the user approved the design in chat. The
two code tasks share one small interface, so one fresh whole-branch reviewer at the end is enough.

## Global Constraints

- JSON-RPC code: `-32603` (`ErrorCode.InternalError`) for every `ToolHandlerError`.
- JSON-RPC message: the `ToolHandlerError`'s message, unprefixed on the server side.
- `data`: `{ code }`, plus `details` only when the error has them. Never the cause.
- A non-`ToolHandlerError` is rethrown as the same object.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass. Commit body lines are
  100 characters or fewer, with one `Co-Authored-By` trailer.

## Review Focus

1. The cause leaking: a `ToolHandlerError` with a `cause` whose message must not appear in the
   client's error (pinned in Task 1).
2. A double prefix: the client's message must be exactly `MCP error -32603: Graph read failed`
   (pinned in Tasks 1 and 2).
3. `details: undefined` serialised as a key: the client's `data` must have no `details` key
   (pinned in Task 1).
4. A plain `Error` gaining `data` (pinned in Task 1).
5. A successful read changing shape (the existing unit tests stay).

---

### Task 1: `registerResource` maps a `ToolHandlerError`

**Files:**
- Modify: `src/lib/resource-registry.ts`
- Test: `test/lib/resource-registry.test.ts`

**Interfaces:**
- Produces: `class ResourceReadError extends Error { readonly code: number; readonly data: { code: string; details?: Record<string, unknown> } }`,
  exported from `src/lib/resource-registry.ts`. Constructed from a `ToolHandlerError`, with that
  error as its `cause`.
- Produces (test helper, in the test file): `readOverWire(resource: IResource<unknown>): Promise<unknown>`
  — registers `registerResource(resource)` on a `new McpServer(...)`, connects an SDK `Client`
  through `InMemoryTransport.createLinkedPair()`, calls `client.readResource({ uri })`, and
  returns the rejection (closing both ends after).

- [ ] **Step 1: Write the failing tests** in a new `describe('registerResource: errors on the wire')`:
  - `a ToolHandlerError with details reaches the client as data` — handler throws
    `new ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault: 'work', operation: 'demo://thing' }, cause: new Error('daemon did not answer in time') })`.
    Expect an `McpError` with `code: -32603`, `message: 'MCP error -32603: Graph read failed'`,
    `data: { code: 'DEPENDENCY_ERROR', details: { vault: 'work', operation: 'demo://thing' } }`,
    and `JSON.stringify(error)` plus `error.message` not containing `daemon did not answer`.
  - `a ToolHandlerError without details has no details key` — `data` toEqual `{ code: 'NOT_FOUND' }`
    and `'details' in data` is false.
  - `a plain Error reaches the client with its message and no data` —
    `new Error('disk read failed')` → `code: -32603`, `message: 'MCP error -32603: disk read failed'`,
    `data` undefined.
- [ ] **Step 2: Run** `npx vitest run test/lib/resource-registry.test.ts`. Expected: the first two FAIL
  (`data` undefined); the plain-Error test passes already.
- [ ] **Step 3: Implement** `ResourceReadError` and the `try/catch` in the handler wrapper. Use
  `ErrorCode.InternalError` from `@modelcontextprotocol/sdk/types.js`. Spread `details` only when
  defined.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(resources): carry a ToolHandlerError's code and details on the wire`.

### Task 2: The overview resource on the wire

**Files:**
- Test: `test/operations/resources/vault-overview.test.ts`

**Interfaces:**
- Consumes: `registerResource` (Task 1), `buildVaultOverviewResource`, `failingGraph`.

- [ ] **Step 1: Write the test** `vault://overview reports DEPENDENCY_ERROR and details to an SDK client`:
  register `registerResource(buildVaultOverviewResource({ uri: 'vault://overview', entry }))` with
  `graph: failingGraph('backlinkCounts', 'lost')` on a real `McpServer`, read it with a `Client`
  over `InMemoryTransport`. Expect `code: -32603`, `message: 'MCP error -32603: Graph read failed'`,
  `data: { code: 'DEPENDENCY_ERROR', details: { vault: 'v', operation: 'vault://overview' } }`,
  and `lost` absent from the message and `data`. Silence `console.error` with a spy.
- [ ] **Step 2: Run** `npx vitest run test/operations/resources/vault-overview.test.ts`. Expected: PASS
  (Task 1 is in).
- [ ] **Step 3: Commit** `test(resources): pin the overview resource's error on the wire`.

### Task 3: ADR and docs

**Files:**
- Create: `docs/adr/0023-resource-errors-carry-the-error-code.md` (template `0000-template.md`)
- Modify: `docs/adr/INDEX.md` (ADR-0003's status: "extended to resources by [0023]"; new row 0023)
- Modify: `docs/architecture/mcp-server-shape.md` (a resource-errors paragraph next to the
  resource scaffolding paragraph)
- Modify: `docs/architecture/wikilink-graph.md` (the `graphForTool` paragraph: drop "carrying
  only its message"; the resource gets the code and details in `data`)
- Modify: `docs/guide/reading-and-modifying.md` (the Wikilink graph failures paragraph: a resource
  read fails with `data: { code, details }`)

- [ ] **Step 1:** Write the ADR (Context, Decision, Consequences, Alternatives: D2–D4).
- [ ] **Step 2:** Edit the index and the three docs. Then `grep -rn "message only\|only its message\|carry no .code" docs/`
  returns nothing about resources.
- [ ] **Step 3: Run** `npm run format`. Commit `docs(resources): ADR-0023 and docs for resource errors`.

### Task 4: Gates, verify, archive, PR

- [ ] **Step 1:** `npm test && npm run lint && npm run typecheck && npm run format && npm run build`, all PASS.
- [ ] **Step 2:** one fresh whole-branch reviewer; fix what it confirms.
- [ ] **Step 3:** `verify.md` → `retrospective.md` → `npx openspec archive resource-error-envelope -y`.
- [ ] **Step 4:** `npx commitlint --from origin/main --to HEAD`, push, `gh pr create` with `Closes #214`.
