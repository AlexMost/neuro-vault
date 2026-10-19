# Wikilink Graph

In-memory adjacency index over the vault's wikilinks (`[[X]]`) and embeds (`![[X]]`), behind one interface, `IVaultGraph`: the one place link questions are answered — a note's links, its backlink count, where a wikilink target resolves. The [vault entry](./vault-entry.md) holds the vault directory's one graph, which tie-breaks the lexical leg and answers the daemon's batched `graph.*` reads (`IGraphReader`, see [Surface](#surface)). Until the cut-over of [#172](https://github.com/AlexMost/neuro-vault/issues/172) lands, each session also builds its own, through the [registry](./vault-registry.md), and its tools read that one (see [Wiring](#wiring)).

## Why it exists

Four independent surfaces all need link knowledge that is otherwise expensive or absent:

- **`get_note_links`** (operations) — full incoming + outgoing adjacency for a single note.
- **`backlink_count` enrichment** on `search_notes` and `query_notes` results — lets the model rank by "how much the rest of the vault points at this".
- **`backlink_count` filter / sort** in `query_notes` — answers "notes with at least N backlinks" or "top-linked notes" without N+1 reads.
- **`forward_link` candidates** of `get_similar_notes` — where each `[[wikilink]]` in the query note resolves (`resolve`).

Without a shared index, each of these would scan the vault on every call. With it, scanning happens at most once per 3-minute window. Like every scan-derived surface, the graph only sees notes visible under the vault's scope (see [`vault-scope.md`](./vault-scope.md)) — an excluded note contributes no edges, and a link to one resolves as `unresolved`, the same as a link to any other non-existent note.

## Boundaries

The index is intentionally thin:

- **No watcher of its own.** Unlike the embedding corpus, which is watched (see [`semantic-backend.md`](./semantic-backend.md)), the wikilink graph follows a lazy + TTL model: rebuilt on demand, not kept warm in the background.
- **No persistence.** Rebuilt from disk on first query and after the TTL expires.
- **Resolves edges through `BasenameIndex`**, and keeps that index for `resolve`, so an edge and a `get_similar_notes` forward link always agree on where a link points: exact path → unique suffix (`[[Teams/_index]]` written under `GrowPM/`) → basename. Resolution order and the ambiguity rule: [`note-path-resolution.md`](./note-path-resolution.md#wikilink-targets-basenameindex).
- **Embeds count as wikilinks.** `![[X]]` produces an outgoing edge to `X`, exactly like `[[X]]`.
- **Unresolved targets are retained.** Outgoing edges to non-existent notes are kept with `resolved: false` — useful for traversal tools and "concepts I have not yet written about".
- **Self-links are dropped.** A note linking to itself does not appear in its own `outgoing` or `incoming`.

## Surface

```ts
interface IVaultGraph {
  ensureFresh(): Promise<void>;
  getNoteLinks(path: string): { incoming: IncomingLink[]; outgoing: OutgoingLink[] };
  getBacklinkCount(path: string): number;
  resolve(target: string): string | null; // a normalized wikilink target → vault path
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

`getNoteLinks` and `getBacklinkCount` return defensive copies / scalars — callers cannot mutate internal state. `resolve` answers from the same build as the edges; before the first build it resolves nothing.

`WikilinkGraphIndex` (`src/lib/obsidian/wikilink-graph.ts`) is the one implementation. Consumers and the registry depend on `IVaultGraph`, so a test passes an in-memory double (`test/_vault-graph.ts`) or a real `WikilinkGraphIndex` over a stub reader — no casts.

### Reading a graph from elsewhere: `IGraphReader`

A graph that lives in the vault entry is a call away, so it is read through an async, batched interface (`src/lib/obsidian/graph-reader.ts`):

```ts
interface IGraphReader {
  noteLinks(path: string): Promise<NoteLinks>;
  backlinkCounts(paths: readonly string[]): Promise<number[]>; // in order; 0 for a note the graph lacks
  resolve(targets: readonly string[]): Promise<(string | null)[]>; // in order
}
```

Each read answers every path or target from one build, and the caller never refreshes: freshness is the host's. One call per question a tool asks, never one per note — the largest is a `backlinkCounts` over a scan's paths, the size of `lexical.search`'s `allowed`. `createGraphReader(current)` adapts an in-memory graph: each call reads `current()` once and awaits its `ensureFresh()`, so a graph swapped in by a scope change answers the next call. It wraps no errors.

| Read | Wire method | Answer |
| --- | --- | --- |
| `noteLinks(path)` | `graph.noteLinks { vault, path }` | `{ incoming: [{ source }], outgoing: [{ target, resolved, path? }] }` |
| `backlinkCounts(paths)` | `graph.backlinkCounts { vault, paths }` | `{ counts }`, one per path |
| `resolve(targets)` | `graph.resolve { vault, targets }` | `{ paths }`, one vault path or `null` per target |

The daemon side is the `graph` service ([`shared-daemon.md`](./shared-daemon.md#the-graph-service)); the session side is `createGraphReaderView(client)` (`src/modules/semantic/graph/view.ts`), a view over the vault's one client that maps every failure — `GRAPH_FAILED`, `NOT_ATTACHED`, a timeout, a dropped connection, an answer of the wrong shape — to a `GraphReadError` for that call. Composition stays in the session: top-by-backlinks, `query_notes`' filters and sorts, and parsing a note's current text for its forward links.

## Build pipeline

`rebuild()` is straightforward:

1. `reader.scan()` produces the vault-scope-filtered path list (see [`vault-scope.md`](./vault-scope.md)).
2. `buildBasenameIndex(paths)` is computed once for the whole rebuild, and kept with the edges for `resolve`.
3. Notes are read in batches of 32 via `VaultReader.readNotes({ fields: ['frontmatter', 'content'] })`.
4. For each note, `parseWikilinks(content)` + `extractWikilinksFromFrontmatter(frontmatter)` produce raw targets; `normalizeWikilinkTarget` strips display text (plain `|alias` or the table-escaped `\|alias`) and section anchors; `basenameIndex.resolve` maps to a vault path or marks unresolved (including a path-form target that several notes match by suffix).
5. Outgoing edges are deduped (resolved by target path, unresolved by raw name); the corresponding incoming edge is appended to the resolved target.
6. Notes that fail to read (`READ_FAILED`) are logged to stderr and skipped — one bad note does not abort the build.

## Wiring

The registry builds one graph per vault through `IRegisteredVaultDeps.graphFactory`, over that vault's scoped `reader`, and exposes it as `entry.graph` ([`vault-registry.md`](./vault-registry.md)). Tool handlers read it off the entry: `get_note_links`, `get_vault_overview` and the `vault://overview` resource, `query_notes` and `listMatchingPaths`, `read_daily`, `search_notes`' per-match `backlink_count`, and `get_similar_notes`' forward links. Under `--no-semantic` it is also the standalone lexical reader's tie-break.

The vault entry (`IVaultEntry`) builds its own `WikilinkGraphIndex` over its scoped reader and starts its first build in the background with the entry and again after a scope change (later rebuilds follow the TTL, on demand). It is the vault directory's one graph: the lexical leg's tie-break reads it ([`lexical-search.md`](./lexical-search.md)), and `IVaultEntry.graph` exposes the same build as an `IGraphReader`, which `VaultEntries.graph(clientId, vault)` hands to the `graph` service for any connection attached to the vault, with any profiles or none. Every attached session reading `graph.*` therefore reads one build, and a scope change replaces it for all of them and the tie-break at once.

The session's own graph still serves every consumer listed above while the cut-over of [#172](https://github.com/AlexMost/neuro-vault/issues/172) is in progress: nothing in the session calls `graph.*` yet. Under `--no-shared` the in-process entry's graph sits beside the registry's (about 0.7 MB each on a ~1,000-note vault).

## TTL choice

Three minutes balances two pressures: a single rebuild on a real-world vault is fast (low tens of milliseconds for a few thousand notes), but doing it on every tool call is wasteful in tight conversational loops. Three minutes is short enough that link-related staleness is rarely visible to a human-paced session, and long enough that a burst of related queries pays the rebuild cost only once.

There is no manual invalidation API — agents that just wrote a note do not need to wait, because the next `ensureFresh` after the TTL window will pick it up. If a future use case demands immediacy, an `invalidate()` method can be added without changing the public surface.
