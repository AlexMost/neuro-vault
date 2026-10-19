# Tasks — vault-client

Two PRs (design D8, brainstorm Q13). PR 1 (`Refs #193`): groups 1–6, then pause and report. PR 2 (`Closes #193`): groups 7–9, then verify → retrospective → archive → PR.

Parallelism: groups 1 and 2 are parallel-safe with each other (protocol + daemon services vs. the session-side primitives; no shared files). Group 3 needs 1 and 2. Group 4 needs 3. Group 5 needs 4. Group 6 is sequential after 5. In PR 2, group 7 and group 8 are parallel-safe (lexical files vs. the embedding provider); group 9 is last.

## 1. The method table and the shared service map (parallel-safe with 2)

- [ ] 1.1 `protocol.ts`: `VaultAttachParams`, `VaultAttachResult`, `VaultStatusParams`, `interface VaultMethods` (three rows), `VaultMethod`, `VaultCallParams<M>`, `VaultCallResult<M>` (design D1); the `vault` service's handlers annotated with the attach/status result types. Typecheck only; no behaviour.
- [ ] 1.2 `src/daemon/services/vault-entry-services.ts`: `createVaultEntryServices(entries)` → `{ vault, corpus, lexical }`; `cli-daemon.ts` registers each entry of the map (design D2). Test: the map has exactly those namespaces, and a request dispatched through a `ServiceRegistry` built from it reaches the entries.

## 2. The link, the loopback and the epoch gate (parallel-safe with 1)

- [ ] 2.1 `vault-client/epoch-gate.ts`: `createEpochGate(link, run, commit)` (design D4). Tests: one run per epoch shared by concurrent callers; a new epoch runs again; a run that settles on a replaced epoch commits nothing and is not `done`; a rejected run leaves it not done and the next `pass()` runs again; `forget()`; `running` only while in flight on the current epoch.
- [ ] 2.2 `vault-client/link.ts`: `IVaultLink`, `IInProcessLink`, `createInProcessLink(services, { clientId? })` (design D3). Tests: resolves `<ns>.<method>` to the handler with a context carrying a private id (distinct per link) or the named one; unknown and prototype names → `UNKNOWN_METHOD`; a `DaemonRpcError` passes through, any other throw becomes `INTERNAL` with its message; `close()` runs the registered `onClose` callbacks once, and a request after it rejects.

## 3. The attachment over a link (needs 1, 2)

- [ ] 3.1 `vault-client/attachment.ts`: `IVaultAttachment` and `createAttachment({ link, vaultRoot, profiles })` over an epoch gate, keeping today's rules (re-ask on the current epoch, reject after three answers on replaced epochs, reject an answer without a key) (design D4). `backend/attachment.ts` becomes the PR-1 shim (`createDaemonAttachment` over `services.connection`, legacy `createLocalAttachment` unchanged); `test/semantic/backend/attachment.test.ts` passes unchanged against it.

## 4. `IVaultClient`: the core and the socket adapter (needs 3)

