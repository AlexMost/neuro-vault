## Context

The decisions are in `brainstorm.md` (Q1–Q13), made by this session on the evidence of the 2026-10-19 architecture review (main at d23422a). This file turns them into a technical design and fixes the names, files and seams.

**Today, session side.** `ISharedServices` (`src/modules/semantic/shared-services.ts`) owns the process's one `DaemonConnection` (an `IDaemonLink`: `epoch`, `ensure`, `close`, `request`) and the one-way switch (`ensure()` → `'daemon' | 'local'`, `mode` `pending | daemon | local`). `createVaultClients` (`src/modules/semantic/backend/index.ts`) builds, per vault root and side, one `IVaultAttachment` (`backend/attachment.ts`: `createDaemonAttachment` single-flight per epoch over `services.connection`, `createLocalAttachment` over `VaultEntries.attach(LOCAL_CONNECTION_ID, …)`), and hands it to four facades: `createDaemonSemanticBackend` / `createLocalSemanticBackend` (`backend/daemon-backend.ts`, `local-backend.ts`) and `createDaemonLexicalReader` / `createLocalLexicalReader` (`lexical/daemon-reader.ts`, `local-reader.ts`). Each daemon facade repeats the switch branch and a `local ??=` memo; each local facade repeats what the daemon's services do. `DaemonEmbeddingProvider` repeats the per-epoch single flight for `embed.initialize`.

**Today, daemon side.** `src/daemon/services/{vault,corpus,lexical}.ts` validate params (`asRecord`, `onlyKeys`), call `VaultEntries` with `ctx.id`, and map `VaultEntryError` (`wired`) and read failures (`CORPUS_FAILED`, `LEXICAL_FAILED`) to `DaemonRpcError`. `cli-daemon.ts` registers the three. `ServiceRegistry.dispatch` turns any other throw into `INTERNAL`.

**Constraints.** ADR-0018, ADR-0019, ADR-0020 (see the brainstorm). No tool-contract or wire change; behaviour as `docs/architecture/semantic-backend.md` and `shared-daemon.md` describe. Files owned by parallel sessions are listed in the brainstorm and are not edited; `ISemanticBackend`, `ILexicalReader`, `ICorpusReader`, `IRegisteredVault` keep their shapes. Naming (`docs/architecture/naming-conventions.md`): interfaces take the `I` prefix; wire types in `protocol.ts` keep their existing unprefixed style.

## Goals / Non-Goals

**Goals:**

- One `IVaultClient` per vault root and side, the session's only path to a vault entry.
- The switch, the attach per connection epoch, the per-method timeouts and the `NOT_ATTACHED` forget each in exactly one place.
- The in-process fallback answers with the daemon's own handlers, so both sides share one error vocabulary.
- `ISemanticBackend` and `ILexicalReader` as views of a few lines each; a new per-vault read costs a table row, a service handler and a view, proved by a test.
- Behaviour, tool payloads and `npm run eval` unchanged.

**Non-Goals:**

