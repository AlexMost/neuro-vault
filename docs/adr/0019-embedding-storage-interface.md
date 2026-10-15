# ADR-0019 — The corpus is an interface inside the daemon; sessions receive semantic legs, never vectors

- **Status**: Accepted
- **Date**: 2026-10-15

## Context

Epic #158 moves per-vault state (watcher, reconcile loop, decoded embedding snapshot, lexical cache) out of every stdio session into the shared-services daemon of [ADR-0018](0018-shared-services-daemon.md). The decoded snapshot is about 300 MB per session on a real vault, and every session holds its own copy.

Today the seam between the corpus and the tools is `SemanticBackend.snapshot()`. It hands every tool the whole decoded `Map<path, SmartSource>` (note and block vectors) plus a `basenameIndex` built from the corpus's own paths. Each tool ranks by iterating that map through `SearchEngine` (brute-force cosine): `executeRetrieval` for `search_notes`, a note's own vector for `get_similar_notes`, all pairs for `find_duplicates`. Reconcile writes through `CorpusStore` (one JSON shard per note, [ADR-0013](0013-own-embedding-corpus.md)). It lists every shard, parsed, only to compare `content_hash`, `mtime` and `size`, and the backend re-decodes the whole corpus after any pass that changed something.

That seam cannot move into the daemon as it stands. Either the vectors would cross the socket on every call, or each session would keep a copy, and that copy is the cost being removed. The standing constraint from ADR-0017 and ADR-0018 also applies: production may run on Linux with a remote embedding API and a third-party vector store, and those must fit behind the same interfaces without a session change.

## Decision

Introduce the **corpus** as an interface that reconcile writes to and semantic retrieval reads from. It lives inside the daemon, or inside the in-process fallback, and no session sees it.

- **Two seams.** (1) Session ↔ `SemanticBackend`: the session-side facade returns a **semantic leg** (seeds, blocks, expansion, scores) and `status()`. `snapshot()` leaves it. Its implementations are the daemon's `corpus.*` service and the in-process fallback; the wire shape is #164's. (2) Semantic-leg composition and reconcile ↔ **corpus**: this ADR. `executeRetrieval` runs beside the corpus, in the daemon or in-process, as a composition of corpus reads. Fusion, `filterExisting`, backlink counts and the wikilink graph stay in the session, as the map decided.
- **One corpus per (vault realpath, profile).** The daemon's vault entry for that realpath owns the corpus, the scope and the reconcile loop.
- **Vectors in, paths and scores out.** The corpus never embeds text. The `EmbeddingProvider` of [ADR-0017](0017-embedding-model-profiles.md) embeds, and its `identity` is what the corpus records. A store's built-in vectorizer is not used.
- **Read primitives.**
  - `nearest(vector, { threshold, limit?, allowed?, exclude? })` → `{path, similarity}[]`. Serves per-query seeds, the fallback threshold, and expansion (`exclude` = the seeds).
  - `nearestBlocks(vector, { paths, threshold, limit? })` → `{path, heading, lines, similarity}[]`. Serves blocks within seeds and the per-seed backfill (`paths = [seed]`, `limit = 1`, `threshold = 0`).
  - `vectorOf(path)` → vector or `null`. Serves similar-to-note and expansion. The vector stays on the corpus's side of the socket.
  - `find_duplicates` is a **composition**, not a primitive: for each member, `nearest(vectorOf(member), threshold)`, with symmetric pairs folded. No third-party store answers all-pairs natively; every store answers nearest-neighbour queries.
- **Write operations**, all reconcile needs:
  - `entries()` → `path → {content_hash, mtime, size}`, with no vectors.
  - `upsert(record)`: metadata, the note vector (or `null` below `MIN_CHARS`) and the block vectors.
  - `touch(path, {mtime, size})`: the hash matched, so only stat changes.
  - `delete(path)`.
  - `identity()` and `reset(identity)`: the stored corpus identity, and clear-and-record-a-new-one, which is how a rebuild happens.
  - `refresh()`: re-read the durable form after someone else wrote it (an in-process `index` run under the reconcile lock). It is a no-op where nothing but the corpus writes its storage.

  There is no rename operation. A vector depends on the path (ADR-0013), so reconcile recognises a rename by content hash and then upserts the new path and deletes the old one.
