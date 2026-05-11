# Smart Connections corpus auto-refresh

**Status:** draft
**Date:** 2026-05-11
**Related task:** `Tasks/Auto-refresh Smart Connections corpus in search_notes.md` (vault)

## Goal

Make `search_notes`, `get_similar_notes`, `find_duplicates`, and `get_stats` reflect notes that Smart Connections has embedded since the server started — without requiring a restart.

## Background

`createSemanticModule` (`src/modules/semantic/index.ts:68`) calls `loadSmartConnectionsCorpus` exactly once. The resulting `Map<string, SmartSource>` is wired into every semantic tool and into the derived `basenameIndex`. There is no watcher, TTL, or freshness check, and `docs/architecture/smart-connections-corpus.md:47` explicitly documents this:

> The loader does not watch for changes. The corpus is loaded once at startup. Restart the server to pick up new embeddings.

This was a deliberate simplification, but in practice agents create notes during long sessions, Smart Connections embeds them within seconds, and our tools keep returning stale results. The only workaround is restarting the MCP server — bad UX, externally reported.

The wikilink graph already solves the analogous problem: `WikilinkGraphIndex.ensureFresh()` is called from `search-notes.ts` (lines 220, 256) and rebuilds lazily on staleness. We adopt the same shape for the corpus.

## Non-goals

- No `reindex_corpus` MCP tool in this change. It can be added later as a thin wrapper over `forceReload()`; nothing here precludes it. We avoid widening surface area until there's a concrete need beyond the auto-refresh path.
- No watcher / fsnotify. Pull-based mtime check on each tool call is simpler and adequate (Smart Connections typically writes seconds-to-minutes after a note is saved; we only need freshness at query time).
- No partial / incremental reload. Reload is all-or-nothing — same code path as startup. AJSON sharding makes targeted reload finicky for negligible win.

## Architecture

### New unit: `SmartConnectionsCorpusIndex`

Lives in `src/lib/obsidian/smart-connections-corpus-index.ts`. Owns:

- The current `SmartConnectionsCorpus` (`sources` map).
- The current `BasenameIndex` derived from those sources.
- The last-known `maxMtimeMs` across `*.ajson` files in `smartEnvPath`.

```ts
export interface SmartConnectionsCorpusIndex {
  /**
   * Re-reads .smart-env/multi if max(mtime) of *.ajson exceeds the last seen
   * value, rebuilds basenameIndex, and atomically swaps the in-memory state.
   * Throws on reload failure — callers do not see stale data silently.
   */
  ensureFresh(): Promise<void>;

  /** Current sources map. Reference may change between ensureFresh() calls. */
  getSources(): Map<string, SmartSource>;

  /** Current basename → paths index. */
  getBasenameIndex(): BasenameIndex;
}
```

Factory:

```ts
export async function createSmartConnectionsCorpusIndex(opts: {
  smartEnvPath: string;
  modelKey: string;
  loadCorpus?: typeof loadSmartConnectionsCorpus; // for tests
  now?: () => number; // for tests
}): Promise<SmartConnectionsCorpusIndex>;
```

The factory performs an initial load (same semantics as today — empty corpus throws) and returns an index ready to serve.

### Freshness check

`ensureFresh()`:

1. `fs.readdir(smartEnvPath, { withFileTypes: true })` — list `*.ajson` files.
2. `fs.stat` each in parallel, take `max(mtimeMs)`. Also track the file count.
3. If `(maxMtimeMs, fileCount)` matches what we stored at last successful load → no-op.
4. Otherwise: call `loadCorpus(smartEnvPath, modelKey)` → on success, rebuild `basenameIndex`, atomically swap both refs, store new `(maxMtimeMs, fileCount)`. On failure: throw — do NOT mutate state, do NOT mask with stale data.

The `(maxMtime, fileCount)` pair catches both content edits to existing shards and file deletions (which can lower max-mtime). Cheaper alternatives (directory mtime alone) miss content edits on APFS; reading file contents is the obvious overkill.

### Concurrency

A single in-flight reload is shared across concurrent callers. Implementation: a `Promise<void> | null` field that, when set, is awaited by subsequent `ensureFresh()` calls until it resolves. After it resolves, the next caller re-evaluates freshness (mtime may have advanced again during reload).

### Wiring

`SemanticToolDeps` (in `src/modules/semantic/tools/index.ts`) drops the raw `sources` and `basenameIndex` fields and gains:

```ts
corpus: SmartConnectionsCorpusIndex;
```

Each semantic tool calls `await deps.corpus.ensureFresh()` at the top of its handler, then reads `deps.corpus.getSources()` / `deps.corpus.getBasenameIndex()` once and uses those snapshots for the rest of the call. This guarantees no swap mid-request.

`search_notes` already does `graph.ensureFresh()` in parallel with `pathExists` checks; we add `corpus.ensureFresh()` to that parallel set.

`createSemanticModule` no longer destructures `corpus.sources` at construction time — it builds the index and passes it through.

### Error handling

Reload failure during `ensureFresh()` throws and propagates to the tool handler, which wraps it via the existing `wrapDependencyError` helper → `ToolHandlerError('DEPENDENCY_ERROR', ...)`. Rationale: the corpus is the foundation for every semantic tool. Returning a snapshot we know to be inconsistent with disk would silently mislead the agent. A loud, structured error gives the caller actionable signal.

A note that disappears between two `ensureFresh()` calls is handled the same way as today — the `pathExists` filter (`search-notes.ts:94-103`) drops it from results.

## Testing strategy

Unit tests for `SmartConnectionsCorpusIndex` (new file, `src/lib/obsidian/smart-connections-corpus-index.test.ts`):

- First `ensureFresh()` after construction is a no-op (initial load already happened).
- mtime unchanged → no reload (`loadCorpus` not called again).
- mtime advanced → reload runs; new sources visible via `getSources()`.
- File count drops → reload runs (tombstone case).
- Reload failure: `getSources()` still returns the previous snapshot, but the throwing `ensureFresh()` surfaces the error; state is unchanged.
- Concurrent `ensureFresh()` calls share a single in-flight reload.
- `basenameIndex` is rebuilt on reload (asserted via a basename whose paths change).

Integration: extend the existing semantic-tool tests to assert that adding a new `*.ajson` file (or bumping mtime on an existing one) between two `search_notes` calls surfaces the new note in the second call. Vitest's `vi.useFakeTimers` is not enough — we exercise real `fs.stat` on a temp dir.

`get_stats` test: assert `totalNotes` reflects a corpus growth between calls.

## Documentation

`docs/architecture/smart-connections-corpus.md` — Boundaries section updated:

- Remove: "The loader does not watch for changes. The corpus is loaded once at startup. Restart the server to pick up new embeddings."
- Add: a short paragraph describing the pull-based mtime check via `SmartConnectionsCorpusIndex.ensureFresh()`, mirroring the wikilink-graph pattern, with the explicit failure semantics (no silent stale data).

A new architecture concept does not warrant a separate file — this is an evolution of the existing corpus concept.

## Definition of Done

- `SmartConnectionsCorpusIndex` implemented with the API above; unit tests cover the seven cases listed.
- `SemanticToolDeps` migrated to `corpus: SmartConnectionsCorpusIndex`; all four semantic tools call `ensureFresh()`.
- Integration test proves `search_notes` and `get_stats` see a new note added mid-session.
- Architecture doc updated.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- Conventional commit (e.g. `feat(semantic): auto-refresh smart connections corpus`) ready for the merge-to-main release flow.

## Open questions

None at write time. If the mtime check turns out to be a hot path on very large vaults (>10k shards), revisit with a TTL debounce; not preemptively.
