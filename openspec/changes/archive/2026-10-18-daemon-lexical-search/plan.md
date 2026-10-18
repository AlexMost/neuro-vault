# daemon-lexical-search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `search_notes`' lexical cache out of every session into the daemon's vault entry, served by `lexical.search`, so N sessions on one vault hold one cache and rank exactly as before.

**Architecture:** The vault entry (`src/lib/vault-entry/`) gains a `LexicalIndex` and a `WikilinkGraphIndex` over its scoped reader, warmed on creation; a `lexical` daemon service answers `lexical.search` over them. In the session, `IRegisteredVault.lexical: ILexicalReader` replaces the tool's private index map, with a daemon reader, an in-process-entry reader and a standalone reader behind one factory, and one per-vault attachment shared by the semantic backend and the lexical reader. One PR.

**Tech Stack:** TypeScript (strict, ESM, `isolatedModules`), Node ≥ 20.9, vitest, `mdast-util-from-markdown`, `@modelcontextprotocol/sdk` stdio framing.

**Spec:** `openspec/changes/daemon-lexical-search/` — `design.md` (D1–D12), `specs/shared-lexical-search/spec.md`, and the deltas for `shared-vault-entry`, `shared-corpus-reads`, `shared-services-daemon`, `hybrid-search`, `semantic-backend-lifecycle`. `brainstorm.md` holds the decisions they come from (settled items 1–11, Q1–Q12, F1 = `--no-semantic` in-process, F2 = one PR).

## Global Constraints

- Gates before every commit: `npm test`, `npm run lint`, `npm run typecheck` (authoritative), `npm run format`; `npm run build` before the PR.
- Commits: Conventional Commits, body lines ≤ 100 characters, one trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Check with `npx commitlint --from origin/main --to HEAD` before pushing.
- A type or signature change lands in the same task as every call site it breaks.
- Tool tests go through `registerTool(buildXTool(deps))` and `callTool` / `expectToolError` from `test/_gate.ts`, never `buildXTool(deps).handler`.
- New interfaces take the `I` prefix (`docs/architecture/naming-conventions.md`); wire types in `protocol.ts` keep that file's `XxxParams` / `XxxResult` naming.
- Diagnostics go to stderr only. No private vault paths or note titles anywhere.
- Timeouts: `lexical.search` 30 s on the session side; `vault.attach` / `vault.status` 10 s and `corpus.*` 30 s unchanged. Graph TTL stays `DEFAULT_TTL_MS` (3 min). Wire params and result keys are snake_case.
- `search_notes` input schema, output shape, ranking and snippets do not change; `npm run eval` scores do not move.
- `--no-semantic` attaches nothing and spawns no daemon (F1). One PR, `Refs #158`, `Closes #176` (F2).

## Review Focus

- A `search_notes` with a `filter` on one session must not make the next unfiltered search on another session re-parse the vault → test in Task 1 (`a filtered search evicts nothing`).
- A call that arrives while a refresh is running must see an edit made just before the call, not the state of the refresh already in flight → test in Task 1 (`a call during a refresh is served by the next one`).
- A daemon killed under a session must cost exactly one failed `search_notes` and one new `vault.attach`, shared by both legs → tests in Task 8 (`NOT_ATTACHED forgets the attach`) and Task 10 (`a restarted server sees one attach before both legs`).
- A vault with `"semantic": false` must attach for its lexical leg without a watcher or a corpus appearing for it anywhere → tests in Task 2 (`profiles [] starts no watcher`) and Task 9 (`an opted-out vault attaches with profiles []`).
- A `--no-semantic` session must never open or spawn a daemon, even with `--shared` defaulted on → test in Task 9 (`--no-semantic opens no connection`).

---

### Task 1: The frozen oracle and the shared refresh rule in `LexicalIndex`

