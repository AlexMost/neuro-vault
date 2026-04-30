# Wikilink Graph

In-memory adjacency index over the vault's wikilinks (`[[X]]`) and embeds (`![[X]]`). One shared instance, built once at server level, consumed by both the operations and semantic modules.

## Why it exists

Three independent surfaces all need link knowledge that is otherwise expensive or absent:

- **`get_note_links`** (operations) — full incoming + outgoing adjacency for a single note.
- **`backlink_count` enrichment** on `search_notes` and `query_notes` results — lets the model rank by "how much the rest of the vault points at this".
- **`backlink_count` filter / sort** in `query_notes` — answers "notes with at least N backlinks" or "top-linked notes" without N+1 reads.

Without a shared index, each of these would scan the vault on every call. With it, scanning happens at most once per 3-minute window.

## Boundaries

The index is intentionally thin:

- **No watchers.** Smart Connections corpus stays the source of truth for embeddings; the wikilink graph follows the same "lazy + TTL" model used elsewhere.
- **No persistence.** Rebuilt from disk on first query and after the TTL expires.
- **Resolves edges through `BasenameIndex`** — uses the same wikilink resolver as `get_similar_notes` so behaviour stays consistent.
- **Embeds count as wikilinks.** `![[X]]` produces an outgoing edge to `X`, exactly like `[[X]]`.
- **Unresolved targets are retained.** Outgoing edges to non-existent notes are kept with `resolved: false` — useful for traversal tools and "concepts I have not yet written about".
- **Self-links are dropped.** A note linking to itself does not appear in its own `outgoing` or `incoming`.

## Surface

```ts
class WikilinkGraphIndex {
  ensureFresh(): Promise<void>;
  getNoteLinks(path: string): { incoming: IncomingLink[]; outgoing: OutgoingLink[] };
  getBacklinkCount(path: string): number;
}

interface OutgoingLink {
  target: string;
  resolved: boolean;
  path?: string;
}
interface IncomingLink {
  source: string;
}
```

`ensureFresh()` is the gate: every consumer awaits it before reading, and concurrent calls deduplicate to a single rebuild. After a successful build, queries within the TTL (3 minutes by default) return immediately.

`getNoteLinks` and `getBacklinkCount` return defensive copies / scalars — callers cannot mutate internal state.

## Build pipeline

`rebuild()` is straightforward:

1. `reader.scan()` produces the full path list.
2. `buildBasenameIndex(paths)` is computed once for the whole rebuild.
3. Notes are read in batches of 32 via `VaultReader.readNotes({ fields: ['frontmatter', 'content'] })`.
4. For each note, `parseWikilinks(content)` + `extractWikilinksFromFrontmatter(frontmatter)` produce raw targets; `normalizeWikilinkTarget` strips display text and section anchors; `basenameIndex.resolve` maps to a vault path or marks unresolved.
5. Outgoing edges are deduped (resolved by target path, unresolved by raw name); the corresponding incoming edge is appended to the resolved target.
6. Notes that fail to read (`READ_FAILED`) are logged to stderr and skipped — one bad note does not abort the build.

## Wiring

The graph is built once at server startup (`src/server.ts`) using the shared `FsVaultReader`, then passed into both `createSemanticModule` and `createOperationsModule` as a dependency. Each module's tool factory accepts an optional `graph` so that tests can substitute a fake without booting the server.

When a module is constructed in isolation (direct unit tests, hypothetical embed-elsewhere usage), it builds its own graph from a default `FsVaultReader` — the server-level shared instance is an optimisation, not a requirement.

## TTL choice

Three minutes balances two pressures: a single rebuild on a real-world vault is fast (low tens of milliseconds for a few thousand notes), but doing it on every tool call is wasteful in tight conversational loops. Three minutes is short enough that link-related staleness is rarely visible to a human-paced session, and long enough that a burst of related queries pays the rebuild cost only once.

There is no manual invalidation API — agents that just wrote a note do not need to wait, because the next `ensureFresh` after the TTL window will pick it up. If a future use case demands immediacy, an `invalidate()` method can be added without changing the public surface.
