# Vault client (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `IVaultClient` per vault root and side — a socket adapter and an in-process adapter that runs the daemon's own handlers — with the semantic backend rewired as a view over it (PR 1 of `vault-client`, `Refs #193`).

**Architecture:** A link (`{ epoch, request }`) is what a client sends through: the daemon connection, or an in-process loopback over `createVaultEntryServices(entries)`. One attachment implementation (single flight per epoch, over an epoch gate) serves both. The client core adds the vault key, the `NOT_ATTACHED` forget, the status placeholders and per-method timeouts; the socket adapter adds the one switch. Views map the client's one error vocabulary to their domain errors.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, Node ≥ 20.9.

**Spec:** `openspec/changes/vault-client/design.md` (D1–D11), `specs/vault-client/spec.md`, `brainstorm.md` (Q1–Q13), `tasks.md` (groups 1–6 are this plan; 7–9 are PR 2 and are outlined at the end).

## Global Constraints

- Do not edit: `src/modules/semantic/tools/*`, `src/modules/semantic/retrieval-pipeline.ts`, `src/modules/semantic/tool-helpers.ts`, `eval/`, `src/lib/obsidian/corpus/*`, `src/lib/vault-entry/vault-entry.ts`, `src/lib/vault-entry/reconcile-loop.ts`, `src/cli-index.ts`, `package.json`, `.github/workflows/ci.yml`, `src/cli.ts`, `src/config.ts`, `src/modules/operations/*`, `.scratch/`.
- `ISemanticBackend`, `ILexicalReader`, `ICorpusReader`, `IRegisteredVault`, `ISharedServices`, `EmbeddingProvider` keep their shapes.
- PR 1 leaves untouched: `src/modules/semantic/lexical/daemon-reader.ts`, `lexical/local-reader.ts`, `src/modules/semantic/daemon-embedding-provider.ts`.
- Timeouts: `vault.attach` 10 000 ms, `vault.status` 10 000 ms, every other method 30 000 ms.
- Status placeholder while attaching: `{ state: 'indexing', indexed: 0, total: 0 }`. A timed-out status: `{ state: 'unavailable', reason: 'daemon did not answer' }`.
- Imports use `.js` suffixes; interfaces take the `I` prefix; wire types in `protocol.ts` keep their unprefixed style.
- Gates before any commit: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` (run `npx prettier --write` on touched files). Commits: Conventional Commits, body lines ≤ 100 chars, one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tool tests go through `registerTool(...)` and `test/_gate.ts` (ADR-0015).

## Review Focus

1. **A reconnect between the attach and the read.** The read must never carry a key the current connection did not attach — pinned by the attachment's existing tests (Task 3) and a client test that bumps the epoch between `status()` and `nearest()` (Task 5).
2. **Startup statuses before the switch is decided** (`mode: 'pending'`) must answer at once and never wait for a spawn — Task 5 test "status answers indexing 0/0 at once while ensure is pending".
3. **Shutdown under a connect in flight**: a status started while pending, whose `ensure()` then rejects with `SharedServicesClosedError`, must send no `vault.attach` and later read `unavailable` — Task 5.
4. **`--no-shared` sessions run through the loopback's validation**: vector anchors must reach it as `number[]` of the profile's width and no key may be `undefined` — Task 6 view test plus the ported factory and integration tests.
5. **Disposal order**: the loopback is closed before the entries are disposed, and a factory call after `dispose()` builds nothing — Task 7 factory tests.

---

### Task 1: The method table and the shared service map

**Files:**
- Modify: `src/daemon/protocol.ts` (after `LexicalSearchResult`)
- Modify: `src/daemon/services/vault.ts` (result annotations)
- Create: `src/daemon/services/vault-entry-services.ts`
- Modify: `src/cli-daemon.ts:242-244`
- Test: `test/daemon/vault-entry-services.test.ts`

**Interfaces:**
- Produces: `VaultAttachParams { vault: string; profiles: string[] }`, `VaultAttachResult { vault: string; profiles: Record<string, BackendStatus> }`, `VaultStatusParams { vault: string; profile: string }`, `interface VaultMethods` (rows `'corpus.nearest'`, `'corpus.nearestBlocks'`, `'lexical.search'`, each `{ params; result }` from the existing wire types), `type VaultMethod = keyof VaultMethods`, `type VaultCallParams<M extends VaultMethod> = Omit<VaultMethods[M]['params'], 'vault'>`, `type VaultCallResult<M extends VaultMethod> = VaultMethods[M]['result']`; `type VaultEntriesPorts = VaultEntriesPort & CorpusEntriesPort & LexicalEntriesPort`; `createVaultEntryServices(entries: VaultEntriesPorts): Record<string, ServiceHandlers>` returning exactly `{ vault, corpus, lexical }`.

- [ ] **Step 1: Write the failing test** `test/daemon/vault-entry-services.test.ts`:
  - `it('builds the vault, corpus and lexical services')`: `Object.keys(createVaultEntryServices(fake))` equals `['vault', 'corpus', 'lexical']`.
  - `it('a ServiceRegistry built from the map reaches the entries')`: register each entry, dispatch `vault.attach { vault: '/v', profiles: [] }` with `testCtx(7)` (from `test/daemon/_ctx.ts`); expect the fake `attach` called with `(7, '/v', [])` and a result response.
- [ ] **Step 2: Run** `npx vitest run test/daemon/vault-entry-services.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the protocol types (import `BackendStatus` as a type from `../lib/obsidian/semantic-backend.js`), annotate `vault.attach` / `vault.status` handlers as `Promise<VaultAttachResult>` / `Promise<BackendStatus>`, add `vault-entry-services.ts` with a doc comment ("what the daemon registers, and what the in-process client dispatches to"), and replace the three `registry.register` lines in `cli-daemon.ts` with a loop over `Object.entries(createVaultEntryServices(entries))`.
- [ ] **Step 4: Run** the test and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(daemon): type the per-vault method table and share the service map`.

### Task 2: The epoch gate

**Files:**
- Create: `src/modules/semantic/vault-client/epoch-gate.ts`
- Test: `test/semantic/vault-client/epoch-gate.test.ts`

**Interfaces:**
- Produces: `interface IEpochGate { readonly done: boolean; readonly running: boolean; pass(): Promise<void>; forget(): void }`, `createEpochGate<T>(link: { readonly epoch: number }, run: () => Promise<T>, commit: (value: T) => void): IEpochGate`. `pass()` resolves once a run on the epoch it was called on settled (it does not loop); it rejects as the run did.

- [ ] **Step 1: Write the failing tests** (a `link = { epoch: 1 }` object the test mutates; `run` a `vi.fn` returning deferred promises):
  - `'runs once per epoch and shares concurrent callers'`: two `pass()` → `run` called once, `commit` once, `done` true; a third `pass()` → still one run.
  - `'a new epoch runs again'`: after done, `link.epoch = 2` → `done` false; `pass()` → second run.
  - `'a run that settles on a replaced epoch commits nothing'`: start a run, set epoch 2, resolve → `commit` not called, `done` false.
  - `'a rejected run leaves it undone and the next pass runs again'`: `pass()` rejects with the run's error; next `pass()` calls `run` again.
  - `'forget makes the next pass run again'`.
  - `'running is true only while a run is in flight on the current epoch'`: true during, false after; false after the epoch moved mid-run.
- [ ] **Step 2: Run** `npx vitest run test/semantic/vault-client/epoch-gate.test.ts` — FAIL.
- [ ] **Step 3: Implement** with `doneEpoch = -1` and `inFlight?: { epoch; answer }`; `commit` and `doneEpoch = epoch` only when `epoch === link.epoch` at settle; clear `inFlight` in `finally` only if it is still this run.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(vault-client): a single flight per connection epoch`.

