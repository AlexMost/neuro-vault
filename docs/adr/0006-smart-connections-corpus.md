# ADR-0006 — Smart Connections as the read-only embedding corpus

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

Semantic search needs embeddings for every note and block in a vault. Generating them ourselves means an embedding model, an indexing pass, API keys or a background process, and staleness management — a lot of moving parts for a tool meant to drop into an existing Obsidian setup. Many target users already run the **Smart Connections** plugin, which maintains exactly this index on disk under `<vault>/.smart-env/multi/*.ajson`.

## Decision

Consume the Smart Connections embedding index directly, **read-only**. `src/smart-connections-loader.ts` parses the plugin-internal AJSON files at startup into an in-memory `Map<path, SmartSource>` (note + block vectors); the map is never mutated, and the server never writes embeddings back. Query-time embedding (for the search query itself) is the only generation the server does. The corpus is wrapped in `SmartConnectionsCorpusIndex`, which reloads when the `.ajson` files' `(max mtime, file count)` changes.

## Consequences

- Zero indexing cost, no API keys, no background process — embeddings come "for free" from the user's existing plugin.
- The server is coupled to a plugin-internal format (concatenated `"key": {…}` entries, last-write-wins, `null` tombstones); a future Smart Connections format change can break the parser. The loader owns this risk and fails loudly (mixed embedding dimensions throw at load).
- Semantic search is unavailable when Smart Connections is not set up; that surfaces per-call (`SEMANTIC_INDEX_NOT_FOUND` / `semanticAvailable: false`), not as a startup crash.
- Note bodies are read on demand from disk — the corpus holds embeddings only.

## Alternatives considered

- **Generate our own embeddings** — full control and no plugin coupling, but reintroduces all the cost (model, index, keys, staleness) this decision avoids; rejected for the drop-in use case.
- **Ask Smart Connections to re-export a clean format** — slower and out of our control; parsing the AJSON directly is faster.
