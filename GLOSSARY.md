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

**Semantic floor**:
The lowest query↔note similarity at which a note counts as a semantic hit, set per model profile and effort. The deep block-evidence floor is separate, and so is the expansion floor.
_Avoid_: threshold (that is the caller's override), cut-off

**Lexical leg**:
One ranked list of notes for a search, produced by exact matching at word starts over note titles, headings and body.
_Avoid_: keyword search, full-text search

**Fusion**:
Merging the semantic and lexical legs into the single ranked list a search returns.
_Avoid_: merge, hybrid ranking

### Note structure

**Block**:
A piece of a note the corpus embeds on its own: the frontmatter, the preamble before the first heading, a heading block, or one paragraph of a heading's own text.
_Avoid_: chunk, unit, segment

**Heading block**:
A heading together with everything under it, sub-headings included, up to the next heading of the same or higher level.
_Avoid_: section, heading section, `^block` (that is an Obsidian block reference, a different thing)

**Heading name**:
A heading's text as written, with a `[n]` suffix when an earlier sibling under the same parent has the same text — what names a heading block.
_Avoid_: heading key, anchor, slug

**Own text**:
The lines under a heading before its first sub-heading — all of the heading block when it has no sub-headings, nothing when a sub-heading follows directly.
_Avoid_: intro, direct content, heading body

**Selection**:
The part of a note one read asks for — the whole body, or a single heading block or line range named in the request; how much of it comes back is decided separately.
_Avoid_: piece, fragment, slice, section

### Retrieval eval

**Golden set**:
The owner-labelled list of queries with the notes that answer them, kept in the vault; eval scores retrieval against it.
_Avoid_: test set, benchmark

**Query class**:
What kind of lookup an entry is: concept, name, single token, or control.
_Avoid_: query type, category

**Control query**:
A golden entry the vault has no answer for; anything returned for it is noise.
_Avoid_: negative query, empty query

**Positional run**:
An eval run with every floor at 0, measuring only where relevant notes rank.
_Avoid_: raw run

**Production run**:
An eval run with the profile's default floors and caps, measuring the list an agent actually receives.
_Avoid_: live run, real run

### Shared daemon

**Vault entry**:
The shared state of one vault directory: its scope, its watcher and reconcile loop, its corpora and its lexical cache. There is one per vault directory, and every session attached to that directory shares it.
_Avoid_: vault registry entry, shared vault

**Attach**:
A session becoming a client of a vault entry. The entry lives while any session is attached, and for the idle timeout after the last one leaves.
_Avoid_: register, subscribe

**Vault client**:
A session's path to a vault entry, per vault directory and side: over the daemon connection, or in-process when the session runs the vault entry itself. It attaches, and every read of the entry goes through it; the semantic backend and the lexical reader are views over it.
_Avoid_: facade, backend (the backend is one view), connection