### Task 3: The link, the loopback and the attachment over a link

**Files:**
- Create: `src/modules/semantic/vault-client/link.ts`
- Create: `src/modules/semantic/vault-client/attachment.ts`
- Modify: `src/modules/semantic/backend/attachment.ts` (becomes the PR-1 shim)
- Test: `test/semantic/vault-client/link.test.ts`
- Test (unchanged, must pass): `test/semantic/backend/attachment.test.ts`

**Interfaces:**
- Consumes: `createEpochGate` (Task 2); `DaemonRpcError`, `ServiceHandlers`, `IConnectionContext`, `VaultAttachParams`, `VaultAttachResult` (Task 1).
- Produces: `interface IVaultLink { readonly epoch: number; request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> }`; `interface IInProcessLink extends IVaultLink { close(): void }`; `createInProcessLink(services: Record<string, ServiceHandlers>, opts?: { clientId?: number }): IInProcessLink`; `interface IVaultAttachment` (moved verbatim: `key()`, `forget()`, `attaching`, `attached`, `statusOf(profile)`); `createAttachment(opts: { link: IVaultLink; vaultRoot: string; profiles: string[] }): IVaultAttachment`; `ATTACH_TIMEOUT_MS = 10_000` exported from `attachment.ts`.

- [ ] **Step 1: Write the failing link tests**:
  - `'calls the handler with a context carrying the link id'`: two links without `clientId` see different `ctx.id`; a link with `{ clientId: 0 }` sees 0.
  - `'unknown methods and prototype names answer UNKNOWN_METHOD'`: `'nope.x'`, `'vault.toString'`, `'vault'` reject with `DaemonRpcError` code `UNKNOWN_METHOD`.
  - `'a DaemonRpcError passes through; any other throw is INTERNAL with its message'`.
  - `'close runs each onClose callback once, and later requests reject'`: a handler registers `ctx.onClose(spy)` twice across two calls → after `close()` spy called twice (once per registration), `close()` again calls nothing more; a request after close rejects with `Error` matching `/closed/`. An `onClose` registered after close runs at once.
  - `'epoch is constant'`.
