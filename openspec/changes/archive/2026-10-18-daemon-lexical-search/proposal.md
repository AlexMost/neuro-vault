Tracked by: #176

## Why

After `daemon-vault-registry` (#175) a session the daemon serves holds no corpus, watcher or reconcile loop, yet it still parses every note of every vault into its own lexical cache for `search_notes`' lexical leg, and so do all N sessions on one vault. Measured on #158, a session settles at ~97 MB against the ~62 MB `--no-semantic` floor, and the lexical cache (~47 MB of heap for 1,000 synthetic notes after #177, ~19 MB for a 387-file vault) is the named remaining candidate, as well as the suspected cause of the ~430 MB startup peak the previous change did not move. ADR-0020 already reserves the place for it: the lexical cache is the next member of the vault entry, reached through the same attach. This change, the second and last of epic #158, moves it.

## What Changes

**The lexical cache and its tie-break graph become members of the vault entry**
- From: each session keeps one `LexicalIndex` per vault inside `buildSearchNotesTool`, refreshed per call over the session's reader and evicting every path outside a filtered call's `allowed` set; the tie-break reads the session's wikilink graph.
- To: each vault entry holds one lexical cache over its own scoped reader and one wikilink graph (TTL, used only by lexical ranking), created with the entry, warmed in the background on creation and after a scope change, and dropped with the entry. Freshness stays read-through: refreshes of one cache are serialised and a call is never served by a refresh that began before it arrived; `allowed` narrows ranking and never evicts; `total_notes` counts the entry's scope before `allowed`.
- Reason: one copy per vault directory instead of one per session; ranking unchanged.
- Impact: non-breaking. A vault with `"semantic": false` now attaches (with `profiles: []`) so its lexical leg is served too; its entry runs no watcher and no corpus.

**`lexical.search` on the wire**
- From: no lexical method; `lexical.*` is named in the daemon's docs as the next service.
- To: `lexical.search { vault, queries, allowed?, note_cap, per_note_cap }` answers today's ranked evidence with snippets built in the daemon (`notes[]` with `matches[]` and `matched_queries`, `truncated`, `per_query_counts`, `per_query_token_counts`, `total_notes`), the session waiting at most 30 s; `NOT_ATTACHED` for a vault this connection did not attach; new error code `LEXICAL_FAILED` when the implementation throws. No readiness state: a cold cache waits for its warm. `daemon.info` reports the cache per entry and `daemon status` prints a `lexical` line under each vault.
- Impact: non-breaking (a new method and code; no existing method changes).

**The session reads the lexical leg through a facade**
- From: `RetrievalPipelineDeps.lexical` is a `LexicalIndex` plus `getBacklinkCount`; the tool owns the per-vault index map.
- To: `IRegisteredVault.lexical: ILexicalReader` (symmetric with `backend`), built per vault by the registry's `lexicalReaderFactory`, with three implementations behind one factory: the daemon facade (over the process's `ISharedServices` and a per-vault attachment shared with the semantic backend), the in-process entry (`--no-shared`, or once the switch went `local`), and a standalone reader over today's `LexicalIndex` with the session's graph (`--no-semantic`, `npm run eval`). `getBacklinkCount` leaves the pipeline's dependencies. A lexical failure is `DEPENDENCY_ERROR`; a timeout or a dropped connection fails the call and never flips the fallback switch.
- Impact: non-breaking for the tool contract (`search_notes` input, output and ranking unchanged). One visible change: a lexical failure that used to surface as `INTERNAL_ERROR` is reported as `DEPENDENCY_ERROR`.

**Every registered vault attaches at startup**
- From: the session attaches only semantically enabled vaults; a `"semantic": false` vault's backend never attaches.
- To: the attach moves out of the semantic backend into one per-vault attachment used by both facades; a semantically enabled vault attaches with its profile, an opted-out one with `profiles: []`. `--no-semantic` sessions attach nothing and start no daemon (owner's decision, 2026-10-18).
- Impact: the daemon now starts for a shared session whose vaults all set `"semantic": false`; README and the guides say so. `--no-semantic` and `--no-shared` keep today's behaviour.

## Capabilities

### New Capabilities

- `shared-lexical-search`: the vault entry's lexical cache and graph (members, warm, serialised read-through refresh, `allowed` never evicts, scope folding, `total_notes`), `lexical.search` on the wire with `NOT_ATTACHED` / `LEXICAL_FAILED`, and the session-side `ILexicalReader` with its three implementations and error mapping.

### Modified Capabilities

- `shared-vault-entry`: an entry also holds one lexical cache and one wikilink graph; an attach with `profiles: []` warms the lexical cache and starts no watcher; the entry's watcher runs only while it has an enabled profile; `NOT_ATTACHED` has an entry-level meaning for `lexical.search`.
- `shared-corpus-reads`: at startup a session attaches every registered vault, with its profile or with `profiles: []`, through one attachment per vault shared by the semantic backend and the lexical reader.
- `shared-services-daemon`: the unknown-method scenario no longer uses `lexical.search`; `daemon.info` and `daemon status` report the lexical cache per vault entry; `LEXICAL_FAILED` joins the error table.
- `hybrid-search`: lexical freshness is a per-vault-entry read-through cache shared by every session on the vault, with the serialised-refresh and never-evict rules; a lexical failure is `DEPENDENCY_ERROR`.
- `semantic-backend-lifecycle`: a vault that turned semantics off still attaches for its lexical leg, unwatched and unindexed.
- `daemon-embedding-provider`: the process's one-way switch is also shared by the lexical reader, so a daemon that cannot be located or started moves the lexical reads in-process too.

## Impact

- **Code.** New: the entry's lexical member and graph in `src/lib/vault-entry/`, `src/daemon/services/lexical.ts`, `src/modules/semantic/lexical/` (the `ILexicalReader` interface, the daemon, in-process and standalone readers, the per-vault attachment). Changed: `src/lib/vault-entry/{vault-entry,vault-entries}.ts` (members, `lexical()`, lazy watcher, `IVaultInfo.lexical`), `src/daemon/protocol.ts` (`LEXICAL_FAILED`, the method's types), `src/daemon/admin.ts` (the status line), `src/cli-daemon.ts` (register the service), `src/modules/semantic/backend/` (the attachment shared with the semantic backend; `createSemanticBackends` becomes the process's vault clients), `src/modules/semantic/{retrieval-pipeline,tools/search-notes}.ts` (reader instead of index + `getBacklinkCount`), `src/lib/vault-registry.ts` and `src/server.ts` (the factory and the startup attach of every vault), `eval/pipelines.ts` (the standalone reader).
- **Removed from the session**: the per-vault `LexicalIndex` map in the tool and, for a daemon-served session, every lexical parse.
- **Docs.** `docs/architecture/lexical-search.md`, `vault-entry.md`, `shared-daemon.md`, `semantic-backend.md`, `vault-registry.md`, `module-structure.md`, `mcp-server-shape.md`, `retrieval-policy.md`, `docs/architecture/README.md`, `docs/guide/installation.md`, `configuration.md`, `README.md`. No new ADR (ADR-0020 already places the cache in the entry and adds no invariant here) and no new glossary term.
- **Delivery.** One PR to `main`, `Refs #158`, `Closes #176`; minor release; no tool contract change. The by-hand footprint measurement is posted on #158 next to the change 1 numbers and closes the effort's percentage.
- **Not here.** The wikilink graph for every other tool (#172), watcher-driven invalidation or an FTS-backed lexical implementation, the startup peak beyond what this move changes, the daemon's bimodal settled footprint.
