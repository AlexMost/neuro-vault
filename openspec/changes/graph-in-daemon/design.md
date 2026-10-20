## Context

The decisions are in `brainstorm.md` (F1–F8), made by this session against main 76104ed. This file fixes the names, files and seams.

**Today.** `WikilinkGraphIndex` (`src/lib/obsidian/wikilink-graph.ts`) implements `IVaultGraph` — `ensureFresh()`, then synchronous `getNoteLinks`, `getBacklinkCount`, `resolve` — on a 3-minute TTL. Two instances per vault:

- the registry's, built by `defaultVaultDeps().graphFactory` over the session reader and exposed as `IRegisteredVault.graph` to seven consumers (brainstorm table), and passed to `lexicalReaderFactory` and `listMatchingPathsFactory`;
- the vault entry's, built in `buildLexical()` over the entry's scoped reader, rebuilt on `setScope`, warmed in the background, read only by `lexicalSearch` for the tie-break.

The session reaches the entry through one `IVaultClient` per vault root and side (`src/modules/semantic/vault-client/`): `call(method, params)` typed by `VaultMethods` in `src/daemon/protocol.ts`, each method declared with `defineMethod` and a closed zod schema, validated on both the socket and the in-process loopback, which dispatches to `createVaultEntryServices(entries)`. `--no-semantic` builds no clients (`lexicalOnlyVaultFactories`).

**Constraints.** ADR-0018/0019/0020/0021/0022; ADR-0015 for tool tests; no tool-contract change; `npm run eval` unchanged; `makeVaultGraph()` keeps serving tool tests. Naming (`docs/architecture/naming-conventions.md`): interfaces take `I`; wire types in `protocol.ts` stay unprefixed.

## Goals / Non-Goals

**Goals:**

- One wikilink graph per vault directory — the vault entry's — shared by every attached session and the lexical tie-break.
- Sessions read it through a view over their existing vault client: no connection, switch or detach of its own.
- Every consumer makes at most one graph call per scan; none per note.
- Same tool output for the same vault state; freshness bound unchanged (≤ 3 minutes).
- One graph implementation, hosted by the entry, or by the session under `--no-semantic`.

**Non-Goals:**