**Files:**
- Create: `test/lib/obsidian/lexical/_legacy-lexical-index.ts` (a verbatim copy of today's `src/lib/obsidian/lexical/lexical-index.ts`, imports pointed at `../../../../src/lib/obsidian/...`, class renamed `LegacyLexicalIndex`), `test/lib/obsidian/lexical/_fixture-vault.ts`
- Modify: `src/lib/obsidian/lexical/lexical-index.ts`
- Test: `test/lib/obsidian/lexical/lexical-index.test.ts`, `test/lib/obsidian/lexical/lexical-index-parity.test.ts`

**Interfaces:**
- Consumes: `VaultReader.scan()`, `parseNote`, `rankNotes` (unchanged).
- Produces, in `lexical-index.ts`:

```ts
export interface ILexicalIndexInfo {
  warmed: boolean;
  notes: number;
  lastRefresh?: { at: Date; parsed: number; ms: number };
}
export class LexicalIndex {
  constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: StatFn; warn?: (m: string) => void });
  search(opts: { queries: string[]; allowed?: ReadonlySet<string>; noteCap: number; perNoteCap: number; getBacklinkCount: (path: string) => number }): Promise<{ notes: RankedNote[]; truncated: boolean; perQueryCounts: Record<string, number>; perQueryTokenCounts: Record<string, Record<string, number>>; totalNotes: number }>;
  /** One refresh through the serialising rule; never rejects (a failure goes to `warn`). */
  warm(): Promise<void>;
  info(): ILexicalIndexInfo;
}
```

  `_fixture-vault.ts` exports `writeFixtureVault(root): Promise<void>` (≈ 12 notes: Ukrainian and English titles, headings, hard-wrapped paragraphs, a code fence, frontmatter, an apostrophe variant, an `Archive/` subtree) and `QUERY_SETS: string[][]` (the #177 sets: phrase, multi-token, accent-folded, apostrophe, multi-query, no-match, title).

- [ ] **Step 1: Freeze the oracle.** Copy today's `lexical-index.ts` to `_legacy-lexical-index.ts`; `git diff --no-index` the two apart from the import lines and the class name must be empty. Write `_fixture-vault.ts`.
- [ ] **Step 2: Write the failing tests** in `lexical-index.test.ts`, with an injected `stat` spy and a spy on `readFile` through a `VaultReader` whose `scan` is real:
  - `a filtered search evicts nothing`: `search({ allowed: 2 of 12 paths })` then `search()` → the second call reads no file (`readFile` spy count unchanged) and both report `totalNotes === 12`.
  - `a call during a refresh is served by the next one`: `stat` blocks on a barrier; start `search()` A; while A is blocked, edit a note and start `search()` B; release → B's result contains the edit, and `stat` ran exactly twice per path (A's refresh, then one follow-up).
  - `concurrent waiters share one follow-up`: as above with B and C both arriving during A → three refreshes total, not four.
  - `warm then info`: `info()` is `{ warmed: false, notes: 0 }` before, `{ warmed: true, notes: 12, lastRefresh: { parsed: 12, … } }` after `warm()`; a second `warm()` reports `parsed: 0`.
  - `warm never rejects`: a `scan` that throws → `warm()` resolves and `warn` was called once.
  - In `lexical-index-parity.test.ts`: for every set in `QUERY_SETS`, with `allowed` ∈ {none, 5 paths}, `new LexicalIndex(...).search(opts)` deep-equals `new LegacyLexicalIndex(...).search(opts)` over the fixture vault (`noteCap: 10`, `perNoteCap: 3`, a fixed `getBacklinkCount` table).
- [ ] **Step 3:** Run `npx vitest run test/lib/obsidian/lexical` — expected: the new tests FAIL (`warm is not a function`, eviction observed).
- [ ] **Step 4: Implement** design D2 in `lexical-index.ts`: `refresh()` with no argument over `reader.scan()`; `allowed` applied to the candidate `Map` after the refresh; `running` / `queued` promises implementing "wait for the one in flight, then share one follow-up"; `warm()`, `info()`; `warn` defaults to `console.error`.
- [ ] **Step 5:** Run `npx vitest run test/lib/obsidian/lexical test/semantic/tools && npm run typecheck` — expected: PASS (the e2e tool fixtures still pass over the new rule).
- [ ] **Step 6: Commit** `refactor(lexical): refresh the whole scope serially and never evict on allowed` (body names the oracle file).

### Task 2: The entry's watcher runs only while it has a corpus

**Files:**
- Modify: `src/lib/vault-entry/vault-entry.ts`
- Test: `test/lib/vault-entry/vault-entry.test.ts`

**Interfaces:**
- Produces: no new exports. `IVaultEntry` behaviour per design D3: `createVaultEntry` no longer starts a watcher in its constructor; `attachCorpus` starts one when none runs, `detachCorpus` closes it when the last corpus leaves, `setScope` / `onVaultRestored` restart only a running watcher.

- [ ] **Step 1: Write the failing tests** with the injected `createWatcher` factory the file already supports: `profiles [] starts no watcher` (an entry with no `addProfile` → factory never called); `the first corpus starts the watcher` (`addProfile` → called once); `the last corpus leaving closes it` (`removeProfile` → the handle's `close` called; `setSemantic(false)` likewise); `setScope on a watcher-less entry starts none`; `setScope restarts a running watcher` (existing test, unchanged).
- [ ] **Step 2:** Run `npx vitest run test/lib/vault-entry/vault-entry.test.ts` — expected: the new tests FAIL.
- [ ] **Step 3: Implement**: `let watcher: WatcherHandle | null = null`; `startWatcher()` / `stopWatcher()` helpers; call sites per the Interfaces block; `dispose()` closes a running watcher.
- [ ] **Step 4:** Run `npx vitest run test/lib/vault-entry test/integration/daemon-vault-entry.test.ts && npm run typecheck` — expected: PASS (`profiles [] attaches without a corpus` still passes).
- [ ] **Step 5: Commit** `fix(vault-entry): watch the vault only while a corpus is attached`.

### Task 3: Lexical members of the vault entry

**Files:**
- Create: `src/lib/obsidian/lexical/reader.ts` (the two types below; Task 6 adds the reader interface to it)
- Modify: `src/lib/vault-entry/vault-entry.ts`, `src/lib/vault-entry/vault-entries.ts`, `src/lib/vault-entry/index.ts`, `src/lib/obsidian/lexical/index.ts`
- Test: `test/lib/vault-entry/vault-entry.test.ts`, `test/lib/vault-entry/vault-entries.test.ts`

**Interfaces:**
- Consumes: `LexicalIndex` (Task 1), `WikilinkGraphIndex` (`src/lib/obsidian/wikilink-graph.ts`).
- Produces:

```ts
// src/lib/obsidian/lexical/reader.ts
export interface ILexicalSearchOptions {
  queries: string[];
  allowed?: ReadonlySet<string>;
  noteCap: number;
  perNoteCap: number;
}
export interface ILexicalResult {
  notes: RankedNote[];
  truncated: boolean;
  perQueryCounts: Record<string, number>;
  perQueryTokenCounts: Record<string, Record<string, number>>;
  totalNotes: number;
}
// vault-entry.ts
export interface ILexicalInfo {
  state: 'warming' | 'ready';
  notes?: number;
  last_refresh?: { at: string; parsed: number; ms: number };
}
// IVaultInfo gains `lexical: ILexicalInfo`
// IVaultEntry gains:
lexicalSearch(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
lexicalInfo(): ILexicalInfo;
// IVaultEntryOptions gains `graphTtlMs?: number` (tests)
// vault-entries.ts
lexical(connectionId: number, vault: string): Pick<IVaultEntry, 'lexicalSearch'>;
```

  `lexicalSearch` = `await graph.ensureFresh()` then `lexical.search({ ...opts, getBacklinkCount: (p) => graph.getBacklinkCount(p) })`. `setScope` rebuilds both members over the new reader and calls `lexical.warm()` in the background; `createVaultEntry` calls `lexical.warm()` once at creation. `VaultEntries.lexical` throws `VaultEntryError('NOT_ATTACHED', 'vault "<v>" is not attached on this connection')` unless `records.get(vault)?.ids.has(connectionId)`. `ILexicalSearchOptions` and `ILexicalResult` live in `reader.ts` from here on (exported through `src/lib/obsidian/lexical/index.ts`); `vault-entry.ts` imports them, and Task 6 adds `ILexicalReader` and `LexicalSearchError` beside them.

- [ ] **Step 1: Write the failing tests.** `vault-entry.test.ts` over a temp vault with the fixture of Task 1: `warms on creation` (`lexicalInfo()` goes `warming` → `ready` with `notes` = scoped count, polled); `lexicalSearch ranks with the entry's graph` (a note with two backlinks outranks a tie); `setScope drops excluded notes on the next search` (a scope excluding `Archive/**` → no `Archive/` path in `notes` and `totalNotes` shrinks); `dispose frees the members` (a search after dispose rejects). `vault-entries.test.ts`: `lexical() is entry-level` (a connection that attached with `profiles: []` gets the reader; one that attached another vault gets `NOT_ATTACHED`); `info() carries lexical` (`state` present on every entry).
- [ ] **Step 2:** Run `npx vitest run test/lib/vault-entry` — expected: FAIL.
- [ ] **Step 3: Implement** per design D1 and D4.
- [ ] **Step 4:** Run `npx vitest run test/lib/vault-entry test/daemon test/integration && npm run typecheck` — expected: PASS.
- [ ] **Step 5: Commit** `feat(vault-entry): hold the lexical cache and its tie-break graph in the entry`.

### Task 4: The `lexical` service and `LEXICAL_FAILED`

**Files:**
- Create: `src/daemon/services/lexical.ts`
- Modify: `src/daemon/protocol.ts`, `src/cli-daemon.ts`
- Test: `test/daemon/lexical-service.test.ts`, `test/daemon/protocol.test.ts`, `test/integration/daemon-vault-entry.test.ts`

**Interfaces:**
- Consumes: `VaultEntries.lexical(connectionId, vault)` (Task 3), `asRecord`, `onlyKeys`, `stringParam`, `wired`.
- Produces, in `protocol.ts`:

```ts
export interface LexicalSearchParams {
  vault: string;
  queries: string[];
  allowed?: string[];
  note_cap: number;
  per_note_cap: number;
}
export interface LexicalSearchResult {
  notes: Array<{ path: string; matches: LexicalMatch[]; matched_queries: string[] }>;
  truncated: boolean;
  per_query_counts: Record<string, number>;
  per_query_token_counts: Record<string, Record<string, number>>;
  total_notes: number;
}
// DaemonErrorCode += 'LEXICAL_FAILED' → ErrorCode.InternalError
```

  and `createLexicalService(entries: Pick<VaultEntries, 'lexical'>): ServiceHandlers` with `search`. Check order: `onlyKeys(['vault','queries','allowed','note_cap','per_note_cap'])`, `queries` a non-empty array of strings, caps positive integers, `allowed` optional string array (`INVALID_PARAMS`); `wired(() => entries.lexical(ctx.id, vault))` (`NOT_ATTACHED`); the search, a throw → `DaemonRpcError('LEXICAL_FAILED', message)`. Registered in `startServing` as `registry.register('lexical', createLexicalService(entries))`.

- [ ] **Step 1: Write the failing tests.** `lexical-service.test.ts` with a fake entries port: one test per `INVALID_PARAMS` case (`profile` key, empty `queries`, `note_cap: 0`, `allowed: "x"`), `NOT_ATTACHED` before any search, `LEXICAL_FAILED` carries the thrown message, the result maps `matchedQueries` → `matched_queries` and snake_case counts. `protocol.test.ts`: `LEXICAL_FAILED` maps to `-32603`; the two existing unknown-method tests that send `lexical.search` to a daemon without the service (`test/daemon/protocol.test.ts`, `test/daemon/socket-server.test.ts`) now send `graph.links`. Integration (`daemon-vault-entry.test.ts`): `lexical.search after profiles [] returns the full ranking` (attach, then search at once: `total_notes` equals the fixture's scoped count and `notes` equals the oracle's over the same temp vault); `lexical.search makes a client` (`daemon.info.clients` is 1 after a connection whose only call was `lexical.search`).
- [ ] **Step 2:** Run `npx vitest run test/daemon test/integration/daemon-vault-entry.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement** per design D5.
- [ ] **Step 4:** Run the same plus `npm run typecheck` — expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): lexical.search over the vault entry's cache`.

### Task 5: `daemon.info` and the `daemon status` lexical line

**Files:**
- Modify: `src/daemon/admin.ts`
- Test: `test/daemon/admin.test.ts` (or the file that holds the `vaultLine` / `profileLine` snapshots today — find it with `grep -rln "last reconcile" test/daemon`)

**Interfaces:**
- Consumes: `IVaultInfo.lexical` (Task 3; `daemon.info` already serialises `entries.info()`).
- Produces: `lexicalLine(info: Partial<ILexicalInfo>): string` printing `    lexical  warming` or `    lexical  ready  <n> notes  last refresh <at> ~<parsed> parsed <ms> ms`, printed between the vault line and the profile lines; skipped when the answer has no `lexical` object.

- [ ] **Step 1: Write the failing tests**: `prints the lexical line between the vault and its profiles` (both forms), `a daemon without lexical prints no such line`.
- [ ] **Step 2:** Run `npx vitest run test/daemon` — expected: FAIL.
- [ ] **Step 3: Implement** per design D9.
- [ ] **Step 4:** Run `npx vitest run test/daemon && npm run typecheck` — expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): report the lexical cache in daemon status`.

### Task 6: `ILexicalReader`, the standalone reader, and the pipeline over it

**Files:**
- Create: `src/modules/semantic/lexical/standalone-reader.ts`, `src/modules/semantic/lexical/index.ts`
- Modify: `src/lib/obsidian/lexical/reader.ts` (Task 3), `src/modules/semantic/retrieval-pipeline.ts`, `src/modules/semantic/tools/search-notes.ts`, `src/lib/vault-registry.ts`, `src/server.ts` (`buildDefaultVaultEntryDeps`: `lexicalReaderFactory` = standalone for now), `eval/pipelines.ts`, `test/operations/tools/_test-registry.ts`, `test/semantic/tools/_hybrid-helpers.ts`
- Test: `test/semantic/lexical/standalone-reader.test.ts`, `test/semantic/retrieval-pipeline.test.ts`, `test/semantic/tools/search-notes*.test.ts`, `test/eval/*.test.ts`

**Interfaces:**
- Produces, in `reader.ts` (design D6), beside Task 3's `ILexicalSearchOptions` and `ILexicalResult`:

```ts
export interface ILexicalReader {
  search(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
  /** Starts whatever makes the first search fast; never rejects. */
  warm(): Promise<void>;
}
export class LexicalSearchError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}
```

  `createStandaloneLexicalReader({ vaultRoot, reader, graph }: { vaultRoot: string; reader: VaultReader; graph: Pick<WikilinkGraphIndex, 'ensureFresh' | 'getBacklinkCount'> }): ILexicalReader` — `search` = `graph.ensureFresh()` then `LexicalIndex.search` with the graph's count; a throw is rethrown as `LexicalSearchError`; `warm()` resolves without doing anything. `RetrievalPipelineDeps` = `{ corpus?: ICorpusReader; lexical: ILexicalReader; filterExisting; embeddingProvider; similarity }`. `IRegisteredVault.lexical: ILexicalReader`; `IRegisteredVaultDeps.lexicalReaderFactory: (opts: { vaultRoot: string; vaultName: string; reader: VaultReader; graph: WikilinkGraphIndex; enabled: boolean }) => ILexicalReader`. `runSearchForEntry` wraps the pipeline call: a `LexicalSearchError` becomes `ToolHandlerError('DEPENDENCY_ERROR', 'Lexical search failed', { details: { vault: entry.name, operation: 'search_notes' }, cause })`. `eval/pipelines.ts`: `FusedContext = { lexical: ILexicalReader }`, built with the standalone reader over the eval's reader and graph. `makeTestRegistry` defaults `lexical` to a standalone reader over the entry's `reader` and an empty graph; `makeLexicalVault` passes a real one.

- [ ] **Step 1: Write the failing tests**: `standalone-reader.test.ts` (`search equals LexicalIndex over the same files`, `warm resolves and parses nothing`, `a throwing index becomes LexicalSearchError`); in `search-notes.test.ts` through the gate: `a lexical failure is DEPENDENCY_ERROR` (a registry entry whose `lexical.search` rejects with `LexicalSearchError('boom')` → `expectToolError(..., 'DEPENDENCY_ERROR')` with `details.vault`); `retrieval-pipeline.test.ts` adapts to the new deps (no `getBacklinkCount`).
- [ ] **Step 2:** Run `npx vitest run test/semantic` — expected: FAIL (type and behaviour).
- [ ] **Step 3: Implement**, moving every call site in this one task (typecheck gate).
- [ ] **Step 4:** Run `npm test && npm run typecheck` — expected: PASS; `npm run eval` on a fixture vault prints the same scores as before this task (record them in the commit body).
- [ ] **Step 5: Commit** `refactor(search): read the lexical leg through a per-vault reader`.

### Task 7: One attachment per vault, shared by both facades

**Files:**
- Create: `src/modules/semantic/backend/attachment.ts`
- Modify: `src/modules/semantic/backend/daemon-backend.ts`, `src/modules/semantic/backend/local-backend.ts`, `src/modules/semantic/backend/index.ts`
- Test: `test/semantic/backend/attachment.test.ts`, `test/semantic/backend/daemon-backend.test.ts`, `test/semantic/backend/local-backend.test.ts`

**Interfaces:**
- Produces (design D7):

```ts
export interface IVaultAttachment {
  /** The realpath key on the current epoch; attaches first when needed. Rejects as the attach does. */
  key(): Promise<string>;
  /** Forget the attach so the next key() attaches again (after NOT_ATTACHED). */
  forget(): void;
  /** `true` while an attach is in flight on the current epoch. */
  readonly attaching: boolean;
  /** The last answered attach's status for `profile`, or undefined. */
  statusOf(profile: string): BackendStatus | undefined;
}
export function createDaemonAttachment(opts: { services: ISharedServices; vaultRoot: string; profiles: string[] }): IVaultAttachment;
export function createLocalAttachment(opts: { entries: VaultEntries; connectionId: number; vaultRoot: string; profiles: string[] }): IVaultAttachment;
```

  `IDaemonSemanticBackendOptions` and `ILocalSemanticBackendOptions` gain `attachment: IVaultAttachment` and lose their own attach; the backends' `status()` rules are unchanged in observable behaviour (the existing tests pass against the new wiring: `ATTACHING` while `attachment.attaching`, `VAULT_UNAVAILABLE` → `unavailable`, `NOT_ATTACHED` → `forget()`). `createSemanticBackends` builds one attachment per vault root (kept until Task 9 renames it).

- [ ] **Step 1: Write the failing tests** in `attachment.test.ts` with a fake `IDaemonLink`: `attaches once per epoch and shares concurrent callers`, `re-attaches after a new epoch`, `forget makes the next key attach again`, `profiles [] is sent for an opted-out vault`, `an answer from a replaced epoch records nothing`; local: `attaches once under the fixed connection id`. In `daemon-backend.test.ts`: `two facades on one attachment send one vault.attach` (the backend and a stub caller both call `attachment.key()`; the link saw one attach).
- [ ] **Step 2:** Run `npx vitest run test/semantic/backend` — expected: the new tests FAIL.
- [ ] **Step 3: Implement**, carrying the attach logic over from `daemon-backend.ts` (`attach()`, `attachedKey()`, the epoch check) without changing it.
- [ ] **Step 4:** Run `npx vitest run test/semantic test/server-modules.test.ts && npm run typecheck` — expected: PASS, all existing backend scenarios unchanged.
- [ ] **Step 5: Commit** `refactor(semantic): one attachment per vault, shared by the daemon facades`.

### Task 8: The daemon and in-process lexical readers

**Files:**
- Create: `src/modules/semantic/lexical/daemon-reader.ts`, `src/modules/semantic/lexical/local-reader.ts`
- Modify: `src/modules/semantic/lexical/index.ts`, `src/modules/semantic/daemon-connection.ts` only if `IDaemonLink.request` needs nothing new (expected: no change)
- Test: `test/semantic/lexical/daemon-reader.test.ts`, `test/semantic/lexical/local-reader.test.ts`

**Interfaces:**
- Consumes: `IVaultAttachment` (Task 7), `ISharedServices`, `VaultEntries.lexical` (Task 3), `LexicalSearchParams` / `LexicalSearchResult` (Task 4).
- Produces:

```ts
export const LEXICAL_TIMEOUT_MS = 30_000;
export function createDaemonLexicalReader(opts: { services: ISharedServices; attachment: IVaultAttachment; local: () => ILexicalReader }): ILexicalReader;
export function createLocalLexicalReader(opts: { entries: VaultEntries; connectionId: number; attachment: IVaultAttachment }): ILexicalReader;
```

  Daemon reader `search`: `services.ensure()`; `'local'` → `local().search(opts)` (built once); else `attachment.key()` then `request('lexical.search', { vault, queries, allowed?: [...allowed], note_cap, per_note_cap }, LEXICAL_TIMEOUT_MS)`, mapping `matched_queries` → `matchedQueries` and the snake_case counts to `ILexicalResult`; an answer without `notes` array → `LexicalSearchError`. Errors: `DaemonRpcError` `LEXICAL_FAILED` / `VAULT_UNAVAILABLE`, `DaemonTimeoutError`, `DaemonConnectionError` → `LexicalSearchError(message, { cause })`; `NOT_ATTACHED` → `attachment.forget()` then `LexicalSearchError`. `warm()` = `attachment.key()` with every rejection swallowed, and nothing when `services.mode` is `local`. Local reader: `attachment.key()` then `entries.lexical(connectionId, key).lexicalSearch(opts)`; `VaultEntryError` → `LexicalSearchError`; `warm()` = `attachment.key()` swallowed.

- [ ] **Step 1: Write the failing tests.** Daemon reader with a fake link: `sends snake_case params and maps the result`, `allowed is sent only when given`, `LEXICAL_FAILED is a LexicalSearchError with the daemon's message`, `a timeout fails the call and leaves services.mode daemon`, `NOT_ATTACHED forgets the attach` (the next search attaches again: two `vault.attach` requests seen), `delegates to local once the switch is local`, `warm attaches and never rejects`. Local reader over an in-process `VaultEntries` on the fixture vault: `search equals the entry's lexicalSearch`, `a vault that cannot be attached is a LexicalSearchError`.
- [ ] **Step 2:** Run `npx vitest run test/semantic/lexical` — expected: FAIL.
- [ ] **Step 3: Implement** per design D6.
- [ ] **Step 4:** Run `npx vitest run test/semantic && npm run typecheck` — expected: PASS.
- [ ] **Step 5: Commit** `feat(semantic): lexical readers over the daemon and the in-process entry`.

### Task 9: `createVaultClients` and the startup attach of every vault

**Files:**
- Modify: `src/modules/semantic/backend/index.ts` (rename `createSemanticBackends` → `createVaultClients`), `src/server.ts`, `src/lib/vault-registry.ts` (doc comment only), `test/semantic/backend/factory.test.ts`, `test/server-modules.test.ts`, `test/integration/session-daemon.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces:

