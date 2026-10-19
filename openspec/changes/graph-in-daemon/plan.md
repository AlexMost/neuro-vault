# graph-in-daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One wikilink graph per vault directory — the vault entry's — read by every attached session through batched `graph.*` methods on its vault client, with the session-built graph deleted.

**Architecture:** The entry already builds a `WikilinkGraphIndex` for the lexical tie-break; it becomes the one graph, exposed as an async `IGraphReader` (`createGraphReader`) and served by a `graph` service in `createVaultEntryServices`, so the daemon and the in-process loopback serve it alike. The session reads it through `createGraphReaderView(client)` over the vault's one client; under `--no-semantic` the session hosts the same index behind the same adapter. PR 1 lands all of that dark; PR 2 moves the consumers.

**Tech Stack:** TypeScript ESM, zod 4 (`defineMethod`), vitest, JSON-RPC over the daemon socket.

**Spec:** `openspec/changes/graph-in-daemon/` — `design.md` (D1–D6), `specs/shared-wikilink-graph/spec.md`, and the three delta specs. `brainstorm.md` holds the why.

## Global Constraints

- No tool's input schema, output shape or error code changes; `npm run eval` identical to main.
- Graph TTL stays `3 * 60 * 1000` ms (`DEFAULT_TTL_MS` in `wikilink-graph.ts`); the session waits at most 30 s (`VAULT_CALL_TIMEOUTS.default`, unchanged).
- Wire methods exactly `graph.noteLinks`, `graph.backlinkCounts`, `graph.resolve`; error code exactly `GRAPH_FAILED`.
- Every method declared with `defineMethod` and a `z.strictObject` schema; one schema per method.
- Interfaces take the `I` prefix; wire types in `protocol.ts` stay unprefixed.
- `npm test`, `npm run lint` (`eslint .`), `npm run typecheck`, `npm run format` pass before every commit; commit bodies ≤ 100 chars per line; one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
- Never touch `.scratch/`. Tool tests go through `registerTool(buildXTool(deps))` and `test/_gate.ts`.

## Review Focus

- **Duplicate paths in one `backlinkCounts` call** (`query_notes` merges prefixes; a caller may repeat a path) → each position answers its own count; covered in Task 1.
- **A scope change between two reads of one tool call** → each read answers from one build; a swapped graph is seen by the next call only; covered in Task 1 (`current()` read once per call).
- **A daemon answer of the wrong shape** (a missing `counts`, a list shorter than the request) → a `GraphReadError`, never a silent `undefined` count; covered in Task 5.
- **A read on a dropped entry** (the last client left and the idle timer fired) → a later call is `NOT_ATTACHED`, since the record goes before the entry is disposed; a read on the disposed entry itself rejects with `vault entry: disposed`; covered in Tasks 3 and 4.
- **An attach with `profiles: []`** (a vault with `"semantic": false`) → graph reads answered, not refused; covered in Tasks 3 and 4.

---

## PR 1 — dark foundation (`Refs #172`)

### Task 1: `IGraphReader` and `createGraphReader`

**Files:**
- Create: `src/lib/obsidian/graph-reader.ts`
- Test: `test/lib/obsidian/graph-reader.test.ts`

**Interfaces:**
- Consumes: `IVaultGraph`, `NoteLinks`, `WikilinkGraphIndex` from `src/lib/obsidian/wikilink-graph.ts`.
- Produces:
  ```ts
  export interface IGraphReader {
    noteLinks(notePath: string): Promise<NoteLinks>;
    backlinkCounts(paths: readonly string[]): Promise<number[]>;
    resolve(targets: readonly string[]): Promise<(string | null)[]>;
  }
  export class GraphReadError extends Error {} // name 'GraphReadError'; (message, { cause }) ctor
  export function createGraphReader(current: () => IVaultGraph): IGraphReader;
  ```

- [ ] **Step 1: Write the failing tests** (`describe('createGraphReader')`), using a real `WikilinkGraphIndex` over a stub `VaultReader` (`scan` → `['a.md', 'b.md', 'notes/Alpha.md']`; `a.md` and `b.md` both link `[[Alpha]]`, `a.md` also links `[[Nowhere]]`) and spies where noted:
  - `backlinkCounts(['b.md', 'missing.md', 'notes/Alpha.md', 'notes/Alpha.md'])` → `[0, 0, 2, 2]`.
  - `resolve(['Alpha', 'Nowhere'])` → `['notes/Alpha.md', null]`.
  - `noteLinks('a.md')` → outgoing `[{ target: 'Alpha', resolved: true, path: 'notes/Alpha.md' }, { target: 'Nowhere', resolved: false }]`, incoming `[]`; `noteLinks('missing.md')` → `{ incoming: [], outgoing: [] }`.
  - `backlinkCounts([])` and `resolve([])` → `[]`.
  - With a spy graph (`makeVaultGraph` from `test/_vault-graph.ts`): each read calls `ensureFresh` once and `current` once.
  - Swap: `current` returns graph A, then graph B; one `backlinkCounts` call reads A only (both `getBacklinkCount` calls on A), the next reads B.
  - A rejecting `ensureFresh` (`new Error('scan failed')`) rejects the read with that same error.

