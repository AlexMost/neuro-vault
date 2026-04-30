---
status: accepted
date: 2026-04-30
---

# Wikilink graph index for neuro-vault

## Goal

Expose the vault's wikilink graph as a first-class signal alongside embeddings.
neuro-vault currently ignores the structure of links between notes entirely,
even though Obsidian itself uses backlink count as the dominant weight metric
on its graph view.

Backlinks are not the same signal as semantic similarity. Embeddings say "these
notes are about similar things". Backlink count says "these are the concepts
the user has chosen to anchor". Today an agent calling `search_notes` on a
topic gets, say, ten results — typically one or two concept anchors plus eight
incidental mentions in daily notes — and treats them all the same. A structural
signal lets the agent re-rank, filter to anchor notes, or sort by emergent
weight.

This spec also lays the substrate for a later GraphRAG retrieval strategy
(see [`Embedding and retrieval strategies for neuro-vault`] in the vault):
the same primitive — full adjacency lists — gets reused for graph-based
retrieval. Building it now as `count` plus `lists` rather than `count`-only
costs nothing extra and avoids re-reading the vault later.

## Scope

### In scope

- In-memory adjacency index over the whole vault, holding **full** outgoing and
  incoming lists per note (not just counts).
- Lazy build on first query; lazy rebuild on query when the index is older
  than 3 minutes. No background timers, no fs watcher, no persistent snapshot.
- Embeds (`![[X]]`) counted as wikilinks; same edge type.
- Unresolved targets retained in the outgoing list with `resolved: false` —
  they are a distinct signal class (concepts the user has anchored but not
  yet written).
- New tool `get_note_links(path)` returning the adjacency for one note.
- Enrichment field `backlink_count` on `search_notes` and `query_notes`
  results.
- `query_notes` sort allows `field: "backlink_count"` (emulates a former
  `get_top_linked_notes` without adding a new tool).
- Graph index lives in `src/lib/obsidian/` and is constructed once at server
  bootstrap; both `operations` and `semantic` modules consume it.

### Out of scope (explicit)

- **PageRank.** Raw counts are sufficient for v1. Add weighting only if counts
  prove noisy.
- **Persistent snapshot or fs watcher.** Add only when TTL-driven rebuild
  becomes the bottleneck.
- **GraphRAG retrieval** (community detection, multi-hop traversal). A later
  layer; v1 deliberately ships full adjacency lists so this layer can sit on
  top without re-reading the vault.
- **`get_link_health()`** (orphans, broken wikilinks). Useful, deferred.
- **`get_unresolved_links()`** (top unwritten concepts ranked by anchor
  frequency). The index already contains the data; surface the tool in a
  later iteration.
- **Smarter wikilink resolver.** Today's exact-basename match is enough.
  Aliases, headings, block refs, and partial paths stay `unresolved` until a
  concrete need shows up.
- **`outlink_count` enrichment.** Computable locally from the note body
  (`[[...]]` regex); duplicating it on every search response is token cost
  without unique value. Use `get_note_links` for full outgoing.

## Architecture

### `WikilinkGraphIndex` (`src/lib/obsidian/wikilink-graph.ts`)

- Single class. Holds `Map<notePath, { outgoing: OutgoingLink[]; incoming: IncomingLink[] }>`.
- Constructed with a `VaultReader` (existing primitive) plus optional `ttlMs`
  and `now` injection points for tests.
- `ensureFresh()` — idempotent. First call builds. Subsequent calls within TTL
  are no-ops. Calls after TTL re-build synchronously (the request that hits a
  stale index pays the rebuild cost; later requests inside the new window are
  free). Concurrent callers share one in-flight build.
- `getNoteLinks(path)` — returns a defensive copy of the adjacency for a single
  note. Empty `{ incoming: [], outgoing: [] }` when the path is unknown
  (deleted between rebuilds, never existed).
- `getBacklinkCount(path)` — fast path used by the `search_notes` /
  `query_notes` enrichers; equivalent to `incoming.length`.

### Build algorithm

1. `reader.scan()` to enumerate every `*.md` path.
2. `buildBasenameIndex(paths)` — reuse existing resolver primitive.
3. Read notes in batches of 32 via `reader.readNotes({ fields: ['frontmatter', 'content'] })`
   — same batch shape as `query_notes` to keep memory bounded.
4. For each note collect outgoing edges from body + frontmatter wikilinks
   (existing `parseWikilinks`, `extractWikilinksFromFrontmatter`,
   `normalizeWikilinkTarget`). Self-links dropped. Resolved/unresolved
   deduped separately.