```ts
export interface IVaultClients {
  semanticBackendFactory: IRegisteredVaultDeps['semanticBackendFactory'];
  lexicalReaderFactory: IRegisteredVaultDeps['lexicalReaderFactory'];
  dispose(): Promise<void>;
}
export function createVaultClients(opts: ISemanticBackendsOptions): IVaultClients;
```

  One attachment per `vaultRoot` (daemon when `shared`, local otherwise), built on the first factory call for that root with `profiles: enabled ? [profile] : []`; the semantic factory returns the disabled backend for `enabled: false` as today, the lexical factory the daemon or local reader for every vault. `server.ts`: when `config.semantic.enabled`, build the clients and hand both factories to the registry; otherwise hand it `semanticEnabled: false` and a standalone `lexicalReaderFactory`, and build no clients (no `services.ensure()` is ever reached). After `server.connect`: `attaches` = every vault's `backend?.status()` as today plus `void entry.lexical.warm()` for every vault; `dispose` unchanged apart from the rename.

- [ ] **Step 1: Write the failing tests** in `server-modules.test.ts`: `--no-semantic opens no connection` (a `sharedServices` double whose `ensure` records calls: zero calls across startup and a `search_notes`); `an opted-out vault attaches with profiles []` (fake link sees `vault.attach { profiles: [] }` for the `"semantic": false` vault and `[profile]` for the other); `--no-shared serves the lexical leg from the in-process entry` (no connection, the local entries' `lexical()` was used: spy through `createEntries`); `startup warms every vault's reader` (two vaults → two `warm()` calls). `factory.test.ts`: both factories share one attachment per root (one `vault.attach` for a backend + reader pair).
- [ ] **Step 2:** Run `npx vitest run test/server-modules.test.ts test/semantic/backend` — expected: FAIL.
- [ ] **Step 3: Implement** per design D8.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run lint` — expected: PASS.
- [ ] **Step 5: Commit** `feat(server): attach every vault at startup and serve the lexical leg through the daemon`.

### Task 10: Parity and end-to-end

**Files:**
- Create: `test/semantic/lexical/parity.test.ts`
- Modify: `test/integration/session-daemon.test.ts`

**Interfaces:**
- Consumes: `LegacyLexicalIndex` and the fixture (Task 1), all three readers, `startDaemonServer` with `vault` + `lexical` services.

- [ ] **Step 1: Write the tests.** `parity.test.ts`: over one temp fixture vault, for every `QUERY_SETS` entry × `allowed` ∈ {none, 5 paths}: standalone, local (in-process `VaultEntries`) and daemon (in-test socket server) readers each deep-equal the oracle's result; `search_notes` through `test/_gate.ts` with `mode: "lexical"` and `hybrid` (backend disabled) gives one payload for the three registry entries. `session-daemon.test.ts`: `a restarted server sees one attach before both legs` (kill and restart the socket server, run a hybrid `search_notes`: the new server's log shows one `vault.attach`, then a `corpus.*` and a `lexical.search` with its key); `a daemon-served session reads no note for a lexical call` (a spy on the session's `VaultReader.readNotes` / `readFile` is not called by `search_notes` in lexical mode).
- [ ] **Step 2:** Run `npx vitest run test/semantic/lexical/parity.test.ts test/integration` — expected: PASS (these tests pin behaviour already built; a failure here is a defect in Tasks 1–9, fixed there).
- [ ] **Step 3:** Run `npm test && npm run lint && npm run typecheck && npm run format` — expected: PASS.
- [ ] **Step 4: Commit** `test(lexical): pin parity across the three readers and the daemon round trip`.

### Task 11: Docs sweep

**Files:**
- Modify: `docs/architecture/lexical-search.md`, `vault-entry.md`, `shared-daemon.md`, `semantic-backend.md`, `vault-registry.md`, `module-structure.md`, `mcp-server-shape.md`, `retrieval-policy.md`, `docs/architecture/README.md`, `docs/guide/installation.md`, `docs/guide/configuration.md`, `docs/guide/finding-notes.md`, `README.md`

- [ ] **Step 1:** Rewrite `lexical-search.md`'s "What it is", "mtime cache", "Freshness model" and "What it deliberately does not do" for design D1, D2, D6 (the cache as an entry member; the serialised refresh and never-evict; the entry's graph; `ILexicalReader` and its three implementations; `DEPENDENCY_ERROR`). Update `vault-entry.md` (members, warm, D3's watcher rule, the "does not do" list), `shared-daemon.md` (the `lexical` service section, the protocol table row, `LEXICAL_FAILED` in the error table, the status example, "How a new service attaches" in past tense), `semantic-backend.md` (the attachment; an opted-out vault attaches with `profiles: []`), `vault-registry.md` (`lexical`), `module-structure.md`, `mcp-server-shape.md`, `retrieval-policy.md`, the `README.md` map line.
- [ ] **Step 2:** Guides: `installation.md` and `README.md` (the daemon starts for a shared session with any registered vault, `"semantic": false` included; not under `--no-semantic` or `--no-shared`), `configuration.md` (`"semantic": false` paragraph; the `--shared` row), `finding-notes.md` (a lexical failure is `DEPENDENCY_ERROR`).
- [ ] **Step 3:** Run `grep -rn "LexicalIndex\|getBacklinkCount\|lexical cache\|own lexical\|every vault set to\|lexical\.\*" docs README.md` and fix every hit the change made untrue.
- [ ] **Step 4:** Run `npm run format` — expected: PASS.
- [ ] **Step 5: Commit** `docs: the lexical cache lives in the daemon's vault entry`.

### Task 12: Verify, retrospective, archive, PR, measurement

- [ ] **Step 1:** `/opsx:verify` → `verify.md`: gates; `npm run eval` scores before (the merge-base) and after, identical on both pipelines; by hand on the owner's vault with `npm run build` and `node dist/cli.js`: three sessions → `daemon status` shows one entry with `clients 3` and one `lexical ready` line; a vault with `"semantic": false` attaches with `profiles: []`; `--no-semantic` spawns no daemon (`daemon status` lists none after a search); `--no-shared` serves in-process; `kill` the daemon → the next `search_notes` fails with `DEPENDENCY_ERROR`, the one after succeeds.
- [ ] **Step 2:** `retrospective.md` (carry forward the unchecked §6 candidates of `openspec/changes/archive/2026-10-18-daemon-vault-registry/retrospective.md`).
- [ ] **Step 3:** `npx openspec archive -y`; `npx openspec validate --all --strict`; all gates and `npm run build`; `npx commitlint --from origin/main --to HEAD`; push; PR to `main` with `Refs #158`, `Closes #176`.
- [ ] **Step 4 (after the merge, by hand, design D11):** footprint for N = 1, 3, 5 at +15/+60/+120/+300 s, sessions and daemon reported per run, one daemon run sampled to +900 s, the `--no-semantic` floor once on the same build; posted on #158 next to the change 1 numbers with the effort's end-of-effort percentage against the settled baseline table. No script in the repo.