- [ ] **Step 2: Run** `npx vitest run test/lib/obsidian/graph-reader.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement** in `src/lib/obsidian/graph-reader.ts`: one private `fresh()` that reads `current()` once and awaits its `ensureFresh()`, then each method maps over that graph's sync reads. Doc comments say: answers come from one build per call; no error is wrapped (the host decides).

- [ ] **Step 4: Run** the test file — PASS; `npm run typecheck` — clean.

- [ ] **Step 5: Commit** `feat(graph): an async, batched reader over a wikilink graph`

### Task 2: The `graph.*` rows in the protocol

**Files:**
- Modify: `src/daemon/protocol.ts` (beside `lexicalSearchParams`, the `VaultMethods` interface, `DaemonErrorCode`, `JSON_RPC_CODE`)
- Modify: `test/daemon/protocol.test.ts:40`, `test/daemon/socket-server.test.ts:177` (`graph.links` → `watch.subscribe`)
- Test: `test/daemon/method-params.test.ts` (rows added in Task 4, once the service exists)

**Interfaces:**
- Produces:
  ```ts
  export const graphNoteLinksParams = z.strictObject({ vault: z.string(), path: z.string() });
  export type GraphNoteLinksParams = z.infer<typeof graphNoteLinksParams>;
  export type GraphNoteLinksResult = NoteLinks;
  export const graphBacklinkCountsParams = z.strictObject({ vault: z.string(), paths: strings });
  export type GraphBacklinkCountsParams = z.infer<typeof graphBacklinkCountsParams>;
  export interface GraphBacklinkCountsResult { counts: number[] }
  export const graphResolveParams = z.strictObject({ vault: z.string(), targets: strings });
  export type GraphResolveParams = z.infer<typeof graphResolveParams>;
  export interface GraphResolveResult { paths: (string | null)[] }
  // VaultMethods rows: 'graph.noteLinks' | 'graph.backlinkCounts' | 'graph.resolve'
  // DaemonErrorCode: | 'GRAPH_FAILED'  →  JSON_RPC_CODE: ErrorCode.InternalError
  ```

- [ ] **Step 1: Add the schemas, types, rows and code** as above. `NoteLinks` is a type-only import from `../lib/obsidian/wikilink-graph.js`. Each schema's doc comment: one answer per path / target, in order; empty lists pass.
- [ ] **Step 2: Rename the unknown-method examples** in the two test files to `watch.subscribe`.
- [ ] **Step 3: Run** `npx vitest run test/daemon` and `npm run typecheck` — PASS / clean.
- [ ] **Step 4: Commit** `feat(daemon): graph.* rows, schemas and GRAPH_FAILED in the protocol`

### Task 3: The entry's one graph as a reader

**Files:**
- Modify: `src/lib/vault-entry/vault-entry.ts` (`IVaultEntry`, `createVaultEntry`)
- Modify: `src/lib/vault-entry/vault-entries.ts` (`lexical()` → shared private `attachedEntry`, new `graph()`)
- Test: `test/lib/vault-entry/vault-entry.test.ts`, `test/lib/vault-entry/vault-entries.test.ts`

**Interfaces:**
- Consumes: `createGraphReader`, `IGraphReader` (Task 1).
- Produces: `IVaultEntry.graph: IGraphReader`; `VaultEntries.graph(clientId: number, vault: string): IGraphReader` (throws `VaultEntryError('NOT_ATTACHED', …)` with the same message as `lexical()`).

- [ ] **Step 1: Write the failing entry tests** (temp vault, real `createVaultEntry`, `graphTtlMs` default unless noted):
  - `entry.graph.backlinkCounts(['b.md'])` → `[1]` where `a.md` links `[[b]]`.
  - One build for both: after a `lexicalSearch` (which builds the graph for its tie-break), add `[[b]]` to `c.md` on disk; `graph.backlinkCounts(['b.md'])` still answers `[1]` — the tie-break's build, within the TTL.
  - `setScope` to a scope excluding `a.md` → `graph.backlinkCounts(['b.md'])` → `[0]`, and `graph.noteLinks('a.md')` → empty.
  - After `dispose()`, `graph.noteLinks('a.md')` rejects with `vault entry: disposed`.
- [ ] **Step 2: Write the failing `VaultEntries` tests:** a client attached with `profiles: []` gets a reader whose `backlinkCounts` answers; an unattached client id, and an attached client asking another vault, throw `NOT_ATTACHED`; two clients attached to one root get readers answering from one entry (same counts after a disk change within the TTL).
- [ ] **Step 3: Run** both files — FAIL.
- [ ] **Step 4: Implement.** In `createVaultEntry`, build `const graphReader = createGraphReader(() => { if (graph === null) throw new Error('vault entry: disposed'); return graph; })` once and expose it as `graph`; `lexicalSearch` unchanged. Update the `lexicalSearch` doc comment ("ranked with the entry's one wikilink graph") and `IVaultEntryOptions.graphTtlMs` ("the graph's TTL"). In `VaultEntries`, extract `private attachedEntry(clientId, vault): IVaultEntry` from `lexical()` and add `graph(clientId, vault) { return this.attachedEntry(clientId, vault).graph; }` with the entry-level doc comment `lexical()` has.
- [ ] **Step 5: Run** both files and `npx vitest run test/lib/vault-entry` — PASS.
- [ ] **Step 6: Commit** `feat(vault-entry): expose the entry's one wikilink graph as a reader`

