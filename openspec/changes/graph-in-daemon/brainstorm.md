# Brainstorm — graph-in-daemon

Tracked by: #172. Source: the architecture review of 2026-10-19, which named this move the last critical refactor; the owner asked for it as an OpenSpec change in its own session. The requesting session handed over the evidence and six design forks, so every decision below is this session's call, made against the code on main 76104ed (2026-10-20, CI green) and the constraints the request named. Nothing here was confirmed by the owner beyond the request itself; the owner reviews the calls at the pause after PR 1.

## Background

Two wikilink graphs exist per vault, both `WikilinkGraphIndex` over a scoped `FsVaultReader`:

1. **The session's**, built by `defaultVaultDeps().graphFactory` (`src/lib/vault-registry.ts:131`) over the reader the registry builds from the scope it read once at startup. It answers every link question a tool asks.
2. **The vault entry's**, built in `buildLexical()` (`src/lib/vault-entry/vault-entry.ts:155`) over the entry's scoped reader, rebuilt from scratch on every `setScope`. It answers only the lexical leg's backlink tie-break.

They can disagree. Per ADR-0020 a session reads its scope once, while `VaultEntries.attach` re-reads `.gitignore` / `.neuro-vault/config.json` on every attach and rescopes the entry when the patterns changed. After such a change, `search_notes` ranks its lexical leg with backlink counts over one note set and stamps `backlink_count` from another; `get_note_links` and `query_notes` answer from the session's older set. ADR-0020 already names the move: "What remains duplicated per session is the lexical cache and the wikilink graph. They are the next changes (#176, #172), each a vault-entry member reached through the same attach." #176 landed; this is the other half.

Hub work needs one graph per vault too: #128 (cross-vault resolution by unique suffix, alias, basename) and #130 (graph neighbourhood) belong inside one module per vault, and #129 (resolution scope separate from lexical scope) needs one place where scope meets the graph.

### Session consumers today (grep `.graph`, `getBacklinkCount`, `ensureFresh`, `resolve`)

| Consumer | What it reads | Where |
| --- | --- | --- |
| `get_note_links` | `ensureFresh` + `getNoteLinks(path)` for one note | `src/modules/operations/tools/get-note-links.ts:47` |
| `get_vault_overview`, `vault://overview` | `ensureFresh`, then `getBacklinkCount` for every scanned path (top 10 by backlinks) | `src/lib/obsidian/vault-overview.ts:67`, `top-by-backlinks.ts:23` |
| `query_notes`, `read_daily` | `ensureFresh`, then `getBacklinkCount` for every scanned note before `sift` (the filter and sort may name `backlink_count`; every result carries it) | `src/lib/obsidian/query/query-notes.ts:122,151` |
| `listMatchingPaths` (the `filter` of `search_notes`, `get_similar_notes`, `find_duplicates`) | `getBacklinkCount` per scanned note, through `collectMatchingPaths`, **never** `ensureFresh` | `src/lib/obsidian/query/list-matching-paths.ts` |
| `search_notes` | `ensureFresh` (skipped when the filter matched nothing), then `getBacklinkCount` per match | `src/modules/semantic/tools/search-notes.ts:166,236` |
| `get_similar_notes` | `ensureFresh`, then `resolve(target)` per forward link parsed from the note's current text | `src/modules/semantic/tools/get-similar-notes.ts:85` |
| standalone lexical reader (`--no-semantic`) | `ensureFresh` + `getBacklinkCount` as the tie-break | `src/modules/semantic/lexical/standalone-reader.ts:32` |

## Scope (one sentence)