- [ ] 4.1 `vault-client/client.ts`: `IVaultClient`, `VAULT_CALL_TIMEOUTS`, `createLinkedVaultClient({ link, attachment })` (design D5). `vault-client/daemon-client.ts`: `createDaemonVaultClient({ services, attachment, local })` (design D6). `vault-client/index.ts` exports.
- [ ] 4.2 Client tests at the interface, socket adapter over a fake `ISharedServices` and the in-process client over a loopback on real `VaultEntries` (temp vault, injected embedder): attach once per epoch and on a new epoch; concurrent first calls share one attach; status placeholders (pending → `indexing` 0/0 at once with a background attach; attach in flight; the attach answer's status; live `vault.status` after another reader attached); timeouts (status → `unavailable` "daemon did not answer"; attach timeout → `unavailable`, next call attaches again); `VAULT_UNAVAILABLE` → `unavailable` with its reason, re-attach next call; dropped connection → `unavailable` for that call; `NOT_ATTACHED` → forget, next call attaches; every call goes in-process once the switch is `local`, the local client built once; closed services under a connect → no `vault.attach`, later status `unavailable`; per-method timeouts sent; the same reads answer the same on both adapters (results and `CORPUS_NOT_READY` refusals).
- [ ] 4.3 Socket-level client tests (`test/integration/`): the socket adapter against a real `startDaemonServer` with `createVaultEntryServices` — two sessions share one entry, a killed server is reconnected and re-attached once on the next call.

## 5. The semantic backend as a view; one client per root (needs 4)

- [ ] 5.1 `backend/view.ts`: `createSemanticBackendView(client, profile)` (design D7). Tests over a fake client: param building (`number[]` vectors, no `undefined` keys, sets as arrays, `profile` added); one list per anchor checked; `CORPUS_NOT_READY` → `CorpusNotReadyError` with the daemon's status; `VAULT_UNAVAILABLE` → `CorpusNotReadyError` `unavailable`; `CORPUS_FAILED` rethrown as is; `status()` and `dispose()` delegate.
- [ ] 5.2 `createVaultClients` builds one `{ attachment, client }` per root and side, the in-process side over one loopback (`clientId: LOCAL_CONNECTION_ID` in PR 1), the semantic factory returning the view, the legacy lexical readers over the same attachment; `dispose()` closes the loopback, then the entries (design D8). Delete `backend/daemon-backend.ts`, `backend/local-backend.ts` and their tests after their scenarios live in 4.2 / 5.1; port `test/semantic/backend/factory.test.ts`, `test/integration/session-daemon.test.ts` and the backend construction in `test/semantic/tools/search-notes.test.ts`.
- [ ] 5.3 The cost-claim test `test/semantic/vault-client/new-read.test.ts` (design D10): an augmented `VaultMethods` row, its handler on a real socket server and in the loopback, a three-line view, both adapters through their production factories; `npm run typecheck` covers it.

## 6. PR 1 docs, ADR, gates, PR (sequential after 5)

- [ ] 6.1 ADR-0021 and its `INDEX.md` row; `GLOSSARY.md` "vault client"; `docs/architecture/shared-daemon.md` (session-side facades, how a new service attaches), `semantic-backend.md`, `vault-entry.md`, `module-structure.md`, `vault-registry.md` updated for what PR 1 changed (design D11).
- [ ] 6.2 `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`; `npx commitlint --from origin/main --to HEAD`; PR with `Refs #193`; pause and report.

## 7. The lexical reader as a view (PR 2; parallel-safe with 8)

- [ ] 7.1 `lexical/view.ts`: `createLexicalReaderView(client)` (`call('lexical.search')` → `fromWire`; every failure a `LexicalSearchError` with today's messages; `warm()` → `client.warm()`). `createVaultClients` uses it; the loopback loses `clientId`; `LOCAL_CONNECTION_ID`, the attachment shim, `lexical/daemon-reader.ts`, `lexical/local-reader.ts`, `test/semantic/backend/attachment.test.ts`, `test/semantic/lexical/daemon-reader.test.ts`, `local-reader.test.ts` deleted after their scenarios live in view and client tests; `parity.test.ts` and `test/integration/*` ported. `createVaultClients` moves to `vault-client/index.ts`.
- [ ] 7.2 `VaultEntries`: `connectionId` → `clientId` (parameter names and doc comments only).

## 8. The embedding handshake on the epoch gate (PR 2; parallel-safe with 7)

- [ ] 8.1 `DaemonEmbeddingProvider.handshake` runs on `createEpochGate` (commit: the batch size, on the epoch it ran on); `test/semantic/daemon-embedding-provider*` unchanged and passing, plus one test that a handshake answered on a replaced epoch commits nothing.

## 9. PR 2 docs sweep, verify, archive, PR (sequential after 7, 8)

- [ ] 9.1 Sweep all of `docs/` (architecture, guide, README) and `GLOSSARY.md` for the old facade names, `LOCAL_CONNECTION_ID`, `connectionId`; `docs/architecture/lexical-search.md` updated.
- [ ] 9.2 `/opsx:verify` → `verify.md`; `retrospective.md`; `/opsx:archive`; gates; PR with `Closes #193`.