### Task 4: The `graph` service

**Files:**
- Create: `src/daemon/services/graph.ts`
- Modify: `src/daemon/services/vault-entry-services.ts` (`VaultEntriesPorts` gains `GraphEntriesPort`; map gains `graph`)
- Test: `test/daemon/graph-service.test.ts`; `test/daemon/vault-entry-services.test.ts` (four namespaces; fake gains `graph`); `test/daemon/method-params.test.ts` (VALID rows + cases; fake entries gain `graph`)

**Interfaces:**
- Consumes: Task 2 schemas and result types; `VaultEntries.graph` (Task 3); `wired` from `./wired.js`.
- Produces: `export type GraphEntriesPort = Pick<VaultEntries, 'graph'>; export function createGraphService(entries: GraphEntriesPort): ServiceHandlers` with handlers `noteLinks`, `backlinkCounts`, `resolve`.

- [ ] **Step 1: Write the failing service tests** through a `ServiceRegistry` (model: `test/daemon/lexical-service.test.ts`, fake `entries.graph` that throws `NOT_ATTACHED` for any vault but `/real/vault`):
  - `graph.noteLinks { vault, path: 'a.md' }` → result equals the fake reader's `NoteLinks`; reader called with `'a.md'`; `entries.graph` called with `(1, VAULT)`.
  - `graph.backlinkCounts { vault, paths: ['a.md', 'b.md'] }` → `{ counts: [2, 0] }`.
  - `graph.resolve { vault, targets: ['Alpha'] }` → `{ paths: ['notes/Alpha.md'] }`.
  - Another vault → `data.code` `NOT_ATTACHED`, reader untouched.
  - A reader rejecting `new Error('vault entry: disposed')` → `data.code` `GRAPH_FAILED`, message `vault entry: disposed`.
- [ ] **Step 2: Extend `method-params.test.ts`:** `VALID` gains `'graph.noteLinks': { vault: VAULT, path: 'a.md' }`, `'graph.backlinkCounts': { vault: VAULT, paths: ['a.md'] }`, `'graph.resolve': { vault: VAULT, targets: ['A'] }`; cases per method: no params, a missing vault, a non-string vault, an unknown key; plus a missing / non-array / non-string-entry `path` / `paths` / `targets` each. Add a valid-call case showing empty `paths` and `targets` reach the reader. The fake `entries` gains `graph: vi.fn(() => reader)` with spy reads.
- [ ] **Step 3: Write the in-process test** (in `graph-service.test.ts`, `describe('over the in-process link')`): real `VaultEntries` over a temp vault (as `test/integration/vault-client.test.ts` builds them, `idleTimeoutMs: 0`), `createInProcessLink(createVaultEntryServices(entries))`; `vault.attach { vault: root, profiles: [] }`, then each `graph.*` with the answered key returns the vault's links; `graph.resolve` with `{ ..., extra: 1 }` rejects with a `DaemonRpcError` `INVALID_PARAMS`.
- [ ] **Step 4: Run** `npx vitest run test/daemon` — FAIL.
- [ ] **Step 5: Implement** `createGraphService`: each handler `const graph = await wired(() => entries.graph(ctx.id, call.vault))`, then the read inside a local `reading()` that rethrows any error as `DaemonRpcError('GRAPH_FAILED', message)`. Results: `noteLinks` as is; `{ counts }`; `{ paths }`. Register `graph: createGraphService(entries)` in `createVaultEntryServices` and update its doc comment (four services).
- [ ] **Step 6: Run** `npx vitest run test/daemon` — PASS.
- [ ] **Step 7: Commit** `feat(daemon): serve the vault entry's graph as graph.*`