In: one wikilink graph per vault directory, the vault entry's, read by every attached session through `graph.*` methods on its vault client and used by the entry's own lexical tie-break, with the session-built graph deleted; out: any tool-contract change, a different freshness model, the resolution-scope split (#129), cross-vault resolution (#128), neighbourhood reads (#130), and the note-metadata layer (filters, `query_notes`), which stays in the session.

## Constraints carried in

- ADR-0018 / 0020 / 0021: a new shared capability is a namespaced service plus a session-side view over the one vault client, reached through the same attach, with no connection, switch or detach of its own.
- ADR-0019's spirit: the daemon serves reads, the session composes.
- No tool-contract change; every tool's output identical for the same vault state, except freshness differences documented and justified here. `npm run eval` unchanged.
- The interface is the test surface: view tests over a fake client, service tests through both `ServiceRegistry` and the in-process link, `test/integration/*` for two sessions sharing one entry graph. `makeVaultGraph()` in `test/_vault-graph.ts` keeps serving tool tests.
- Memory is not the motive (about 0.7 MB of heap per ~1,200 notes).

## Decision chain

### F1 — The session-side interface: an async batched view, not a snapshot

`IVaultGraph` is synchronous after `ensureFresh()`. Over the socket every read is async, so the session's interface has to change shape one way or another.

**Option A — async view with batched reads.** One call per question, each carrying every path or target the tool needs at once:

```ts
interface IGraphReader {
  noteLinks(path: string): Promise<NoteLinks>;
  backlinkCounts(paths: readonly string[]): Promise<number[]>;   // in order; 0 for a note the graph lacks
  resolve(targets: readonly string[]): Promise<(string | null)[]>; // in order
}
```

**Option B — a snapshot pulled once per tool call.** `ensureFresh()` fetches the graph (or a generation-tagged copy, refetched only when the daemon rebuilt), and the sync reads answer from it. Every consumer stays untouched.

Round trips per tool call under A:

| Tool | Calls | Payload |
| --- | --- | --- |
| `get_note_links` | 1 `graph.noteLinks` | one path in, one note's edges out |
| `get_vault_overview` / `vault://overview` | 1 `graph.backlinkCounts` | every scanned path in (~50 KB for ~1,200 notes), one integer each out |
| `query_notes` / `read_daily` | 1 `graph.backlinkCounts` per scan prefix, in parallel (one prefix unless the caller gives several) | that prefix's scanned paths |
| `listMatchingPaths` | 0 (F6) | — |
| `search_notes` | 1 `graph.backlinkCounts` after the pipeline, skipped with no matches | the match paths (≤ the cap) |
| `get_similar_notes` | 1 `graph.resolve` | the note's normalized link targets |

No loop issues a call per note or per batch: the counts are fetched once per scan, before the read loop.

**Decision: A.** Why:

- B puts a full copy of the graph back into every session that reads one — the duplication this change removes — and makes the session, not the entry, the place a link resolves. #128 and #130 need resolution and neighbourhood answered in one module per vault; B would leave them a session-side copy to keep in step.
- B's payload is the whole adjacency (every edge of every note, a few hundred KB of JSON for ~1,200 notes) on the first read after each rebuild, even for `get_note_links` on one note.
- A's largest payload is a path list the size of the vault's note list, which `lexical.search` already sends as `allowed` today — a known, accepted cost on a local socket.

`ensureFresh()` leaves the session's interface: freshness is the entry's (F3), and each `graph.*` read awaits it there. `noteLinks` stays one path — no caller needs several, and #130 will define its own neighbourhood read.

Naming: the session's async interface is `IGraphReader` (as `ILexicalReader` is the session's read of the entry's `LexicalIndex`); `IVaultGraph` stays the synchronous interface of the in-memory graph that the entry — and, under `--no-semantic`, the session — hosts. `IRegisteredVault.graph` becomes an `IGraphReader` in PR 2.

### F2 — What the daemon serves, what the session composes

Three methods, each declared with `defineMethod` and a closed zod schema, rows in `VaultMethods`:

| Method | Params | Result |
| --- | --- | --- |
| `graph.noteLinks` | `{ vault, path }` | `{ incoming: [{ source }], outgoing: [{ target, resolved, path? }] }` |
| `graph.backlinkCounts` | `{ vault, paths }` | `{ counts: number[] }`, one per path, in order |
| `graph.resolve` | `{ vault, targets }` | `{ paths: (string \| null)[] }`, one per target, in order |

They are entry-level, like `lexical.search`: any connection attached to the vault may call them, even one that attached with `profiles: []`. A connection that did not attach the vault gets `NOT_ATTACHED`; a build that throws is `GRAPH_FAILED` with the reason (a new `DaemonErrorCode`, beside `LEXICAL_FAILED`).

The session keeps composing:

- **top-by-backlinks** — sorting and slicing the session's own scanned paths by their counts. A `graph.topByBacklinks` would move composition daemon-side and answer over the entry's note set, not the paths the overview counts folders over.
- **forward links of `get_similar_notes`** — the session parses the note's current text, as today, and only asks where the targets resolve. Serving them from the graph's last build (`graph.noteLinks(...).outgoing`) would read text up to three minutes old; today's contract reads it fresh and resolves against the graph's build (the owner accepted that freshness for resolution in #206).
- **`query_notes` filtering and sorting** — the counts arrive as data; `sift`, sort and truncation stay where they are.

### F3 — Freshness: the TTL, unchanged

Today the session's graph rebuilds on a 3-minute TTL when a reader awaits `ensureFresh()`. The entry's graph runs the same TTL, warms in the background when the entry is built, and is rebuilt from scratch on `setScope`.

Options weighed:

- **Follow the watcher** (rebuild, or mark stale, after each quiet period). The entry's watcher runs only while some profile holds a corpus (design D3 of `daemon-vault-registry`): a vault with `"semantic": false` has none, nor does one attached only with `profiles: []`. And the graph rebuilds in full — ~0.6 s for ~1,200 notes — so the first tool call after every edit would pay it, where the TTL pays it at most once per three minutes.
- **Both** (TTL, plus the watcher marking stale). Same cost as above wherever a watcher runs.
- **TTL only.** Same rule every consumer has today.

**Decision: TTL only, three minutes, one build shared by every attached session and the tie-break.** Each `graph.*` read and each lexical search awaits the entry graph's `ensureFresh()`; concurrent reads share one rebuild.

Resulting freshness, per consumer — the bound is unchanged: every answer comes from a build at most three minutes old, plus a scope change rebuilds at once.

| Consumer | Today | After |
| --- | --- | --- |
| `get_note_links`, overview, `query_notes`, `read_daily`, `search_notes` `backlink_count`, `get_similar_notes` resolution | session build, ≤ 3 min old | entry build, ≤ 3 min old |
| lexical tie-break | entry build, ≤ 3 min old | same |
| `listMatchingPaths` | whatever the session graph last built (possibly nothing) — it never refreshes | reads no graph (F6) |

The one observable difference: a session's first graph read no longer always builds fresh. Today a new session's graph is empty until its first `ensureFresh()`, which builds then; after, a session attaching to an entry another session (or the tie-break) already warmed reads that build, up to three minutes old. That is the same bound every later read already has, and it is the point of sharing one graph. Watcher-driven freshness is a follow-up that makes sense once the graph updates incrementally rather than rebuilding.

### F4 — `--no-shared` and `--no-semantic`

- **`--no-shared`**: the session's vault client is the in-process client over the loopback, which calls the same `createVaultEntryServices` map; registering the `graph` service there serves it with no extra wiring. The in-process entry's graph replaces today's second graph beside the registry's.
- **`--no-semantic`**: the session builds no vault clients, so nothing attaches and no daemon starts (decision F1 of `daemon-lexical-search`; `lexicalOnlyVaultFactories` in `src/modules/semantic/index.ts`). Attaching anyway just for the graph would start the daemon (or an in-process entry with its watcher) in a mode chosen precisely to avoid it.

**Decision: under `--no-semantic` the session hosts its own graph — the same `WikilinkGraphIndex`, behind the same `createGraphReader` adapter the entry uses.** One implementation, two hosts: the entry (daemon or in-process) and the `--no-semantic` session. The standalone lexical reader keeps that session graph as its tie-break, as today. A per-vault `"semantic": false` is not `--no-semantic`: such a vault still attaches for its lexical leg, and its graph reads ride the same attach.

### F5 — Scope

The entry's graph is built over the entry's scoped reader. Membership per consumer:

- **While the scope has not changed since the session started** — the common case — the session and the entry load the same scope (`loadVaultScope` over the same `.gitignore` and `config.json`; the entry adds only a `warn`), so every consumer sees the same note set it sees today, and every tool's output is identical.
- **After a scope change**, the graph's answers follow the vault's current scope, as the lexical leg already does: a note newly excluded has no links and a count of 0, a link to it resolves to nothing, and edges from it disappear. The session's own path lists (the overview's scan, `query_notes`' scan) still come from the session's reader, so after a narrowing `query_notes` may list a note whose `backlink_count` is now 0. This is the documented difference, and it removes the disagreement between `search_notes`' ranking and its stamped counts.

The resolution-scope split itself — resolving links against a wider set than lexical search sees — stays with #129.

### F6 — The note-metadata layer stays in the session

With `backlinkCounts` batched, `query_notes` costs one call per scan prefix, so nothing forces the metadata layer across. It stays in the session, as the #160 map decided.

One simplification falls out: `listMatchingPaths` builds only `tags` / `frontmatter` / path filters (`compileFilter`), so its filter can never read `backlink_count`, and it never refreshed the graph anyway. It stops taking a graph; it makes no graph call. Output is unchanged.

### F7 — Errors

The view maps every failure of a graph read — `GRAPH_FAILED`, `NOT_ATTACHED`, a vault the entry cannot attach, a timeout, a dropped connection — to one `GraphReadError` for that call, as the lexical view does with `LexicalSearchError`. None flips the switch; a `NOT_ATTACHED` has already made the client forget its attach. Graph methods take the client's default 30 s timeout: a rebuild of a 10,000-note vault takes a few seconds. Tool handlers let it propagate as they let a rebuild failure propagate today.

### F8 — ADR?

No new ADR. ADR-0020 already decided where per-vault state lives and named this move; ADR-0021 decided that per-vault reads are views over the one client; ADR-0019 decided the daemon serves reads and the session composes. F1's batching is a design decision under those, recorded in `design.md` and `docs/architecture/wikilink-graph.md`. ADR-0020's "What remains duplicated per session" line becomes history, as ADRs do.

## Delivery

Two PRs, foundation first:

1. **PR 1 — dark foundation** (`Refs #172`). `IGraphReader` and `createGraphReader` in `src/lib/obsidian/`; the entry exposes its one graph as an `IGraphReader` and `VaultEntries.graph(clientId, vault)`; `graph.*` rows, schemas and `GRAPH_FAILED` in `protocol.ts`; `createGraphService` registered in `createVaultEntryServices`; `createGraphReaderView` over the vault client. Tests through `ServiceRegistry`, the in-process link and an integration test of two clients sharing one entry graph. No session consumer changes; nothing in the session calls the view yet. Docs for what landed.
2. **PR 2 — cut-over** (`Closes #172`). `graphFactory` becomes a module factory (the vault clients' view; the `--no-semantic` session's own graph); `IRegisteredVault.graph` becomes `IGraphReader`; every consumer moves to the batched reads; `listMatchingPaths` drops the graph; the registry stops building a graph; `makeVaultGraph` serves tool tests as an `IGraphReader`. The guide and architecture doc sweep.