- Resolution scope separate from lexical scope (#129), cross-vault resolution (#128), neighbourhood reads (#130).
- Watcher-driven or incremental graph freshness.
- Moving the note-metadata layer (`query_notes`, filters) into the daemon.
- Any change to `daemon status` output: the graph has no state line of its own.

## Decisions

### D1: `IGraphReader` — the session's async, batched read of a graph

- **Choice**: `src/lib/obsidian/graph-reader.ts`:

  ```ts
  /** A vault's wikilink graph as a session reads it: each read answers from a build at most a TTL old. */
  export interface IGraphReader {
    /** The note's incoming and outgoing links; none for a note the graph does not hold. */
    noteLinks(notePath: string): Promise<NoteLinks>;
    /** One count per path, in order; 0 for a note the graph does not hold. */
    backlinkCounts(paths: readonly string[]): Promise<number[]>;
    /** One answer per normalized target, in order: its vault path, or null. */
    resolve(targets: readonly string[]): Promise<(string | null)[]>;
  }

  /** A read of the graph failed: the one error a view's caller sees. */
  export class GraphReadError extends Error {}

  /** The reader over an in-memory graph: each read awaits `ensureFresh()` on the graph `current()` names. */
  export function createGraphReader(current: () => IVaultGraph): IGraphReader;
  ```

  `createGraphReader` reads `current()` once per call, awaits its `ensureFresh()`, and answers every path or target from that one build. It wraps no errors: the entry's service maps them to `GRAPH_FAILED`, and a `--no-semantic` session's tools see them raw, as today.
- **Why**: brainstorm F1. Batched reads cost one round trip per question; `ensureFresh()` leaves the session's interface because freshness is the host's.
- **Alternatives**: a snapshot pulled per tool call behind the existing sync `IVaultGraph` — rejected in F1 (a graph copy per session, resolution in the session, whole-adjacency payloads); keeping `ensureFresh()` on the reader as a no-op — an obligation with no effect.

### D2: The entry exposes its one graph as a reader

- **Choice**: `IVaultEntry` gains `readonly graph: IGraphReader`, built once as `createGraphReader(() => current graph)`; the getter throws `vault entry: disposed` after `dispose()`. `buildLexical()` keeps building the graph beside the lexical index and warming it; `lexicalSearch` keeps reading the same object synchronously for the tie-break. `VaultEntries.graph(clientId, vault): IGraphReader` is entry-level like `lexical()`: `NOT_ATTACHED` unless the client attached the vault (any profile list, including none). The two share one private `attachedEntry(clientId, vault)` check.
- **Why**: brainstorm F2/F3. The tie-break and every session read the same build; a scope change replaces it for both at once.
- **Alternatives**: a second graph for the service (the duplication this change removes); routing the tie-break through `IGraphReader` (it needs a synchronous count inside ranking).

### D3: Three `graph.*` methods

- **Choice**: in `src/daemon/protocol.ts`:

  ```ts
  export const graphNoteLinksParams = z.strictObject({ vault: z.string(), path: z.string() });
  export type GraphNoteLinksResult = NoteLinks;
  export const graphBacklinkCountsParams = z.strictObject({ vault: z.string(), paths: strings });
  export interface GraphBacklinkCountsResult { counts: number[] }
  export const graphResolveParams = z.strictObject({ vault: z.string(), targets: strings });
  export interface GraphResolveResult { paths: (string | null)[] }
  ```

  Three `VaultMethods` rows; a new `DaemonErrorCode` `GRAPH_FAILED` (`InternalError`). `src/daemon/services/graph.ts` `createGraphService(entries: GraphEntriesPort)` — `wired(() => entries.graph(ctx.id, call.vault))`, then the read, any throw of which is `GRAPH_FAILED` with the reason. `createVaultEntryServices` registers it as `graph`, so the daemon and the in-process loopback serve it alike. Empty `paths` / `targets` are valid and answer empty lists. The calls take the client's default 30 s timeout (`timeouts.ts` unchanged).
- **Why**: brainstorm F2. The daemon serves reads; the session composes top-by-backlinks, `query_notes` and forward-link parsing.
- **Alternatives**: `graph.topByBacklinks` (composition daemon-side, over the entry's note set); `graph.forwardLinks` for `get_similar_notes` (text up to a TTL old instead of current).

### D4: The session view

- **Choice**: `src/modules/semantic/graph/view.ts` `createGraphReaderView(client: IVaultClient): IGraphReader`, exported through `src/modules/semantic/graph/index.ts`. Each read is one `client.call`; an empty `paths` / `targets` list answers `[]` without a call. A result whose list is missing or whose length differs from the request is a `GraphReadError`; every failure (`GRAPH_FAILED`, `NOT_ATTACHED`, `VAULT_UNAVAILABLE`, `DaemonTimeoutError`, `DaemonConnectionError`, closed services) is a `GraphReadError` naming the method, for that call only — none flips the switch, and the client has already forgotten a `NOT_ATTACHED` attach.
- **Why**: brainstorm F7; the lexical view is the model.
- **Alternatives**: passing `DaemonRpcError` through (every consumer would learn the wire's vocabulary).

### D5: Wiring after the cut-over (PR 2)

- **Choice**:
  - `IRegisteredVault.graph: IGraphReader`. `graphFactory` moves from `defaultVaultDeps` into `IModuleVaultFactories` with `({ vaultRoot, vaultName, reader, enabled }) => IGraphReader`.
  - `createVaultClients` supplies `graphFactory: ({ vaultRoot, enabled }) => createGraphReaderView(clientOf(vaultRoot, enabled))` — the same client, so the same one attach per epoch.
  - `lexicalOnlyVaultFactories` (`--no-semantic`) builds one `WikilinkGraphIndex` per vault root over the session reader, memoized, and hands `createGraphReader(() => index)` to `graphFactory` and the index itself to `createStandaloneLexicalReader`. `lexicalReaderFactory` stops receiving `graph` from the registry.
  - `listMatchingPathsFactory` drops `graph`; `collectMatchingPaths` takes an optional `backlinkCounts(paths)` dep, called once per scan before the read loop.
  - Consumers: `get_note_links` → `noteLinks`; `computeVaultOverview` / `topByBacklinks` → one `backlinkCounts(paths)`; `runQueryNotes` → one per scan prefix; `search_notes` → one `backlinkCounts` over the match paths after the pipeline, none with no matches; `getNoteLinks` (`note-links.ts`) collects the normalized targets and makes one `resolve` call.
  - `test/_vault-graph.ts` `makeVaultGraph(overrides)` returns an `IGraphReader` of spies (empty graph by default); tests that want a real graph use `createGraphReader(() => new WikilinkGraphIndex({ reader }))`.
- **Why**: brainstorm F4–F6. One graph implementation, two hosts.
- **Alternatives**: attaching under `--no-semantic` for the graph alone (starts the daemon in the mode that exists to avoid it).

### D6: No new ADR

- **Choice**: none. ADR-0020 decided the location and named this move; ADR-0021 the view over the one client; ADR-0019 that the daemon serves reads. D1's batching is recorded here and in `docs/architecture/wikilink-graph.md`.
- **Why**: brainstorm F8.

## Risks / Trade-offs

- [Risk] A scope change makes `query_notes` list a note (from the session's scan) whose `backlink_count` the entry's graph reports as 0. → Mitigation: documented in `wikilink-graph.md` and `vault-scope.md`; the session's next restart re-reads the scope; #129 owns the split.
- [Risk] A large vault's `backlinkCounts` sends every scanned path. → Mitigation: the same order as `lexical.search`'s `allowed` today; one call per scan, not per note. A test asserts one call per tool.
- [Trade-off] A session's first graph read may be served from a build up to three minutes old that another session triggered, where today it always built fresh. → Accepted: the same bound every later read has; it is the point of one graph.
- [Risk] A slow rebuild on a very large vault meets the 30 s client timeout. → Mitigation: the default timeout is the lexical leg's, whose cache warms over the same notes; a timeout is a `GraphReadError` for that call only.
- [Risk] PR 1 lands code nothing calls. → Mitigation: tests through `ServiceRegistry`, the in-process link and the socket daemon prove it; PR 2 follows directly.

## Migration Plan

N/A — no deployment change. PR 1 adds the daemon methods dark: an older session never calls them, and a newer session meeting an older daemon cannot happen (the daemon is per installed build, ADR-0018). PR 2 switches every consumer at once. Rollback is a revert of either PR.

## Open Questions

None blocking. Follow-ups: watcher-driven freshness once the graph updates incrementally; #128, #129, #130 build on `graph.*`.