### Task 5: The session view

**Files:**
- Create: `src/modules/semantic/graph/view.ts`, `src/modules/semantic/graph/index.ts`
- Test: `test/semantic/graph/view.test.ts`

**Interfaces:**
- Consumes: `IVaultClient` (`src/modules/semantic/vault-client/index.js`), `IGraphReader`, `GraphReadError` (Task 1), the Task 2 rows, `DaemonConnectionError` / `DaemonTimeoutError` (`../daemon-connection.js`).
- Produces: `export function createGraphReaderView(client: IVaultClient): IGraphReader`; `graph/index.ts` re-exports it.

- [ ] **Step 1: Write the failing tests** over a fake client (`{ call: vi.fn(), status, warm, dispose }`):
  - `noteLinks('a.md')` → one `call('graph.noteLinks', { path: 'a.md' })`, answer passed through.
  - `backlinkCounts(['a.md', 'b.md'])` → `call('graph.backlinkCounts', { paths: ['a.md', 'b.md'] })`, answers `[2, 0]` from `{ counts: [2, 0] }`.
  - `resolve(['A'])` → `call('graph.resolve', { targets: ['A'] })`, answers `['x.md']`.
  - `backlinkCounts([])` / `resolve([])` → `[]`, `call` not called.
  - `{ counts: [1] }` for two paths, `{}` for counts, `{ paths: 'x' }` for resolve, and a `noteLinks` answer without `incoming` → `GraphReadError` (message names the method).
  - `DaemonRpcError('GRAPH_FAILED', 'boom')`, `DaemonRpcError('NOT_ATTACHED', …)`, a `DaemonTimeoutError`, a `DaemonConnectionError`, a plain `Error` → each a `GraphReadError` whose `cause` is the original; the timeout reads `daemon did not answer graph.backlinkCounts in time`.
- [ ] **Step 2: Run** `npx vitest run test/semantic/graph` — FAIL.
- [ ] **Step 3: Implement** after `src/modules/semantic/lexical/view.ts`: one `failure(method, error)` mapper, one shape check per method, the doc comment saying none of the failures flips the switch and `NOT_ATTACHED` has already made the client forget.
- [ ] **Step 4: Run** the test file — PASS; `npm run lint` — clean.
- [ ] **Step 5: Commit** `feat(semantic): a graph reader view over the vault client`

### Task 6: Two sessions, one graph

**Files:**
- Modify: `test/integration/vault-client.test.ts` (new `it` in the socket describe; one in-process case)

**Interfaces:**
- Consumes: `createGraphReaderView` (Task 5), the `graph` service (Task 4), the file's `session()` / `makeVault()` helpers (the second session's attach may use `profiles: []`).

- [ ] **Step 1: Write the test** `two sessions read one entry graph`: `makeVault()` plus `alpha.md` linking `[[beta]]`; session A's view reads `backlinkCounts(['beta.md'])` → `[1]`; append `[[beta]]` to `gamma.md` on disk; session B (a new connection, attached after the write) reads `[1]` too — the build A triggered, within the TTL; both views' `resolve(['beta'])` → `['beta.md']` and `noteLinks('alpha.md')` are equal; `entries.info()` lists one vault with `clients: 2`.
- [ ] **Step 2: Write** `the in-process client reads the same graph`: a client over `createInProcessLink(createVaultEntryServices(entries))` (via `createLinkedVaultClient` + `createAttachment`) answers the same three reads as the socket client.
- [ ] **Step 3: Run** `npx vitest run test/integration/vault-client.test.ts` — PASS (POSIX; skipped elsewhere as the file already is).
- [ ] **Step 4: Commit** `test(integration): two sessions read one vault entry graph`

### Task 7: PR 1 docs, gates, PR

