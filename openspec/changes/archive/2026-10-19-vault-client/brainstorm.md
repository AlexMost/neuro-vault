# Brainstorm — vault-client

Tracked by: #193. Source: the architecture review of 2026-10-19 (main at d23422a, v17.2.0), which rated this deepening "Strong" and made it the top recommendation; the owner asked for it in its own session. The requesting session handed the design forks to this one, so every decision below is this session's call, made against the evidence and the constraints the request named. Nothing here was confirmed by the owner beyond the request itself.

## Background

The path server → `VaultRegistry` → vault entry → daemon service → session reader is one pattern, written out by hand three times:

1. the corpus reads (#182): `createDaemonSemanticBackend` + `createLocalSemanticBackend`;
2. the lexical leg (#184, d41e17d: 23 files under `src/`, about 18 of them plumbing): `createDaemonLexicalReader` + `createLocalLexicalReader`;
3. the embedding provider, a slightly different third copy: `DaemonEmbeddingProvider`.

What repeats, verified on d23422a:

- **The switch branch.** `ISharedServices` owns the one-way switch, yet every facade re-implements `(await services.ensure()) === 'local' ? local().x : wire` — `daemon-backend.ts` ×4, `daemon-reader.ts` ×2, `daemon-embedding-provider.ts` ×1 — each with its own `local ??= opts.local()` memo (3 sites).
- **Attach per epoch, twice.** `DaemonEmbeddingProvider.handshake` and `createDaemonAttachment.attach` are the same single-flight-per-epoch shape. `NOT_ATTACHED → forget()` appears at 4 sites.
- **The in-process side impersonates a socket.** `LOCAL_CONNECTION_ID = 0` exists because the whole `VaultEntries` surface is keyed by a connection id.
- **The local facades are mechanical per method**: `entries.X(connectionId, await attachment.key(), …)` plus `VaultEntryError` → domain error. The daemon facades are `request('ns.method', { vault: await attachment.key(), … }, timeout)` plus `DaemonRpcError` → domain error. The daemon's own services (`src/daemon/services/{vault,corpus,lexical}.ts`) already do exactly the first half — validate, `entries.X(ctx.id, …)`, map `VaultEntryError` and read failures to wire codes — so the local facades are a second, hand-kept copy of the services.
- **Cost of the next reader.** The wikilink graph in the daemon (#172) would need: an `IVaultEntry` method, a `VaultEntries` method, a daemon service, protocol types and an error code, daemon / local / standalone facades, `createVaultClients` wiring, an `IRegisteredVault` field and factory, both factory sets in `server.ts`, an `admin.ts` line and `IVaultInfo` — about 18 files before its seven consumers change.

Deletion test: delete `createVaultClients` and the facades, and "which side, which connection, when to attach" reappears in `server.ts` and in every semantic tool. The concept earned its place; it is only spread over nine files with no locality.

## Scope (one sentence)

In: one client per vault root that owns the switch, the attach per connection epoch, per-method timeouts and the error vocabulary for both sides, with the semantic backend and the lexical reader as thin views over its `call`; out: any tool-contract, wire-protocol, daemon-lifecycle or retrieval-policy change, the embedding provider's own interface, and the graph itself (#172).

## Constraints carried in

- ADR-0018: a shared capability is a namespaced service plus a session-side facade over an interface the session already depends on, with an in-process fallback; no new protocol, process or port.
- ADR-0019: the semantic-leg composition and query embedding stay in the session; the daemon serves the corpus's reads only.
- ADR-0020: one connection and one one-way switch per process; attach without detach; the fallback runs the same `src/lib/vault-entry/` module. Its closing constraint — per-vault state "does not get its own connection, its own fallback switch or its own detach call" — is a rule today; this change makes it structural.
- Behaviour-preserving: the fallback decision, reconnect after a drop, timed-out-call semantics and the background attach at startup stay as `docs/architecture/semantic-backend.md` and `shared-daemon.md` describe them. `npm run eval` never touches this path.
- Parallel sessions own `src/modules/semantic/tools/*`, `retrieval-pipeline.ts`, `tool-helpers.ts`, `eval/`, `src/lib/obsidian/corpus/*`, `src/lib/vault-entry/vault-entry.ts`, `reconcile-loop.ts`, `src/cli-index.ts`, `package.json`, `ci.yml`, `src/cli.ts`, `src/config.ts`, `src/modules/operations/*`. None of them may change here; the interfaces they depend on (`ISemanticBackend`, `ILexicalReader`, `ICorpusReader`, `IRegisteredVault`) keep their shapes.

## Decision chain

### Q1 — How is the method table typed?

One `interface VaultMethods` in `src/daemon/protocol.ts`, one row per per-vault read: `'corpus.nearest': { params: CorpusNearestParams; result: CorpusNearestResult }`, and the same for `corpus.nearestBlocks` and `lexical.search`. The client's signature is

```ts
call<M extends VaultMethod>(method: M, params: VaultCallParams<M>): Promise<VaultResult<M>>
```

where `VaultCallParams<M>` is the row's params without `vault` — the client adds the key it attached under. The params and result types are the wire shapes that already exist, so the daemon's services and the session's views type against the same rows.

- An `interface`, not a `type` alias, on purpose: a test can add a row by declaration merging, which is how the cost claim is proved (Q9).
- `vault.attach` and `vault.status` are **not** rows. They are the client's lifecycle (attach per epoch, the status placeholders), never something a view calls by name. They get their own named param/result types beside the table (today they are untyped on the session side).
- `profile` stays in the params of `corpus.*`. The client is per vault root, not per profile; the semantic view knows its profile.

Rejected: a runtime table of `{ method, timeout, decode }` descriptors (a second place to edit per method, and the timeouts are the session's policy, not the protocol's); one generic `request(method: string, …)` (loses the typing that makes a view ten lines).

### Q2 — What does the in-process adapter run?

**The daemon's own service handlers, called in-process** — a loopback over `createVaultEntryServices(entries)`, the same `{ vault, corpus, lexical }` map the daemon registers. A call is `handlers[ns][method](params, ctx)`; a `DaemonRpcError` is rethrown as is, anything else becomes `DaemonRpcError('INTERNAL', message)`, exactly what `ServiceRegistry.dispatch` puts on the wire.

Why: the services already are "validate, `entries.X(ctx.id, …)`, map to the protocol's codes". Writing that a second time per method is the duplication. With a loopback, both sides answer every read with one error vocabulary by construction, the in-process path validates the same params the daemon does (a view that builds a bad param fails the same way on both sides, in tests too), and a new service registered once serves both sides.

Cost: params take their wire shape in-process too — a query vector goes `Float32Array` → `number[]`, `allowed` goes set → array → set. A query vector is a few hundred numbers; `allowed` is at most the vault's note count. Values are unchanged (`float32` → `number` is exact). Accepted.

Rejected: (a) a per-method in-process table over `VaultEntries` (the duplication this change removes); (b) splitting each service into "validate" and a shared "operation" layer both sides call (same effect as the loopback, more files, and the in-process side would skip validation the daemon applies).

### Q3 — How does the in-process adapter identify a client?

By the link it calls through. The in-process side gets **one loopback link per process**, the analogue of the daemon side's one connection (ADR-0020: one connection per process): every vault's in-process client sends through it. The link carries the identity: its client id is drawn from a counter private to the link module, and its `close()` runs the `onClose` callbacks the vault service registered — `entries.detach(id)`, exactly what a closed socket does in the daemon. The client therefore never names a connection id, and `LOCAL_CONNECTION_ID` goes. `VaultEntries` keeps keying by an id, because in the daemon a closed connection *is* the detach; in PR 2 its parameter is renamed from `connectionId` to `clientId`, since it identifies a client of the entry, whatever carries it.

One link per vault root was considered and rejected: the in-process entries never idle out and are disposed whole at shutdown, so per-root detach buys nothing, and one id per process keeps the fallback the same shape as the daemon side (one client of each entry per process).

Transitional (PR 1 only): the legacy in-process lexical reader still calls `entries.lexical(LOCAL_CONNECTION_ID, key)` directly and must share the vault's one attach, so in PR 1 the loopback link is created with that id explicitly. PR 2 moves the reader onto the client and drops the option.

### Q4 — Where does attach-per-epoch live?

Once. A link is `{ epoch, request(method, params, timeoutMs) }` — `DaemonConnection` already is one; the loopback link's epoch never changes. The attachment (today's `createDaemonAttachment`: single-flight per epoch, an answer from a replaced epoch records nothing, `key()` retries a few times when every answer lands on a replaced epoch, `forget()`) is generalised over a link and serves both adapters. `createLocalAttachment` retires: the in-process attach is a `vault.attach` through the loopback.

The single-flight-per-epoch part is its own small primitive (`createEpochGate`), because `DaemonEmbeddingProvider.handshake` is the same shape; PR 2 moves the handshake onto it.

`NOT_ATTACHED → forget()` moves into the client's `call` and `status`: one site.

### Q5 — Where do the status placeholders live?

`IVaultClient.status(profile)` — it never rejects:

- the switch still `pending` (the daemon being located or started): `indexing` 0/0 at once, and the connect-then-attach (or the in-process attach, if the switch goes `local`) starts in the background;
- an attach in flight: `indexing` 0/0;
- this call made or joined the attach: the attach answer's status for `profile`;
- otherwise `vault.status`;
- a timeout reads `unavailable` "daemon did not answer"; any other failure `unavailable` with its message, for that call only.

`BackendStatus` is the vault entry's per-profile status, and the placeholders are properties of attaching in the background, so they belong with the attach, not in each view. The semantic view's `status()` is `client.status(profile)`.

The in-process status today reads the live status even right after its own attach, where the daemon side reads the attach answer. They are the same value (the attach computes it synchronously at its end); one rule now serves both.

### Q6 — What does `call` reject with, and who maps it?

Two kinds, the same on both sides where they can occur:

- `DaemonRpcError` with the protocol's code — the entry refused (`NOT_ATTACHED`, `VAULT_UNAVAILABLE`, `UNKNOWN_PROFILE`, `CORPUS_NOT_READY` with its status in `data`, `CORPUS_FAILED`, `LEXICAL_FAILED`, `INVALID_PARAMS`, `INTERNAL`). The in-process side produces these through the services' own `wired`.
- transport failures, socket side only: `DaemonTimeoutError`, `DaemonConnectionError`, `SharedServicesClosedError`, a malformed answer.

The view maps them to its interface's domain error, once per interface: the semantic view maps `CORPUS_NOT_READY` and `VAULT_UNAVAILABLE` to `CorpusNotReadyError` and rethrows the rest; the lexical view wraps everything in `LexicalSearchError` with today's messages. Domain errors differ per interface, so this mapping cannot live in the adapter; the adapter's own error handling is the `NOT_ATTACHED` forget and nothing else.

What changes for a caller: an in-process `CORPUS_FAILED` or `NOT_ATTACHED` now reaches the semantic backend's caller as a `DaemonRpcError` with the same message instead of the raw error or a `VaultEntryError`. `search_notes` reports both as the same `DEPENDENCY_ERROR` with the same message; nothing branches on those classes.

### Q7 — Timeouts

The socket adapter's own table: `vault.attach` 10 s, `vault.status` 10 s, every row 30 s unless listed — `Partial<Record<…>>` with a default, so a new row needs no timeout entry. The loopback ignores timeouts (a call runs to completion, as today). Today's values are kept: corpus reads 30 s, `lexical.search` 30 s.

### Q8 — Does the embedding provider join the client?

No. It is process-wide and per profile, not per vault: it has no vault key and no attach, its per-epoch handshake (`embed.initialize`) also refreshes the batch size, and `embedDocuments` chunks by it. Putting it on `IVaultClient` would widen the client with a vault-less call path and provider state. It already shares the switch (`services.ensure()`); PR 2 moves its handshake onto the shared epoch gate, so attach-per-epoch exists once in the code. Its `fallback ??=` memo stays — one site, owned by the one facade that has no vault.

### Q9 — The cost claim, as a test

A test augments `VaultMethods` with a hypothetical row (declaration merging), registers a handler for it on the daemon side of a real socket server and in the in-process service map, writes a three-line view, and calls it through **both** adapters with no adapter, link, attachment or `createVaultClients` change. `npm run typecheck` covers the test file, so if anything required an exhaustive per-method record (a timeout table, a decoder table), the augmentation would fail the typecheck — the claim fails loudly.

What a real new read still needs, inherently: the entry's own method (`IVaultEntry`/`VaultEntries`), the service handler (registered once in `createVaultEntryServices`, which both sides use), the table row, and the view. That is four places, against about 18 today.

### Q10 — What does `daemon status` report?

Unchanged. Clients are connections; the in-process clients were never visible to it and still are not. Nothing in `IVaultInfo` or `admin.ts` moves.

### Q11 — Where the code lives

`src/modules/semantic/vault-client/`: `link.ts` (the link type and the loopback), `epoch-gate.ts`, `attachment.ts`, `client.ts` (`IVaultClient` and the core over a link), `daemon-client.ts` (the socket adapter: the switch, the pending status, timeouts), `in-process-client.ts`. The views sit where today's facades do: `backend/view.ts`, `lexical/view.ts`. `createVaultEntryServices` sits in `src/daemon/services/` and `cli-daemon.ts` registers its result. `createVaultClients` (the per-root registry of clients, which builds the views for `IRegisteredVault`) stays in `backend/index.ts` in PR 1 and moves into `vault-client/` in PR 2.

### Q12 — Is this ADR-level?

Yes: it decides how every later per-vault capability reaches the vault entry (a table row and a view over one client), and that the in-process fallback runs the daemon's own service handlers. ADR-0021, Accepted with the change; it refines ADR-0020's "the fallback runs the same module" down to "the same handlers", and supersedes nothing.

### Q13 — Delivery

Two PRs (one change, two PRs; foundation first, then pause):

1. **Foundation** (`Refs #193`): the method table, `createVaultEntryServices`, the link, the epoch gate, the attachment over a link, `IVaultClient` with both adapters, the semantic backend as a view, the client tests (both adapters at the interface) and the cost-claim test. `daemon-backend.ts`, `local-backend.ts` and their tests go — the view replaces them, and the behaviours their tests pinned move to the client tests. The lexical facades and the embedding provider are untouched; they share the client's attachment through `createVaultClients`, so a vault still sends one `vault.attach` per epoch. Docs for what changed, ADR-0021.
2. **Completion** (`Closes #193`): the lexical reader as a view; the embedding handshake on the epoch gate; `LOCAL_CONNECTION_ID`, `createLocalAttachment`, the legacy lexical facades and their tests deleted; `connectionId` → `clientId` in `VaultEntries`; `createVaultClients` moved; the docs sweep (all of `docs/`, `GLOSSARY.md`).

## Design trade-offs kept in view

- **Loopback validation in-process.** A few hundred extra number checks per anchor and one array copy of `allowed` per read; in exchange, one implementation and one error vocabulary.
- **Client error classes change in-process** (Q6) — same messages and the same tool-level outcome.
- **The transitional fixed id in PR 1** (Q3) keeps the lexical leg on the vault's one attach until PR 2.

## Acceptance

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass on each PR; `npm run eval` unchanged.
- No tool-contract change; `search_notes`, `get_similar_notes`, `find_duplicates` payloads unchanged (the existing integration and tool tests stand).
- One vault sends one `vault.attach` per connection epoch, whichever readers it has.
- The cost-claim test passes, and typechecks.
