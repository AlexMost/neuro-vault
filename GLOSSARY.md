# neuro-vault

An MCP server that gives an AI assistant semantic search over its own embedding corpus and direct operations on an Obsidian vault.

## Language

### Retrieval

**Corpus**:
The note and block vectors of one vault under one embedding profile, with the per-note metadata that tells whether a vector is still current. Reconcile writes it; semantic retrieval reads it.
_Avoid_: embedding storage, vector store, snapshot, index

**Corpus identity**:
What produced a corpus's vectors: the embedding profile's producing fields plus the text-extraction version and strategy. A corpus is served only while its identity matches the active one.
_Avoid_: manifest (that is where it is recorded), model version

**Semantic leg**:
One ranked list of notes for a search, produced from the corpus by vector similarity, with matching blocks and expansion neighbours per note.
_Avoid_: semantic results, vector search

**Lexical leg**:
One ranked list of notes for a search, produced by exact and substring matching over note titles, headings and body.
_Avoid_: keyword search, full-text search

**Fusion**:
Merging the semantic and lexical legs into the single ranked list a search returns.
_Avoid_: merge, hybrid ranking

### Shared daemon

**Vault entry**:
The shared state of one vault directory: its scope, its watcher and reconcile loop, its corpora and its lexical cache. There is one per vault directory, and every session attached to that directory shares it.
_Avoid_: vault registry entry, shared vault

**Attach**:
A session becoming a client of a vault entry. The entry lives while any session is attached, and for the idle timeout after the last one leaves.
_Avoid_: register, subscribe