5. Mirror resolved outgoing edges into the target's `incoming` list.
6. Replace `byPath` atomically.

### Edge shapes

```ts
interface OutgoingLink {
  target: string; // raw normalized target token (basename or path form)
  resolved: boolean;
  path?: string; // present when resolved
}

interface IncomingLink {
  source: string; // resolved source path
}

interface NoteLinks {
  incoming: IncomingLink[];
  outgoing: OutgoingLink[];
}
```

`incoming` carries only resolved sources by construction (an unresolved edge
has no source path to attribute it to). `outgoing` carries both classes; the
`resolved` flag is the discriminator.

### Server-level wiring

The graph is a vault-level primitive consumed by both modules:

- `operations` uses it for `get_note_links` and the `query_notes`
  enrichment / sort.
- `semantic` uses it for `search_notes` enrichment.

Both modules need access to the same index. Two options were considered:

1. Build a graph per module (simpler dep wiring, double cost, double memory).
2. Build once at server level and inject (small refactor, single source of
   truth).

**Decision: option 2.** The server already owns the lifetime of both modules
and the vault path. We hoist `VaultReader` construction into `server.ts`
(today it lives inside the `operations` module) and build a single
`WikilinkGraphIndex` from it. Both module factories accept the reader and
the graph as injected dependencies; tests stub them as before.

## API

### `get_note_links`

```
get_note_links({ path: string }) =>
  {
    incoming: [{ source: string }, ...],
    outgoing: [
      { target: string, resolved: true,  path: string },
      { target: string, resolved: false }
    ]
  }
```

- `path` is vault-relative POSIX, normalized via existing `normalizePath`.
- Calls `graph.ensureFresh()` before responding.
- Returns the empty adjacency for an unknown path (no error). Resolution
  failures live inside the result via `resolved: false`.

### `search_notes` / `query_notes` enrichment

Each `results[i]` gains `backlink_count: number`.

`query_notes.sort.field` whitelist extended to allow `"backlink_count"`
(alongside `"path"` and `"frontmatter.<key>"`).

`backlink_count` is exposed on the underlying `NoteRecord` as a first-class
field — this means sift filters can also use it (e.g.
`{ filter: { backlink_count: { $gte: 3 } } }`) without further plumbing.
The spec does not mandate filter usage but does not forbid it; making the
field first-class is the lowest-friction wiring.

`outlink_count` is intentionally not added (see Out of scope).

## Testing strategy

- **`WikilinkGraphIndex`** — direct unit tests with an in-memory `VaultReader`
  stub. Cover: initial lazy build, no rebuild within TTL, rebuild after TTL,
  concurrent `ensureFresh` deduplicated, embeds counted, unresolved kept on
  outgoing with `resolved: false`, self-links dropped, target dedup, deleted
  note disappears after rebuild, incoming list mirrors resolved outgoing.
- **`get_note_links` tool** — handler tests with a mocked graph.
- **`query_notes`** — extend existing tests so `backlink_count` appears on
  every result item; sorting by `backlink_count` works in both directions;
  filter `{ backlink_count: { $gte: N } }` works.
- **`search_notes`** — `backlink_count` appears on every result item in both
  single-query and multi-query modes (block-level results are unchanged).
- **`server-modules.test.ts`** — adjust expected tool counts (operations: 12;
  combined: 16) and expose graph injection points so the fakes don't need a
  real vault.

## Definition of Done

- `WikilinkGraphIndex` shipped under `src/lib/obsidian/` with full test
  coverage of build, TTL, embeds, unresolved retention.
- `get_note_links` tool registered and callable end-to-end.
- `backlink_count` appears in `search_notes` and `query_notes` responses.
- `query_notes` accepts `sort.field: "backlink_count"`.
- README enumerates the new tool and the new field; an
  `docs/architecture/wikilink-graph.md` describes the primitive's contract.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all clean.

## Connections

- Vault note: `Tasks/Add wikilink graph index to neuro-vault.md` (origin).
- Companion vault note: `Ideas/Embedding and retrieval strategies for neuro-vault.md`
  — this graph is the substrate for the GraphRAG strategy described there.
- Prior spec: `2026-04-29-get-similar-notes-graph-signals-design.md` —
  introduced single-note forward-link signals; this spec generalizes the
  primitive to a global index (without replacing the per-call resolver in
  `get_similar_notes`).

[`Embedding and retrieval strategies for neuro-vault`]: ../../../README.md