- **Change-detection metadata lives in the corpus**, beside the vectors, as payload. A separate ledger would be a second source of truth that can disagree after a crash between two writes.
- **Writes are visible per note.** Each `upsert` or `delete` is readable as soon as it completes, with no pass-level atomic promotion. The cold build is covered by status: while the vault entry is `indexing` with nothing ever loaded, the leg is not served. An identity change empties the corpus before the first write under the new identity, so dimensions never mix.
- **First implementation: shard files plus decoded `Float32Array`s in memory.** The durable form stays the per-profile shard directory of ADR-0013 and ADR-0017, unchanged, because `neuro-vault-mcp index` keeps writing it in-process and a warm daemon start reads it. The in-memory side updates per write instead of re-decoding the corpus after a pass. Today's `CorpusStore` becomes `ShardStore`, the durable layer of this implementation only. `SearchEngine`'s brute-force functions become this implementation's internals and leave the tools' dependencies.
- **Lifecycle state belongs to the vault entry, not the corpus.** The owner of the reconcile loop reports `indexing | ready | unavailable | disabled` as `BackendStatus` does today. Pass counters come from the pass, `disabled` from config, and `unavailable` from a failed pass or a corpus that throws (an unreachable remote store). The corpus reports only `identity()`, for the compatibility check. The session receives the same `BackendStatus`. It needs no identity, since it already knows the profile it asked for.
- **The corpus does not know the scope.** On every read, the vault entry folds the scope's exclusions into `allowed`/`exclude`, before any limit applies, so a scope change can never starve a result. Reconcile keeps sweeping excluded notes as orphans. A path-list filter fits a third-party store; a predicate would not.

## Consequences

- **Vectors leave the session.** Its semantic memory becomes the facade and whatever one leg result holds. The leg's composition is written once and runs on the corpus's side in both the daemon and the in-process fallback.
- **A remote provider plus a third-party store is two implementations, not a session change**: an `EmbeddingProvider` that reports its own identity, and a corpus over the store, with hash, mtime and size as point payload.
- **`find_duplicates` does about twice the cosine work** of today's triangular loop in the in-memory implementation (N nearest queries instead of N(N−1)/2 pairs). It is a rarely used corpus-hygiene tool.
- **Readers can see a pass half-applied**: some notes already re-embedded, others not yet. Each note is coherent on its own, and the identity never mixes.
- **`get_similar_notes` resolves forward links through the session's vault-wide basename index**, the one `get_note_links` and the wikilink graph use, not through corpus paths. A link to a note too short to carry a vector now reports `forward_link`. Before, it was dropped, a side effect of building the index from the corpus.
- **`npm run eval` runs in-process over the shard-backed corpus** and the same leg composition. It measures ranking, not transport, so it never goes through the daemon.
- **Reconcile reads metadata without vectors.** `entries()` replaces the full parsed listing it compares against today.

## Alternatives considered

- **Keep `snapshot()` plus `SearchEngine` as the seam, moved into the daemon**: vectors cross the socket on every call, or each session keeps a copy, which is the cost being removed.
- **The corpus embeds text itself**: the store, not the provider, would define the corpus identity, and the query prefix of ADR-0017 would move out of the provider.
- **Change-detection metadata in a local ledger beside a remote store**: two sources of truth, and reconcile tied to the local disk even when vectors are remote.
- **Pass-level atomic promotion** (today's single-assignment snapshot swap): a third-party store would need a transaction or a collection swap per pass. Per-note visibility plus the `indexing` gate covers the cold build.
- **`pairsAbove(threshold)` as a fourth primitive**: faster in memory, but every other implementation would have to emulate it with nearest queries anyway.
- **The corpus holds a scope predicate, replaced on re-attach**: a predicate does not translate to a remote store's filter; a path list does.
- **A new durable format now** (one file, or SQLite once the Node floor allows `node:sqlite`): an independent decision. The shard format keeps `index` and the daemon sharing one durable form with no migration.