- The wikilink graph in the daemon (#172) or moving vault-entry assembly out of `server.ts` (#115): this change only makes them cheaper.
- Any wire method, error code, daemon lifecycle or `daemon status` change.
- Folding the embedding provider into `IVaultClient`.
- Changing `VaultEntries`' semantics (PR 2 renames one parameter).

## Decisions

### D1: The method table in `protocol.ts`

- **Choice**:

  ```ts
  export interface VaultAttachParams { vault: string; profiles: string[] }
  export interface VaultAttachResult { vault: string; profiles: Record<string, BackendStatus> }
  export interface VaultStatusParams { vault: string; profile: string }

  /** The per-vault reads, one row per method: both sides of the socket type against it. */
  export interface VaultMethods {
    'corpus.nearest': { params: CorpusNearestParams; result: CorpusNearestResult };
    'corpus.nearestBlocks': { params: CorpusNearestBlocksParams; result: CorpusNearestBlocksResult };
    'lexical.search': { params: LexicalSearchParams; result: LexicalSearchResult };
  }
  export type VaultMethod = keyof VaultMethods;
  /** A row's params as a view sends them: the client adds the vault key it attached under. */
  export type VaultCallParams<M extends VaultMethod> = Omit<VaultMethods[M]['params'], 'vault'>;
  export type VaultCallResult<M extends VaultMethod> = VaultMethods[M]['result'];
  ```

  An `interface`, so a test can add a row by declaration merging. `vault.attach` / `vault.status` are typed but not rows: they are the client's lifecycle. The daemon services annotate their handlers' results with the row types (they already return `CorpusNearestResult` etc.); `vault.ts` returns `VaultAttachResult` / `BackendStatus`.
- **Why**: brainstorm Q1. One table, the existing wire shapes, typed once.
- **Alternatives**: a runtime descriptor table (`{ timeout, decode }` per method) — a second place to edit per method; a stringly `request(method: string)` — loses the typing the views rely on.

### D2: `createVaultEntryServices` — the handlers both sides run

- **Choice**: `src/daemon/services/vault-entry-services.ts`:

  ```ts
  export type VaultEntriesPorts = VaultEntriesPort & CorpusEntriesPort & LexicalEntriesPort;
  /** The vault entry's services: what the daemon registers, and what the in-process client dispatches to. */
  export function createVaultEntryServices(entries: VaultEntriesPorts): Record<string, ServiceHandlers> {
    return {
      vault: createVaultService(entries),
      corpus: createCorpusService(entries),
      lexical: createLexicalService(entries),
    };
  }
  ```

  `cli-daemon.ts` registers each entry of the map. A later per-vault service (`graph`) is one line here and is served by both sides.
- **Why**: brainstorm Q2. The daemon and the fallback cannot drift (ADR-0020 "the fallback runs the same module", down to the handlers).
- **Alternatives**: keeping the three `register` lines in `cli-daemon.ts` and a second list in the session (two lists to keep in step).

### D3: The link, and the in-process loopback

- **Choice**: `src/modules/semantic/vault-client/link.ts`:

  ```ts
  /** What a vault client sends through: the daemon connection, or the in-process loopback. */
  export interface IVaultLink {
    /** Changes on every new connection; per-connection setup is re-sent once per value. */
    readonly epoch: number;
    request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
  }
  export interface IInProcessLink extends IVaultLink {
    /** Runs every `onClose` the services registered (detaching the link's client); later requests reject. */
    close(): void;
  }
  export function createInProcessLink(
    services: Record<string, ServiceHandlers>,
    opts?: { clientId?: number },
  ): IInProcessLink;
  ```

  `IDaemonLink` is already an `IVaultLink`. The loopback resolves `<namespace>.<method>` the way `ServiceRegistry` does (own properties only; else `DaemonRpcError('UNKNOWN_METHOD')`), calls the handler with a context `{ id, onClose }`, rethrows a `DaemonRpcError` as is and turns any other throw into `DaemonRpcError('INTERNAL', message)` — what the wire would carry. Its epoch is a constant; it ignores `timeoutMs`. The client id comes from a counter private to the module unless `opts.clientId` names one (PR 1 only, for the legacy lexical reader, brainstorm Q3). One loopback per process, built by `createVaultClients` on first use over the in-process `VaultEntries`, closed by its `dispose()`.
- **Why**: brainstorm Q2, Q3.
- **Alternatives**: one loopback per vault root (per-root detach buys nothing: the in-process entries never idle out and are disposed whole); serialising params through JSON in the loopback (exactly the wire, but a copy of every result for nothing — the handlers already build fresh result objects).

### D4: The epoch gate and the attachment

- **Choice**: `vault-client/epoch-gate.ts`:

  ```ts
  /** `run` once per link epoch: concurrent callers share one run; a run that settles on a replaced epoch commits nothing. */
  export interface IEpochGate {
    readonly done: boolean;      // succeeded on the current epoch (and not forgotten)
    readonly running: boolean;   // a run is in flight on the current epoch
    pass(): Promise<void>;       // run unless done; joins a run in flight on this epoch
    forget(): void;              // the next pass() runs again
  }
  export function createEpochGate<T>(
    link: { readonly epoch: number },
    run: () => Promise<T>,
    commit: (value: T) => void,
  ): IEpochGate;
  ```

  `vault-client/attachment.ts` keeps `IVaultAttachment` (`key()`, `forget()`, `attaching`, `attached`, `statusOf(profile)`) and implements it once, `createAttachment({ link, vaultRoot, profiles })`, over a gate whose run is `vault.attach` (10 s) and whose commit records the key and the statuses. `key()` keeps today's rule: it re-asks on the current epoch and rejects after three answers in a row landed on a replaced one; an answer without a vault key rejects. `backend/attachment.ts` becomes a PR-1 shim re-exporting the type, `createDaemonAttachment({ services, … })` as `createAttachment({ link: services.connection, … })`, and the legacy `createLocalAttachment` for the tests that still use it; PR 2 deletes it. PR 2 also moves `DaemonEmbeddingProvider.handshake` onto a gate (commit: the batch size), which commits only on the epoch it ran on.
- **Why**: brainstorm Q4. One single-flight-per-epoch implementation.
- **Alternatives**: a gate inside the attachment only (the embedding handshake would stay a second copy).

### D5: `IVaultClient` and its core

- **Choice**: `vault-client/client.ts`:

  ```ts
  export interface IVaultClient {
    /** One read of the vault entry, under the key this side attached; attaches first when needed. */
    call<M extends VaultMethod>(method: M, params: VaultCallParams<M>): Promise<VaultCallResult<M>>;
    /** `profile`'s status. Never rejects: a failure reads `unavailable` for this call only. */
    status(profile: string): Promise<BackendStatus>;
    /** Attach now; never rejects (a head start: the next call meets any failure again). */
    warm(): Promise<void>;
    /** Releases what this client built on its own; the connection and the entries are the process's. */
    dispose(): Promise<void>;
  }
  export function createLinkedVaultClient(opts: { link: IVaultLink; attachment: IVaultAttachment }): IVaultClient;
  ```

  The timeouts live in `vault-client/timeouts.ts` (`VAULT_CALL_TIMEOUTS`: `default` 30 s, `vault.attach` and `vault.status` 10 s; `timeoutOf(method)`), one home shared by the attachment and the core; a new row needs no entry.

  The core over one link:
  - `call`: `await attachment.key()`, then `link.request(method, { ...params, vault: key }, timeout)`; a `DaemonRpcError` `NOT_ATTACHED` forgets the attach; every failure is rethrown as is.
  - `status(profile)`: an attach in flight reads `indexing` 0/0; not attached → this call makes or joins the attach and reads its answer's status for `profile` (`unavailable` if the answer lacks it); attached → `vault.status`, checked to be a status. A failure reads `unavailable` — "daemon did not answer" for a `DaemonTimeoutError`, else its message — and `NOT_ATTACHED` also forgets.
  - `warm`: `attachment.key()`, failures swallowed. `dispose`: nothing.

  The in-process adapter **is** this core over the loopback link (brainstorm Q2): there is nothing left to adapt.
- **Why**: brainstorm Q5, Q6, Q7.
- **Alternatives**: `status` as a table row (`vault.status`) the views call by name (the placeholders would have to live in every view); timeouts as a required `Record<VaultMethod, number>` (a new row would have to touch the client).

### D6: The socket adapter

- **Choice**: `vault-client/daemon-client.ts`:

  ```ts
  export function createDaemonVaultClient(opts: {
    services: ISharedServices;
    /** The vault's attachment over `services.connection`. */
    attachment: IVaultAttachment;
    /** The vault's in-process client, built once, on the first call after the switch went `local`. */
    local: () => IVaultClient;
  }): IVaultClient;
  ```

  It wraps a core over `services.connection` and owns the switch once: `side()` = `(await services.ensure()) === 'local' ? local() : core`, the one `local ??=` memo. `call` and `warm` go through `side()`. `status(profile)`: while `services.mode` is `pending` it answers `indexing` 0/0 at once and starts `side()` then `warm()` in the background (concurrent statuses share it; a `SharedServicesClosedError` met there is remembered and later reads `unavailable` with its reason); once decided, `side()` then that side's `status`; a rejected `ensure()` reads `unavailable`. `dispose` disposes the in-process client if one was built.
- **Why**: the one place the switch is consulted per vault; brainstorm Q5.
- **Alternatives**: the switch inside the core (the in-process core would carry a switch it never uses).

### D7: The semantic backend is a view

- **Choice**: `backend/view.ts`:

  ```ts
  export function createSemanticBackendView(client: IVaultClient, profile: string): ISemanticBackend;
  ```

  `status()` → `client.status(profile)`; `nearest` / `nearestBlocks` → `client.call('corpus.*', { profile, anchors: anchors.map(anchorParam), … })` with today's param building (vectors as `number[]`, no `undefined` keys, sets as arrays), the answer checked to hold one list per anchor; `DaemonRpcError` `CORPUS_NOT_READY` → `CorpusNotReadyError(data.status, message)`, `VAULT_UNAVAILABLE` → `CorpusNotReadyError({ state: 'unavailable', reason })`, anything else rethrown; `dispose()` → `client.dispose()`. `daemon-backend.ts` and `local-backend.ts` are deleted; `createDisabledSemanticBackend` stays.
- **Why**: brainstorm Q6; the mapping is per interface.
- **Alternatives**: keeping the old facades beside the view until PR 2 (dead code with tests of their own).

### D8: `createVaultClients` builds one client per root and side

- **Choice**: per vault root, `{ attachment, client }` per side, built on the first factory call for that root (today's rule: the registry passes the same `enabled` to both factory calls; the first wins). The in-process side: the one loopback over `createVaultEntryServices(localEntries())`, `createAttachment` over it, `createLinkedVaultClient`. The daemon side: `createAttachment` over `services.connection`, `createDaemonVaultClient` whose `local` is the root's in-process client. `semanticBackendFactory` wraps the side's client in the view (or returns the disabled backend). In PR 1 `lexicalReaderFactory` still builds the legacy readers, over the same per-root attachment — so a vault still sends one `vault.attach` per epoch — and the in-process loopback is created with `clientId: LOCAL_CONNECTION_ID`, the id the legacy local reader reads under. `dispose()` closes the loopback, then disposes the entries. PR 2: the lexical view, `LOCAL_CONNECTION_ID` and the shim go, and the function moves to `vault-client/index.ts`.
- **Why**: brainstorm Q3, Q13.

### D9: The embedding provider stays its own facade

- **Choice**: unchanged in PR 1; in PR 2 its handshake runs on a `createEpochGate`. It is per profile and process-wide, has no vault key and no attach, and its handshake also carries the batch size; on `IVaultClient` it would widen the client with a vault-less path.
- **Why**: brainstorm Q8.

### D10: The cost claim is a test

- **Choice**: `test/semantic/vault-client/new-read.test.ts` augments `VaultMethods` with a hypothetical `'probe.echo'` row, registers a `probe` service next to `createVaultEntryServices(entries)` on a real socket server (the daemon side) and in the in-process loopback, defines a three-line view, and calls it through both adapters, built by their production factories with no change. The typecheck covers the file: an exhaustive per-method record anywhere would fail it.
- **Why**: brainstorm Q9.

### D11: Documentation and the ADR

- **Choice**: ADR-0021 "One vault client per vault root; per-vault reads are views over it" (Accepted), refining ADR-0020's "the fallback runs the same module" to "the same handlers" and supersedes nothing; `INDEX.md` row. `GLOSSARY.md` gains **vault client**. PR 1 updates `docs/architecture/shared-daemon.md` (session-side facades, how a new service attaches), `semantic-backend.md`, `vault-entry.md`, `module-structure.md`, `vault-registry.md`; PR 2 `lexical-search.md` and the sweep of all of `docs/`.

## Risks / Trade-offs

- [Risk] The loopback validates params the old local facades passed straight through, so a param the view builds that the daemon would reject now also fails in-process → Mitigation: that is the point (one contract); the client tests run the same reads through both adapters, and the existing `--no-shared` tests (factory, integration) run through the loopback.
- [Risk] A behaviour drift hidden in the merge of the two attachments and the two status rules (D4, D5) → Mitigation: every scenario of `daemon-backend.test.ts`, `local-backend.test.ts` and the factory tests that pinned the session-visible behaviour is re-expressed at the client's interface or the view's before the old files go; `test/integration/*` and `test/semantic/tools/*` run unchanged in intent.
- [Trade-off] In-process errors change class (`DaemonRpcError` where a raw error or a `VaultEntryError` reached the caller) → accepted: the tools report the same `DEPENDENCY_ERROR` with the same message; nothing branches on those classes (checked: `src/modules/semantic/tools/*`, `single-vault-tool.ts`).
- [Trade-off] In-process `CorpusNotReadyError` now carries the corpus service's message (`the corpus of profile "…" is indexing`) instead of the default (`the corpus is indexing`) → accepted: the tools render the status, not the message, which only reaches a stderr warning.
- [Trade-off] A relative vault root would now fail the in-process attach with `INVALID_PARAMS` (the vault service's check) instead of `VAULT_UNAVAILABLE` → accepted: `config.ts` rejects a vault path that is not absolute before any vault is registered.
- [Trade-off] PR 1 is transitional: the legacy lexical readers and `LOCAL_CONNECTION_ID` remain, over the shared attachment → PR 2 removes them; until then a vault still attaches once per epoch.
- [Risk] Merge conflicts with parallel sessions → Mitigation: none of their files is edited; `test/semantic/tools/search-notes.test.ts` (a test beside their files) changes only its backend construction.

## Migration Plan

N/A — no deployment, wire, config or data change. Each PR ships as a minor-or-patch release on the normal flow (`npm run release` on `main` after merge). Rollback is a revert of the PR; nothing persists.

## Open Questions

None blocking. Left to PR 2: whether `VaultEntries.lexical()`/`reader()` collapse into one `entry(clientId, vault)` accessor (useful for #172), decided when the graph's first method lands.