**Files:**
- Modify: `docs/architecture/wikilink-graph.md`, `docs/architecture/vault-entry.md`, `docs/architecture/shared-daemon.md`, `docs/architecture/lexical-search.md`, `docs/architecture/module-structure.md`
- Modify: `openspec/changes/graph-in-daemon/tasks.md` (tick 1.1–7.1)

- [ ] **Step 1: Docs.** `wikilink-graph.md`: Wiring — the entry's graph is the vault's one graph, read as `IGraphReader` by the `graph` service; the session's own graph still serves tools until the cut-over (#172), then goes; Surface gains `IGraphReader` and the three wire reads. `vault-entry.md`: the graph member, `IVaultEntry.graph`, `VaultEntries.graph` (entry-level, like `lexical`). `shared-daemon.md`: method table rows, `GRAPH_FAILED`, `graph` in the services list and in "how a new service attaches". `lexical-search.md`: the tie-break reads the entry's one graph. `module-structure.md`: `src/modules/semantic/graph/`. Grep each claim's symbol before writing it.
- [ ] **Step 2: Gates.** `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`, `npx commitlint --from origin/main --to HEAD` — all clean.
- [ ] **Step 3: Commit** `docs(architecture): the vault entry's graph and its graph.* reads`; push; `gh pr create` with `Refs #172`, body lines ≤ 100 chars, no `Closes`. Pause and report.

---

## PR 2 — cut-over (`Closes #172`)

Refined after PR 1's review; the tasks and decisions are fixed (design D5), the steps below are the order.

### Task 8: Every consumer onto `IGraphReader` (one task: the type change with all its call sites)

**Files:** `src/lib/vault-registry.ts`, `src/modules/semantic/vault-client/index.ts`, `src/modules/semantic/index.ts`, `src/modules/semantic/lexical/standalone-reader.ts`, `src/lib/obsidian/{note-links,top-by-backlinks,vault-overview}.ts`, `src/lib/obsidian/query/{query-notes,list-matching-paths}.ts`, `src/modules/operations/tools/{get-note-links,get-vault-overview,query-notes,read-daily}.ts`, `src/modules/operations/resources/vault-overview.ts`, `src/modules/semantic/tools/{search-notes,get-similar-notes}.ts`, `test/_vault-graph.ts`, and their tests.

- [ ] **Step 1:** `makeVaultGraph(overrides: Partial<IGraphReader>)` returns spies answering an empty graph; existing tool tests that override `getBacklinkCount` / `resolve` move to `backlinkCounts` / `resolve` overrides.
- [ ] **Step 2:** Add the one-call-per-tool tests (tasks 8.2) — FAIL.
- [ ] **Step 3:** Retype `IRegisteredVault.graph`; move `graphFactory` into `IModuleVaultFactories`; vault clients supply `createGraphReaderView(clientOf(vaultRoot, enabled))`; `lexicalOnlyVaultFactories` memoizes one `WikilinkGraphIndex` per root for `graphFactory` and the standalone lexical reader; drop `graph` from `lexicalReaderFactory` and `listMatchingPathsFactory`.
- [ ] **Step 4:** Consumers: `getNoteLinks` collects targets, one `resolve`; `topByBacklinks` takes counts; `computeVaultOverview` one `backlinkCounts(paths)`; `collectMatchingPaths` one `backlinkCounts(paths)` per scan before the read loop when given one; `search_notes` one call over `result.candidates` paths when non-empty; `get_note_links` one `noteLinks`. Remove every `ensureFresh` call outside `graph-reader.ts`, the entry and the `--no-semantic` host.
- [ ] **Step 5:** `npm test`, lint, typecheck, format — PASS; tool payload tests unchanged. Commit `refactor(graph): sessions read the vault entry's graph` (not breaking: no tool contract moves).
- [ ] **Step 6:** `npm run eval` on the owner's vault — identical to main (8.3).

### Task 9: Docs sweep

- [ ] **Step 1:** Grep all of `docs/` for `IVaultGraph`, `ensureFresh`, `graphFactory`, "second graph", "private", `#172`; update `wikilink-graph.md`, `vault-registry.md`, `vault-entry.md`, `vault-scope.md` (scope-change difference, brainstorm F5), `module-structure.md`, `lexical-search.md`, the guide's `backlink_count` / freshness lines. Commit `docs: one graph per vault, in the vault entry`.

### Task 10: Close out

- [ ] **Step 1:** `/opsx:verify` → `verify.md`; `retrospective.md`; `/opsx:archive`; gates; PR 2 with `Closes #172` on its own line, body lines ≤ 100 chars.
