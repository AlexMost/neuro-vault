Tracked by: #193

## Why

A session reaches a vault entry (in the shared daemon, or in-process under the fallback) through one pattern written out by hand three times: the corpus reads, the lexical leg, and the embedding provider. The one-way switch branch is re-implemented at 7 sites, attach-per-epoch twice, `NOT_ATTACHED → forget()` at 4, and the in-process facades re-implement the daemon's own services method by method. Adding the wikilink graph (#172) would cost about 18 files of plumbing. The 2026-10-19 architecture review made deepening this path its top recommendation; ADR-0020's closing constraint (no per-capability connection, switch or detach) is today a rule that each new facade must remember, and this change makes it structural.

## What Changes

**One vault client per vault root**
- From: per vault, a daemon semantic backend, a local semantic backend, a daemon lexical reader and a local lexical reader, each with its own switch branch, local memo and error mapping, over a daemon and a local attachment.
- To: one `IVaultClient` per vault root and side — `call(method, params)` typed by a method table in `src/daemon/protocol.ts`, plus `status(profile)`, `warm()` and `dispose()`. A socket adapter owns the switch, the attach per connection epoch, per-method timeouts and the `NOT_ATTACHED` forget; an in-process adapter runs the daemon's own service handlers over the in-process `VaultEntries`, with no connection id. `ISemanticBackend` and `ILexicalReader` become thin views over `call` that map its one error vocabulary to their domain errors.
- Reason: the switch, the attach and the error vocabulary in one place; a new per-vault read becomes a table row, a service handler and a view.
- Impact: non-breaking. No tool contract, wire method, error code or daemon lifecycle changes. An in-process `CORPUS_FAILED` / `NOT_ATTACHED` reaches the semantic backend's caller as the protocol's error with the same message, which `search_notes` already reports as `DEPENDENCY_ERROR`.

**The fallback runs the daemon's handlers**
- From: the in-process facades call `VaultEntries` directly under a fixed `LOCAL_CONNECTION_ID = 0`.
- To: one `createVaultEntryServices(entries)` builds the `vault`, `corpus` and `lexical` services; the daemon registers them and the in-process adapter dispatches to them through one loopback link per process — the analogue of the one connection — whose id is private to it and whose close detaches, as a closed socket does.
- Impact: non-breaking; one error vocabulary on both sides by construction.

**Embedding provider**
- From: its own per-epoch handshake.
- To: the same facade, its handshake on the client module's shared per-epoch gate (PR 2). It does not join `IVaultClient`: it is per profile, not per vault, and has no attach.

Delivered in two PRs: the foundation (client, both adapters, the semantic backend as a view, client tests) with `Refs #193`; then the lexical reader as a view, the embedding handshake, removal of the old facades and their tests, and the docs sweep, with `Closes #193`.

## Capabilities

### New Capabilities

- `vault-client`: one client per vault root and side as the session's only path to a vault entry; the typed method table shared by both sides of the socket; the in-process adapter running the daemon's handlers with one error vocabulary; one attach per vault per connection epoch whatever readers a vault has; a new per-vault read as a table row, a handler and a view.

### Modified Capabilities

None. The requirements of `shared-corpus-reads`, `shared-lexical-search`, `shared-vault-entry` and `daemon-embedding-provider` hold unchanged; this change re-implements the facades they describe.

## Impact

- **Code.** New: `src/modules/semantic/vault-client/` (link and loopback, epoch gate, attachment, client core, socket and in-process adapters), `src/daemon/services/vault-entry-services.ts`, `src/modules/semantic/backend/view.ts`, `src/modules/semantic/lexical/view.ts` (PR 2). Changed: `src/daemon/protocol.ts` (the method table and the `vault.*` types), `src/cli-daemon.ts` (registers the shared service map), `src/modules/semantic/backend/index.ts` (one client per root), `src/modules/semantic/daemon-embedding-provider.ts` (PR 2), `src/lib/vault-entry/vault-entries.ts` (PR 2: `connectionId` → `clientId`). Removed: `backend/daemon-backend.ts`, `backend/local-backend.ts` (PR 1), `backend/attachment.ts`, `lexical/daemon-reader.ts`, `lexical/local-reader.ts` (PR 2), and their tests.
- **Interfaces kept.** `ISemanticBackend`, `ILexicalReader`, `ICorpusReader`, `IRegisteredVault`, `EmbeddingProvider`, `ISharedServices`: unchanged shapes, so the retrieval pipeline, the tools and the eval harness do not change.
- **Docs.** ADR-0021 and its `INDEX.md` row; `docs/architecture/shared-daemon.md`, `semantic-backend.md`, `lexical-search.md`, `vault-entry.md`, `module-structure.md`, `vault-registry.md`; `GLOSSARY.md` gains "vault client".
- **Beneficiaries.** #172 (the graph in the daemon) and #115 (vault-entry assembly out of `server.ts`).
- **Not here.** The graph itself, any wire or lifecycle change, the `daemon status` output (unchanged: clients are connections).
