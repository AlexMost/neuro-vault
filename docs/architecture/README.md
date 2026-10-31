# Architecture

One file per architectural concept. Each file describes the **current** state of the codebase: what the concept is, why it exists, how it interacts with the rest of the system, and what it deliberately does not do.

These are living documents. Update the relevant file in the same change that alters the concept it describes.

## Concepts

- [cli-startup.md](./cli-startup.md) — the command-line entry point: informational flags (`--version`, `--help`), why parsing never exits the process itself, and the single `package.json` read behind the version string and the MCP server identity
- [mcp-server-shape.md](./mcp-server-shape.md) — how MCP tools are registered, response/error wrappers, resource URIs, and where the `instructions` constant lives
- [vault-conventions.md](./vault-conventions.md) — how `.neuro-vault/for-external-agents.md` reaches an agent: the `conventions` field on `get_vault_overview`, the 8,000-character cap and its truncation flag, and the pointer that is all `instructions` carries
- [tool-response-envelope.md](./tool-response-envelope.md) — the `toToolResponse`/`toToolErrorResponse` choke point: minified success text, `CODE: message` error text, client-behavior rationale
- [mcp-parameter-dictionary.md](./mcp-parameter-dictionary.md) — the cross-tool parameter naming contract (one concept = one name)
- [own-corpus.md](./own-corpus.md) — the embedding corpus the server builds and owns: block keys and embed-text formulas, the shard/manifest layout under `<vault>/.neuro-vault/corpus/`, atomic writes, the corpus interface (`ICorpus` with its lifecycle; `ShardStore`, `ShardCorpus`, `shardWriter` behind it) and its brute-force cosine ranking, and the hash-truthful reconcile split around the lock
- [vault-entry.md](./vault-entry.md) — the shared state of one vault directory, in the daemon or a session's in-process fallback: scope, the lexical cache, the vault's one wikilink graph, watcher (only while a corpus is attached), one reconcile loop over many model profiles with its startup selection and retries, a corpus per profile; attach without detach, idle per entry and per corpus, the scope-following watcher, the excluded-path fold on reads, and how it differs from the session's `IRegisteredVault`
- [semantic-backend.md](./semantic-backend.md) — the session's `ISemanticBackend` seam: the four states, the backend as a view over the vault client, the client's daemon adapter and its in-process loopback over the daemon's own handlers, the vault attachment shared with the lexical reader, the background attach at startup, how tools read and map the status, the embed queue, and teardown
- [retrieval-policy.md](./retrieval-policy.md) — the semantic leg composed over the corpus reads: search modes, default-only threshold fallback, expansion with its own `expansion_floor` scale, the per-leg outcome records `runRetrievalPipeline` returns and `deriveObservability` reads
- [note-structure.md](./note-structure.md) — how `read_notes` sees a note's structure: the read-time projection over the chunker's heading blocks, heading names and their `[n]` suffix, file-relative line coordinates shared with search, the body span `lines` echoes, the outline and its collapse by nesting depth, and the leading-BOM limitation
- [lexical-search.md](./lexical-search.md) — `search_notes`'s lexical leg: mdast block extraction, normalization, tiered ranking, the mtime cache as a vault-entry member (serialised refresh, never evicts), and the `ILexicalReader` a session reads it through
- [rank-fusion.md](./rank-fusion.md) — `search_notes`'s merge layer: RRF over semantic/lexical/expansion, adaptive k, tie-breaks, truncated observability from the per-leg outcome records
- [embedding-pipeline.md](./embedding-pipeline.md) — the local embedding provider: the closed registry of model profiles (`harrier-270m` default), `@huggingface/transformers` loading and cache, provider-owned tokenisation, mask-aware pooling, length-bucketed batching, lazy initialization
- [shared-daemon.md](./shared-daemon.md) — the shared-services daemon: one process per installed build over a unix socket, the build-hashed key and its files under `/tmp` and the cache dir, lock and stale-socket probe, idle exit from the last client, the namespaced JSON-RPC protocol, the `embed`, `vault`, `corpus`, `lexical` and `graph` services, the per-connection context, the process's one connection and fallback switch shared by the embedding provider and the vault clients, how a new service attaches, and how a new per-vault read is added
- [module-structure.md](./module-structure.md) — how `src/modules/{semantic,operations}/` plug into the server
- [vault-provider.md](./vault-provider.md) — the operations-module write abstraction, implemented by `FsVaultProvider` directly against the vault directory
- [vault-reader.md](./vault-reader.md) — the `FsVaultReader` abstraction for direct disk reads
- [vault-scope.md](./vault-scope.md) — the per-vault definition of which files are discoverable: dot-path/`Templates`/`.gitignore`/config exclusion layers, the `ignorePatterns` prune vs `isExcluded` predicate, `isSubtreeExcluded` for the watcher, and every surface it governs
- [disk-write-path.md](./disk-write-path.md) — how `create_note` writes and why `read_daily`'s Daily Notes preflight still exists, now that both are disk-direct
- [wikilink-graph.md](./wikilink-graph.md) — in-memory adjacency over `[[wikilinks]]` and `![[embeds]]`, shared across modules
- [query.md](./query.md) — the `query_notes` pipeline: tag normalisation, MongoDB-query (sift) filtering, sort/limit
- [input-coercion.md](./input-coercion.md) — how realistic stringification of MCP arguments is reshaped at the boundary, and the meaningful-error contract on coerce failure

## Reading order

If you are new to the codebase, read in this order: `mcp-server-shape` → `own-corpus` → `embedding-pipeline` → `semantic-backend` → `retrieval-policy` → `rank-fusion`. The first four describe the building blocks; the last two describe how they are composed — `retrieval-policy` into the semantic leg, `rank-fusion` into the unified `matches[]` list `search_notes` returns. Read `vault-scope` alongside `vault-reader` — it governs *which* files every scan-derived surface sees, before any of the above ever runs.
