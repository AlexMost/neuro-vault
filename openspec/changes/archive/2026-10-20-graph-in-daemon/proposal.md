Tracked by: #172

## Why

Each vault has two wikilink graphs: the session builds one for every link question a tool asks, and the vault entry builds another for the lexical leg's backlink tie-break. They read different scopes — a session reads its scope once at startup, the entry re-reads it on every attach — so after a scope change `search_notes` ranks with one note set and stamps `backlink_count` from another. ADR-0020 named the graph as the last per-vault state still duplicated per session, and the hub work (#128 cross-vault resolution, #130 neighbourhood, #129 resolution scope) needs one graph per vault that answers every link question in one place.

## What Changes

**One graph per vault directory, in the vault entry**
- From: a session-built `WikilinkGraphIndex` per registered vault, plus a private one in the vault entry used only by the lexical tie-break.
- To: the vault entry's one graph, shared by every attached session and by the tie-break, read through three batched daemon methods — `graph.noteLinks`, `graph.backlinkCounts`, `graph.resolve` — on the session's existing vault client. A failing read is `GRAPH_FAILED`.
- Reason: one graph, one scope, one place that answers link questions.
- Impact: non-breaking. No tool's input or output changes for the same vault state. After a scope change, link answers follow the vault's current scope, as the lexical leg already does.

**The session reads the graph, it does not hold it**
- From: `IRegisteredVault.graph` is a synchronous `IVaultGraph`, refreshed by `ensureFresh()` in each consumer.
- To: `IRegisteredVault.graph` is an async `IGraphReader` (a view over the vault client); each tool makes at most one graph call per scan, never one per note. Freshness stays the 3-minute TTL, owned by the entry.
- Impact: non-breaking. Under `--no-semantic`, where nothing attaches, the session hosts the same graph behind the same adapter, as today.

**`listMatchingPaths` stops taking a graph** — its filters cannot read `backlink_count`; output is unchanged.

Delivered in two PRs: the dark foundation (the entry's graph as a reader, the `graph` service, the session view, their tests and docs) with `Refs #172`; then the consumer cut-over and the removal of the session-built graph, with `Closes #172`.

## Capabilities

### New Capabilities

- `shared-wikilink-graph`: the vault entry's one wikilink graph per vault directory; the `graph.*` methods, their params, answers and error codes; the session's graph reader (daemon, in-process entry, or the session's own graph under `--no-semantic`) and its batched reads; the graph's freshness; one graph call per scan for every consumer.

### Modified Capabilities

- `shared-lexical-search`: the entry's graph is no longer used only by the tie-break, and a session no longer builds its own graph for `backlink_count`.
- `shared-vault-entry`: the entry holds one wikilink graph beside its lexical cache, and the methods that carry the realpath key include `graph.*`.
- `shared-services-daemon`: the unknown-method scenario names a namespace the daemon does not serve (it now serves `graph`).

## Impact

- **Code.** New: `src/lib/obsidian/graph-reader.ts` (`IGraphReader`, `createGraphReader`, `GraphReadError`), `src/daemon/services/graph.ts`, `src/modules/semantic/graph/view.ts`. Changed: `src/daemon/protocol.ts` (three rows, schemas, `GRAPH_FAILED`), `src/daemon/services/vault-entry-services.ts`, `src/lib/vault-entry/vault-entry.ts` and `vault-entries.ts` (PR 1); `src/lib/vault-registry.ts`, `src/modules/semantic/vault-client/index.ts`, `src/modules/semantic/index.ts`, every graph consumer under `src/lib/obsidian/` and `src/modules/*/tools/`, `test/_vault-graph.ts` (PR 2).
- **Interfaces.** `IRegisteredVault.graph` changes type (PR 2); `IVaultGraph` stays the in-memory graph's interface. `ISemanticBackend`, `ILexicalReader`, `ICorpusReader` unchanged.
- **Docs.** `docs/architecture/wikilink-graph.md`, `vault-entry.md`, `shared-daemon.md`, `vault-registry.md`, `module-structure.md`, `lexical-search.md`, and the `docs/guide/` mentions. No new ADR: ADR-0020 decided the move.
- **Not here.** #128, #129, #130; watcher-driven or incremental graph freshness; moving the note-metadata layer.
