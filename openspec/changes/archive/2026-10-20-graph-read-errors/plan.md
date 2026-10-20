# Graph read errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wherever a failed graph read can reach a client, it reads as `DEPENDENCY_ERROR`
(`Graph read failed`, `details: { vault, operation }`), with the cause on stderr only.

**Architecture:** One decorator, `graphForTool(entry, operation, warn?)`, wraps `entry.graph`
and maps `GraphReadError` (design D1). Each consumer passes it where it passed `entry.graph`.
Under `--no-semantic`, `createStandaloneGraphReader` makes every failed build a
`GraphReadError` (D2).

**Tech Stack:** TypeScript ESM, vitest, zod (via the registration gate).

**Spec:** `specs/shared-wikilink-graph/spec.md` (ADDED: "A failed graph read is a dependency
error") and `design.md` in this change.

**Execution:** this runs in a side session started by another session. It runs natively (the
session implements every task itself), followed by one fresh whole-branch reviewer. The tasks
are small and share one interface.

## Global Constraints

- Message: exactly `Graph read failed`. Code: `DEPENDENCY_ERROR`. Details: exactly
  `{ vault: <entry.name>, operation: <tool name | resource URI> }`.
- stderr line: `neuro-vault graph: <operation> failed for vault "<vault>": <cause.message>`.
- The cause text never appears in the response message or details.
- Tool tests go through `registerTool(buildXTool(deps))` and `callTool` / `expectToolError`
  (`test/_gate.ts`), never `.handler` directly (ADR-0015).
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` all pass. Commit bodies
  have lines of 100 characters or fewer and one `Co-Authored-By` trailer.

## Review Focus

1. A fan-out where one vault's graph fails: the other vault still answers (pinned in 3.1, 3.3
   and 3.4, each with two vaults).
2. A non-`GraphReadError` from a graph read (a bug): it must not be relabelled `DEPENDENCY_ERROR`
   (pinned in 1.1).
3. `get_similar_notes` with a missing note file: still `NOT_FOUND`, not `DEPENDENCY_ERROR`
   (pinned in 3.6).
4. `search_notes` with no matches: still makes no graph read, so it cannot fail on the graph
   (existing test, kept).
5. The cause text leaking through `details` or `message` (each consumer test asserts the
   message is exactly `Graph read failed` and that details equal `{ vault, operation }`).

---

### Task 1: `graphForTool`

**Files:** Create `src/lib/tool-graph.ts`, `test/lib/tool-graph.test.ts`.

**Interfaces:**
- Produces: `graphForTool(entry: Pick<IRegisteredVault, 'name' | 'graph'>, operation: string, warn?: (message: string) => void): IGraphReader`.
  `warn` defaults to `console.error`.

- [ ] Step 1: Write the tests. For each of `noteLinks`, `backlinkCounts` and `resolve`:
  - The read delegates its argument and returns the inner answer.
  - A `new GraphReadError('daemon did not answer graph.x in time')` rejects as a
    `ToolHandlerError` with `code: 'DEPENDENCY_ERROR'`, `message: 'Graph read failed'`,
    `details: { vault: 'v', operation: 'op' }` and `cause` equal to the original error.
  - `warn` is called once with
    `'neuro-vault graph: op failed for vault "v": daemon did not answer graph.x in time'`.
  - A `TypeError('boom')` rejects as that same `TypeError`, and `warn` is not called.
- [ ] Step 2: `npx vitest run test/lib/tool-graph.test.ts`. Expected: it fails (module missing).
- [ ] Step 3: Implement it with one private `mapped<T>(read: () => Promise<T>)` that catches.
- [ ] Step 4: Run again. Expected: it passes.

### Task 2: `createStandaloneGraphReader`

**Files:** Create `src/modules/semantic/graph/standalone-reader.ts`. Modify
`src/modules/semantic/graph/index.ts` (export) and `src/modules/semantic/index.ts`
(`graphFactory` uses it). Test: `test/semantic/graph/standalone-reader.test.ts`.

**Interfaces:**
- Produces: `createStandaloneGraphReader(graph: IVaultGraph): IGraphReader`.

- [ ] Step 1: Write the tests.
  - Over a real `WikilinkGraphIndex` on `readerOf(...)`, its answers equal
    `createGraphReader(() => graph)`'s.
  - With a graph stub whose `ensureFresh` rejects with `Error('scan failed')`, each of the
    three reads rejects with a `GraphReadError` whose `cause` is that error and whose message
    contains `scan failed`.
  - A `GraphReadError` from the inner reader passes through as the same instance.
- [ ] Step 2: Run. Expected: it fails.
- [ ] Step 3: Implement it by wrapping `createGraphReader(() => graph)`. A non-`GraphReadError`
  becomes `new GraphReadError(\`graph read failed: ${message}\`, { cause })`.
- [ ] Step 4: In `test/semantic/lexical-only-factories.test.ts`, test that the factory's graph
  rejects with a `GraphReadError` when the reader's `scan` throws. Run. Expected: it passes.

### Task 3: consumers (needs Task 1)

Each step swaps `entry.graph` for `graphForTool(entry, '<op>')` at one site, adds its gate
test, and runs that test file. The failing-graph double is
`makeVaultGraph({ <read>: vi.fn(async () => { throw new GraphReadError('daemon did not answer in time'); }) })`.

- [ ] 3.1 `src/modules/semantic/tools/search-notes.ts`: the `backlinkCounts` stamp uses
  `graphForTool(entry, 'search_notes', warn)`. In `test/semantic/tools/search-notes.test.ts`:
  a single vault with a match gives `DEPENDENCY_ERROR` with details
  `{ vault, operation: 'search_notes' }`, and `warn` receives the cause. A two-vault fan-out
  has one entry in `failed_vaults` with that error, and the other vault is in
  `results_by_vault`.
- [ ] 3.2 `src/modules/operations/tools/get-note-links.ts`, tested in `get-note-links.test.ts`:
  a single vault gives `DEPENDENCY_ERROR`. A `console.error` spy gets the cause, and the
  message does not contain it.
- [ ] 3.3 `get-vault-overview.ts` (`'get_vault_overview'`) and `resources/vault-overview.ts`
  (operation `uri`). Tests: the tool, single vault plus a two-vault `failed_vaults` entry. The
  resource handler for `vault://overview` rejects with `DEPENDENCY_ERROR` and
  `details.operation === 'vault://overview'`.
- [ ] 3.4 `query-notes.ts` (`'query_notes'`): single vault, plus a two-vault `failed_vaults`
  entry.
- [ ] 3.5 `read-daily.ts` (`'read_daily'`): single vault gives `DEPENDENCY_ERROR`.
- [ ] 3.6 `get-similar-notes.ts`: `resolver: graphForTool(args.entry, 'get_similar_notes')`. A
  failing `resolve` gives `DEPENDENCY_ERROR`. The existing missing-file test stays `NOT_FOUND`.
- [ ] 3.7 Commit: `fix(graph): map a failed graph read to DEPENDENCY_ERROR` (with Tasks 1–2).

### Task 4: docs, gates, close-out

- [ ] 4.1 Docs:
  - `docs/architecture/wikilink-graph.md`: an **Errors** paragraph after the consumer table,
    and the `--no-semantic` wiring now names `createStandaloneGraphReader`.
  - `docs/architecture/vault-registry.md`: `graph` failures surface as `GraphReadError`,
    mapped by `graphForTool`.
  - `docs/guide/finding-notes.md`: a graph-failure sentence beside the lexical one.
  - `docs/guide/reading-and-modifying.md`: a graph failure is a `DEPENDENCY_ERROR` entry in
    `failed_vaults`.
  - `IRegisteredVault.graph` doc comment.
- [ ] 4.2 Run `npm test && npm run lint && npm run typecheck && npm run format && npm run build`.
  Expected: all clean.
- [ ] 4.3 Get a whole-branch review from a fresh subagent and fix its findings.
- [ ] 4.4 Write verify.md and retrospective.md, run `npx openspec archive graph-read-errors -y`,
  check commitlint, then open the PR with `Closes #212`.