- [ ] **Step 2: Run** `npx vitest run test/semantic/vault-client/link.test.ts` — FAIL.
- [ ] **Step 3: Implement** `link.ts` (module-level `let nextClientId = 1`; lookup as `ServiceRegistry.lookup` does, `Object.hasOwn`). Move the attachment into `vault-client/attachment.ts` as `createAttachment` over a link and a gate (run: `link.request<VaultAttachResult>('vault.attach', { vault: vaultRoot, profiles }, ATTACH_TIMEOUT_MS)`, rejecting an answer whose `vault` is not a string; commit: key and statuses; `key()` loops up to 3 times: `if (!gate.done) await gate.pass(); if (gate.done) return key;`, else throws today's message). `backend/attachment.ts`: re-export `IVaultAttachment`; `createDaemonAttachment(opts: IDaemonAttachmentOptions)` = `createAttachment({ link: opts.services.connection, … })`; keep `createLocalAttachment` and its options as they are, with a `@deprecated` note "PR 2 removes it".
- [ ] **Step 4: Run** the link tests and `npx vitest run test/semantic/backend/attachment.test.ts test/semantic/lexical` — PASS, unchanged.
- [ ] **Step 5: Commit** `feat(vault-client): one attachment over a link, and the in-process loopback`.

### Task 4: `IVaultClient`: the core and the socket adapter

**Files:**
- Create: `src/modules/semantic/vault-client/client.ts`
- Create: `src/modules/semantic/vault-client/daemon-client.ts`
- Create: `src/modules/semantic/vault-client/index.ts`
- Test: `test/semantic/vault-client/client.test.ts` (Task 5 fills it)

**Interfaces:**
- Consumes: `IVaultLink`, `IVaultAttachment` (Task 3); `VaultMethod`, `VaultCallParams`, `VaultCallResult` (Task 1); `ISharedServices`, `SharedServicesClosedError`; `DaemonTimeoutError`; `isStatus` from `backend/corpus-wire.ts`.
- Produces:
  ```ts
  export interface IVaultClient {
    call<M extends VaultMethod>(method: M, params: VaultCallParams<M>): Promise<VaultCallResult<M>>;
    status(profile: string): Promise<BackendStatus>;
    warm(): Promise<void>;
    dispose(): Promise<void>;
  }
  export const ATTACHING: BackendStatus; // indexing 0/0
  export const VAULT_CALL_TIMEOUTS: { readonly default: 30_000; readonly 'vault.attach': 10_000; readonly 'vault.status': 10_000 };
  export function createLinkedVaultClient(opts: { link: IVaultLink; attachment: IVaultAttachment }): IVaultClient;
  export function createDaemonVaultClient(opts: {
    services: ISharedServices; attachment: IVaultAttachment; local: () => IVaultClient;
  }): IVaultClient;
  ```
  `index.ts` re-exports these plus `createAttachment`, `createInProcessLink`, `IVaultLink`, `IInProcessLink`, `IVaultAttachment`.

- [ ] **Step 1: Implement** `client.ts` per design D5 (call: `{ ...params, vault: await attachment.key() }`, timeout `VAULT_CALL_TIMEOUTS[method] ?? default` — the table typed as `Readonly<Partial<Record<string, number>>> & { default: number }` so a new row needs no entry; status rules and the `unreadable(error)` helper moved from `daemon-backend.ts`, with its doc comment adapted) and `daemon-client.ts` per design D6 (the one `side()`, the one `local ??=` memo, `starting` / `closed` background start moved from `daemon-backend.ts`: `starting ??= (async () => { try { await (await side()).warm(); } catch (e) { if (e instanceof SharedServicesClosedError) closed = e; } finally { starting = undefined; } })()`). Doc comments carry what `daemon-backend.ts`'s did for status and the switch.
- [ ] **Step 2: Run** `npm run typecheck` — PASS. (Behaviour is tested in Task 5; this task is a reviewer gate for the shape.)
- [ ] **Step 3: Commit** `feat(vault-client): IVaultClient, its core over a link and the socket adapter`.

### Task 5: Client tests at the interface

**Files:**
- Test: `test/semantic/vault-client/client.test.ts`
- Test: `test/semantic/vault-client/in-process.test.ts`

**Interfaces:**
- Consumes: Task 4's factories; `createInProcessLink`, `createAttachment`, `createVaultEntryServices`, `VaultEntries`, `createVaultEntry`.

- [ ] **Step 1: Write the socket-adapter tests** over a fake `ISharedServices` (the `fakeServices` / `holdEnsure` / `settledSoon` helpers of today's `daemon-backend.test.ts`, moved into the new file) — one `it` per scenario, each re-expressing the like-named test of `daemon-backend.test.ts` through `client.status(PROFILE)` / `client.call('corpus.nearest', …)`:
  `'attaches once per epoch'`, `'concurrent first calls share one attach'`, `'a first status after another reader attached reads the live status'`, `'an attach answered after the epoch moved attaches again and reads the new answer'`, `'re-attaches after a new epoch'`, `'a call never carries a key from a replaced epoch'` (epoch bumped between `status()` and `call()` → a second `vault.attach` precedes the read), `'status reads indexing 0/0 while the attach is in flight'`, `'status answers indexing 0/0 at once while ensure is pending'`, `'a first ensure that goes local warms the in-process client in the background'`, `'once decided, status waits for a reconnect, then attaches'`, `'a status timeout reads unavailable "daemon did not answer"'`, `'an attach timeout reads unavailable and the next call attaches again'`, `'VAULT_UNAVAILABLE reads unavailable and re-attaches next call'`, `'a dropped connection reads unavailable for that call'`, `'NOT_ATTACHED on a call forgets the attach'`, `'NOT_ATTACHED on vault.status forgets the attach'`, `'calls carry the vault key and the per-method timeout'` (`request` called with `('corpus.nearest', { vault: REAL, … }, 30_000)`, `('vault.attach', …, 10_000)`, `('vault.status', …, 10_000)`), `'every call goes to the local client once the switch is local; it is built once'`, `'dispose disposes only a local client that was built'`, `'sends no vault.attach once the services closed under a connect; a later status reads unavailable'`, `'warm attaches and never rejects'`.
- [ ] **Step 2: Write the in-process tests** over real `VaultEntries` (temp vault, the injected document embedder of `local-backend.test.ts`, `idleTimeoutMs: 0`, `createEntry` with `debounceMs` 100) through `createLinkedVaultClient({ link: createInProcessLink(createVaultEntryServices(entries)), attachment })`: `'status reads indexing 0/0 while the first attach is in flight, then the entry status'`, `'reads answer once the profile is ready'` (`call('corpus.nearest', { profile, anchors: [{ path: 'alpha.md' }], threshold: 0.5 })` → hits for alpha/beta/gamma), `'a read while indexing is refused CORPUS_NOT_READY with the status in data'`, `'a vault that cannot be attached reads unavailable and refuses calls with VAULT_UNAVAILABLE'`, `'closing the link detaches it from the entry'` (`entries.info()[0].clients` 1 → 0), `'the same read answers the same over the socket adapter and in-process'` (both against one temp vault: a real socket server from Task 7's integration fixture is not needed here — compare the in-process answer with the corpus service dispatched through a `ServiceRegistry` with another `testCtx`).
- [ ] **Step 3: Run** `npx vitest run test/semantic/vault-client` — Expected: PASS (fix Task 4 code where a scenario fails; the old tests' expectations are the reference).
- [ ] **Step 4: Commit** `test(vault-client): pin the client's behaviour at its interface`.

### Task 6: The semantic backend as a view

**Files:**
- Create: `src/modules/semantic/backend/view.ts`
- Test: `test/semantic/backend/view.test.ts`

**Interfaces:**
- Consumes: `IVaultClient` (Task 4); `CorpusNotReadyError`, `ISemanticBackend`; `CorpusAnchorParam`; `isStatus`.
- Produces: `createSemanticBackendView(client: IVaultClient, profile: string): ISemanticBackend`.

- [ ] **Step 1: Write the failing tests** over a fake client (`call`, `status`, `warm`, `dispose` as `vi.fn`):
  - `'reads send number[] anchors, the profile, and no undefined keys'`: `nearest([{ vector: new Float32Array([1, 0]) }, { path: 'a.md' }], { threshold: 0.5, allowed: new Set(['a.md']) })` → `call` with `('corpus.nearest', { profile: PROFILE, anchors: [{ vector: [1, 0] }, { path: 'a.md' }], threshold: 0.5, allowed: ['a.md'] })` and no `limit` / `exclude` key; `nearestBlocks` likewise with `paths` as an array.
  - `'an answer without one list per anchor is an error'`.
  - `'CORPUS_NOT_READY maps to CorpusNotReadyError with the daemon status'` (`data.status` `{ state: 'indexing', indexed: 1, total: 4 }`; and `unavailable` with the message when `data.status` is missing).
  - `'VAULT_UNAVAILABLE maps to CorpusNotReadyError unavailable with the reason'`.
  - `'CORPUS_FAILED and transport errors reach the caller as themselves'`.
  - `'status and dispose delegate'`: `status()` → `client.status(PROFILE)`.
- [ ] **Step 2: Run** `npx vitest run test/semantic/backend/view.test.ts` — FAIL.
- [ ] **Step 3: Implement** `view.ts` (move `anchorParam` from `daemon-backend.ts`; one `hitsOf(method, pending, count)` that awaits, checks and maps).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(backend): the semantic backend as a view over the vault client`.

### Task 7: One client per root; old semantic facades removed

**Files:**
- Modify: `src/modules/semantic/backend/index.ts` (`createVaultClients`)
- Delete: `src/modules/semantic/backend/daemon-backend.ts`, `src/modules/semantic/backend/local-backend.ts`, `test/semantic/backend/daemon-backend.test.ts`, `test/semantic/backend/local-backend.test.ts`
- Modify: `test/semantic/backend/factory.test.ts`, `test/integration/session-daemon.test.ts`, `test/semantic/tools/search-notes.test.ts:266-277` (construction only)
- Test: `test/integration/vault-client.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `createVaultClients` with the same options and `IVaultClients` shape as today; `LOCAL_CONNECTION_ID` still exported (PR 1).

- [ ] **Step 1: Rewrite `createVaultClients`** per design D8: per root `Map<string, { attachment: IVaultAttachment; client: IVaultClient }>` for each side; `inProcessLink()` builds once `createInProcessLink(createVaultEntryServices(localEntries()), { clientId: LOCAL_CONNECTION_ID })` (and throws the existing "vault clients disposed" error after dispose); the semantic factory returns `createSemanticBackendView(side.client, opts.profile)` or `createDisabledSemanticBackend()`; the lexical factory builds the legacy readers with `side.attachment` and `entries: localEntries(), connectionId: LOCAL_CONNECTION_ID`; `dispose()` sets `disposed`, closes the loopback, then `await entries?.dispose()`. Update the module doc comment (the attachment is shared with the legacy lexical readers until PR 2).
- [ ] **Step 2: Delete** the two facades and their tests; drop their exports from `backend/index.ts`.
- [ ] **Step 3: Port the tests**: `factory.test.ts` — fake entries gain `detach: vi.fn()`; expectations on `entries.attach` stay `(LOCAL_CONNECTION_ID, root, profiles)`; add `'dispose closes the in-process link before disposing the entries'` (`detach` called with `LOCAL_CONNECTION_ID` before `dispose`). `session-daemon.test.ts` — `session()` builds `createDaemonVaultClient({ services, attachment: createAttachment({ link: services.connection, vaultRoot, profiles: [PROFILE] }), local: () => { throw … } })` and the view; the lexical reader in that file shares `attachment`. `search-notes.test.ts` — the backend becomes the view over `createDaemonVaultClient` with the same fake services.
- [ ] **Step 4: Write** `test/integration/vault-client.test.ts` (posix only, the `daemonServices` fixture, a real `startDaemonServer` whose registry is built from `createVaultEntryServices(entries)` plus the `daemon` service): `'two sessions share one entry through their clients'` and `'a killed server is reconnected and re-attached once on the next call'` (one `vault.attach` per epoch in `sent`).
- [ ] **Step 5: Run** `npm test` — PASS; `npm run typecheck`; `npm run lint`.
- [ ] **Step 6: Commit** `refactor(backend): one vault client per vault root; the facades become a view`.

### Task 8: The cost claim

**Files:**
- Test: `test/semantic/vault-client/new-read.test.ts`

**Interfaces:**
- Consumes: `createDaemonVaultClient`, `createLinkedVaultClient`, `createInProcessLink`, `createAttachment`, `createVaultEntryServices`, `startDaemonServer`, `daemonServices` fixture.

- [ ] **Step 1: Write the test**:
  ```ts
  declare module '../../../src/daemon/protocol.js' {
    interface VaultMethods {
      'probe.echo': { params: { vault: string; text: string }; result: { vault: string; text: string } };
    }
  }
  ```
  a `probe` service `{ echo: async (params) => ({ vault, text }) }`, a view `const echo = (client: IVaultClient, text: string) => client.call('probe.echo', { text });`, and `it('a new read reaches the entry through both adapters with no adapter change')`: over the socket (registry = `createVaultEntryServices(entries)` + `probe`) and in-process (loopback over the same map + `probe`), each `echo(client, 'hi')` resolves `{ vault: <realpath of the temp vault>, text: 'hi' }`, after one `vault.attach`.
- [ ] **Step 2: Run** `npx vitest run test/semantic/vault-client/new-read.test.ts` and `npm run typecheck` — PASS (if the typecheck fails, an exhaustive per-method record exists somewhere: make it partial, do not loosen the test).
- [ ] **Step 3: Commit** `test(vault-client): a new per-vault read costs a row, a handler and a view`.

### Task 9: PR 1 docs, ADR, gates, PR

**Files:**
- Create: `docs/adr/0021-vault-client.md`; Modify: `docs/adr/INDEX.md`, `GLOSSARY.md`
- Modify: `docs/architecture/shared-daemon.md`, `semantic-backend.md`, `vault-entry.md`, `module-structure.md`, `vault-registry.md`
- Modify: `openspec/changes/vault-client/tasks.md` (tick groups 1–6)

- [ ] **Step 1: Write ADR-0021** (Context: the three copies and their cost; Decision: one client per root and side, the method table, the loopback over the daemon's handlers, one link per side per process, views; Consequences: one error vocabulary, the cost of a new read, the embedding provider kept apart and why; Alternatives: per-method in-process table, validation/operation split, one link per root, the provider on the client). Row in `INDEX.md`. `GLOSSARY.md`: **vault client** — "the session's one path to a vault entry, per vault root and side: `call(method)` over the daemon connection or the in-process loopback; the semantic backend and the lexical reader are views over it".
- [ ] **Step 2: Update the architecture docs** for what PR 1 changed: grep `docs/` for `createDaemonSemanticBackend`, `createLocalSemanticBackend`, `daemon-backend`, `local-backend`, `createLocalAttachment`, `LOCAL_CONNECTION_ID`, "facade" and fix each hit that PR 1 made false; `shared-daemon.md` gains "how a new per-vault read is added" (row, handler in `createVaultEntryServices`, view).
- [ ] **Step 3: Run the gates** `npm test && npm run lint && npm run typecheck && npm run format && npm run build`, then `npx commitlint --from origin/main --to HEAD` — all PASS.
- [ ] **Step 4: Commit** `docs: the vault client (ADR-0021) and the architecture docs it changes`.
- [ ] **Step 5: Push and open the PR** (`gh pr create`, body with `Refs #193`, the design decisions, what PR 2 contains, and that no file owned by a parallel session changed except the construction in `test/semantic/tools/search-notes.test.ts`). Pause and report.

---

## PR 2 outline (planned in detail after PR 1 merges)

Tasks.md groups 7–9: the lexical reader as a view (`lexical/view.ts`), the loopback without `clientId`, `LOCAL_CONNECTION_ID`, the attachment shim and the legacy lexical facades deleted with their tests (scenarios re-expressed at the view and client), `createVaultClients` moved into `vault-client/`, `VaultEntries` `connectionId` → `clientId`, the embedding handshake on the epoch gate, the docs sweep of all of `docs/`, then verify → retrospective → archive → PR with `Closes #193`.
