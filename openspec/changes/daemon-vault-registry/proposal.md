Tracked by: #175

## Why

Every stdio session keeps its own watcher, reconcile loop and fully decoded corpus for each vault, even though the model already lives in the shared daemon (ADR-0018). On a ~955-note vault an extra semantic session settles at ~156 MB against ~63 MB at the `--no-semantic` floor (baseline on #158), so ~93 MB per session is per-vault state the daemon can hold once; N sessions also run N watchers and N reconcile loops over one directory. ADR-0019 settled the seam that lets this state move: the corpus is an interface inside the daemon and sessions read it, never its vectors. This change, the first of epic #158, moves it.

## What Changes

**Vault entry in the daemon** (PR 1, dark)
- From: each session builds a backend per vault with its own chokidar watcher, reconcile loop and decoded snapshot.
- To: the daemon keeps a registry of **vault entries** keyed by the vault directory's realpath. Each entry holds the vault's scope, one watcher, one reconcile loop, and one **corpus** per attached profile. New methods `vault.attach { vault, profiles[] }` and `vault.status { vault, profile }`; no `vault.detach` (a closed connection detaches); an entry and each corpus idle out after `--idle-timeout`. New error codes `NOT_ATTACHED`, `VAULT_UNAVAILABLE`. `daemon status` lists vault entries and their profiles.
- Reason: one watcher and one reconcile loop per directory, whatever the number of sessions.
- Impact: non-breaking. No session attaches in PR 1.

**The corpus interface** (PR 1)
- From: reconcile writes shards through `CorpusStore`; a backend re-decodes the whole corpus after a pass.
- To: reconcile writes through the corpus's write operations (`entries`, `upsert`, `touch`, `delete`, `identity` / `reset`, `refresh`); `CorpusStore` becomes `ShardStore`, the durable layer of the first corpus implementation (shard files, format unchanged, plus decoded vectors updated per write).
- Impact: non-breaking; the shard format and `neuro-vault-mcp index` are unchanged.

**The watcher uses the vault scope** (#106, PR 1)
- From: the watcher ignores dot paths and `.tmp` names with its own predicate, and walks excluded subtrees.
- To: it prunes only provably excluded subtrees (dot segments and `/**` exclusions, through a new `scope.isSubtreeExcluded`) and forwards only `.md` events the scope keeps.
- Impact: non-breaking; fewer handles and no no-op passes for edits in excluded folders.

**Sessions read the corpus through the daemon** (PR 2)
- From: `SemanticBackend { snapshot(), status(), dispose() }`; tools rank over the whole decoded map.
- To: `SemanticBackend` is `{ nearest, nearestBlocks }` + async `status()` + `dispose()`, served by new methods `corpus.nearest` / `corpus.nearestBlocks` (batched anchors: a query vector or a note path) with `CORPUS_NOT_READY` / `CORPUS_FAILED`. `search_notes`, `get_similar_notes` and `find_duplicates` compose over it in the session; fusion, filters, `filterExisting` and the wikilink graph stay in the session. One `DaemonConnection` and one fallback switch per process; the in-process fallback (`--no-shared`, or a daemon that cannot be reached at startup) runs the same vault-entry module. Sessions attach every vault in the background at startup and drop their own watcher, reconcile loop and snapshot.
- Impact: non-breaking for tool contracts (inputs, outputs and error codes unchanged). One visible behaviour change: `get_similar_notes` resolves forward links through the vault-wide basename index, so a link to a note too short to carry a vector is now reported as `forward_link` instead of dropped.

## Capabilities

### New Capabilities

- `shared-vault-entry`: the daemon's vault entries — keying, `vault.attach` / `vault.status`, per-connection attach and idle, the one reconcile loop and one scope-driven watcher per vault directory, the corpus per profile, the new error codes, and the `daemon status` listing.
- `shared-corpus-reads`: `corpus.nearest` / `corpus.nearestBlocks` on the wire, the session-side `SemanticBackend` over them, the composition of the three semantic tools in the session, eager attach, and the in-process fallback over the same vault-entry module.

### Modified Capabilities

- `semantic-backend-lifecycle`: a backend exposes corpus reads instead of a snapshot; writes are visible per note instead of a promoted snapshot; the corpus is kept fresh by the vault entry's watcher, which follows the scope; a session's transport closing detaches instead of stopping a watcher; a pass that waited for another holder refreshes the corpus.
- `shared-services-daemon`: `daemon.info` and `daemon status` report vault entries; JSON-RPC errors may carry `data` beyond the code.
- `daemon-embedding-provider`: the fallback switch is one per process and shared by every daemon facade, not only embedding.
- `own-corpus-index`: one reconcile loop per vault directory walks every attached profile under one acquisition of the lock.
- `hybrid-search`: the semantic index state is read per call from the vault entry, and a status read that times out reports `unavailable` for that call.

## Impact

- **Code.** New: the vault-entry module and its corpus (shared by the daemon and the in-process fallback), the daemon's `vault` and `corpus` services, the session-side corpus facade. Changed: `src/lib/obsidian/corpus/` (`ShardStore`, reconcile over the corpus writes), `src/daemon/` (protocol error codes and `data`, per-connection context for handlers, `daemon.info`, `daemon status`), `src/modules/semantic/` (provider factory and one shared `DaemonConnection`, `executeRetrieval`, the three tools, `backend/`), `src/lib/vault-registry.ts`, `src/server.ts`, `eval/`.
- **Removed from the session** (PR 2): its watcher, reconcile loop, decoded snapshot and `SearchEngine` as a tool dependency.
- **Docs.** `docs/architecture/shared-daemon.md`, `own-corpus.md`, `semantic-backend.md`, `search-engine.md`, `vault-registry.md`, `vault-scope.md`, a new concept file for the vault entry, and a sweep of `docs/guide/`. ADR-0019 already records the corpus decision; whether ADR-0014's in-process watcher needs a superseding ADR is raised in design.
- **Delivery.** One change, two PRs: PR 1 (`Refs #175`) dark, PR 2 (`Closes #175`, `Closes #106`). Minor release; no tool contract change.
- **Not here.** `lexical.search` (#176), the lexical cache shrink (#171), the wikilink graph in the daemon (#172), the startup peak, a note-metadata index, watching scope files.
