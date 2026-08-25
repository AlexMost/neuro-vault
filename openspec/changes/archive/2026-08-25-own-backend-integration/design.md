## Context

`search_notes`, `get_similar_notes` and `find_duplicates` all read one
`CorpusSnapshot` per vault: `{ sources: Map<string, SmartSource>, basenameIndex }`.
Today that snapshot comes from `createSmartConnectionsCorpusIndex`, wired in
`server.ts` as `corpusFactory` and called once per vault by
`VaultRegistry.create`. The result is recorded as two flags on the entry —
`semanticAvailable` and `semanticUnavailableReason` — decided once, at startup,
and never revisited.

Everything needed to produce that same snapshot from the corpus the server owns
already exists and is on `main`:

- `src/lib/obsidian/corpus/` — extraction, shard store, manifest, incremental
  reconcile (ADR-0013, `docs/architecture/own-corpus.md`).
- `neuro-vault-mcp index` — `src/cli-index.ts`, a thin wrapper over
  `reconcileCorpus` that already assembles scan/stat/read/embed/store for a
  vault.
- `eval/backends.ts` — reads `CorpusStore.listShards()` + `decodeVector` into
  exactly the `Map<string, SmartSource>` the ranking code consumes.

Constraints this design works under:

- **`npx` distribution** — no native build step, no platform binary (ADR-0013).
- **stdout is the MCP transport** — every diagnostic goes to stderr.
- **Indexing is measured, not free** — ~2.3 min cold for an ~840-note vault,
  ~90 ms per changed note, ~0.09 s for a no-op reconcile.
- **The corpus lib imports nothing from `src/modules/`** — the indexer sees the
  model only as `EmbedFn = (text: string) => Promise<number[]>`.
- **`stdio` server lifetime** — the process must still exit when the client
  disconnects; long-lived handles are a hazard, not a detail.

## Goals / Non-Goals

**Goals:**

- Every semantic call is served from the vault's own corpus, unconditionally.
- A server with no corpus, or an incompatible one, starts instantly and becomes
  semantically useful on its own, without a restart.
- A client can always tell which of the four states a vault's semantic leg is
  in, and — while indexing — how far along it is.
- The corpus stays fresh while the server runs.
- A vault can turn semantics off without turning it off for its neighbours.
- Backend, lifecycle, watcher and status are per vault entry; only the
  embedding model is shared.

**Non-Goals:**

- Reporting staleness or drift of a _built_ index (#103). `status()` here says
  "still building", never "built but behind".
- Any change to ranking, fusion, retrieval policy, extraction or storage.
- A backend-selection flag, a config knob for the debounce, or a `semantic`
  key that means anything other than on/off.
- Changing what `--no-semantic` does.

## Decisions

### D1: `SemanticBackend` is a generalisation of the existing seam, in a neutral home

- **Choice**: a two-method interface,
  `snapshot(): Promise<CorpusSnapshot>` and `status(): BackendStatus`, with
  `BackendStatus = { state: 'ready' | 'indexing' | 'disabled' | 'unavailable'; indexed?: number; total?: number; reason?: string }`.
  It, and `CorpusSnapshot`, live in a new `src/lib/obsidian/semantic-backend.ts`.
  `smart-connections-corpus-index.ts` imports `CorpusSnapshot` from there
  instead of owning it.
- **Rationale**: the retrieval policy needs a keyed map (`sources.get()` for
  expansion seeds and block backfill), so a narrower "search" contract would
  force the policy to change — this slice must not touch ranking. Re-homing the
  type is what lets #88 delete the Smart Connections files without a second
  contract edit. The interface stays after that deletion, as the test seam and
  the extension point for a future backend.
- **Alternatives**: a `SearchBackend` exposing only `findNeighbors`-style
  queries — rejected, it moves retrieval policy into the backend; keeping
  `CorpusSnapshot` in the Smart Connections file — rejected, it makes a deleted
  file load-bearing.

### D2: The backend caches one decoded snapshot; reconcile invalidates it

- **Choice**: the lifecycle holds the decoded `CorpusSnapshot` in memory.
  `snapshot()` returns it without touching disk. It is rebuilt from
  `CorpusStore.listShards()` after a reconcile pass that reported
  `embedded + renamed + deleted > 0`, and the new object replaces the old one in
  a single assignment.
- **Rationale**: a rebuild is ~68 ms for 2 500 shards, and reconcile already
  knows whether anything moved — so an idle server pays nothing and a change
  costs one rebuild per debounce batch, not one per call. A single assignment is
  the atomic promotion: a call that already holds a reference keeps ranking
  against a coherent snapshot.
- **Alternatives**: read shards per call — rejected, 68 ms on every search;
  patch the map entry-by-entry from a changed-path list — rejected, it needs a
  new return shape from `reconcileCorpus` and a second correctness argument
  (`basenameIndex` upkeep) for a saving of tens of milliseconds per batch.

### D3: Startup serves what it can, then catches up

- **Choice**, per vault, in this order:
  1. `semantic: false` in the vault config → `disabled`. Nothing else runs.
  2. Read the manifest. Compatible (`isManifestCompatible`) with shards present
     → load the snapshot, state `ready`, and run a reconcile in the background.
  3. Otherwise → state `indexing`, run the reconcile in the background,
     promote to `ready` when it finishes.
  4. A reconcile that throws — or one that returns having failed at least one
     note and left nothing rankable to serve — → `unavailable` with the reason; the vault keeps
     whatever snapshot it had. This is not terminal: the next pass — a watcher
     tick, or an explicit request — re-runs it and promotes to `ready` on
     success. The flag it replaces (`semanticAvailable: false`) was decided once
     at startup and survived until a restart; that permanence was the defect,
     not the reporting.
- **Rationale**: a compatible corpus is usable immediately even if slightly
  behind, and reconcile is a no-op in the common case (~0.09 s). Waiting for it
  would trade a measurable startup stall for a freshness gain that #103 owns.
- **Alternatives**: block startup until reconcile finishes — rejected, a cold
  vault would hang the client for minutes; serve nothing until the corpus is
  verified fresh — rejected for the same reason at lower benefit.

### D4: While indexing, the two embeddings-only tools fail structurally

- **Choice**: `get_similar_notes` and `find_duplicates` raise
  `SEMANTIC_INDEX_BUILDING` with `details: { vault, indexed, total }`.
  `SEMANTIC_DISABLED` covers state `disabled` and names the config key.
  `SEMANTIC_INDEX_NOT_FOUND` keeps its meaning for `unavailable`, with a hint
  that names `neuro-vault-mcp index --vault <path>` instead of Obsidian.
  `search_notes` never raises any of these — it degrades to its lexical leg.
- **Rationale**: those two tools have no non-semantic half; a structured code
  with counters lets a client decide to wait, while an empty result would read
  as "no duplicates". `search_notes` has a lexical leg, so degradation beats
  failure.
- **Alternatives**: return empty results with a status field — rejected, silent
  wrong answers; block the call until the index is ready — rejected, minutes.

### D5: `semantic_status` is always present on the `search_notes` payload

- **Choice**: every per-vault `search_notes` payload carries
  `semantic_status: { state, indexed?, total? }`, in every mode, including
  `mode: "lexical"` and the empty-filter early return. `indexed`/`total` appear
  only for `indexing`; `reason` is not exposed on this field.
- **Rationale**: the field describes the vault's index, not the request, so
  making it conditional on the leg having run would give it two meanings. An
  omitted field cannot be distinguished from an older server; a client must not
  have to read silence as health (user's call, 2026-08-25).
- **Alternatives**: emit only when not `ready`, per the compact-response
  convention — rejected by the user for exactly the ambiguity above.
- **Refinement** (final review): "describes the vault's index, not the request"
  governs _presence_ — the field is never omitted, and never conditional on
  which leg ran. It does not license a payload that contradicts itself. When
  the semantic leg fails mid-search on a backend that reported `ready` (a
  rejected query embedding, an unreadable snapshot), `search_notes` degrades to
  its lexical leg and reports `unavailable`, because that is what the client is
  actually holding — and, at that moment, what the vault's semantic capability
  actually is.

### D6: Freshness is a debounced whole-vault reconcile, driven by a watcher

- **Choice**: one `chokidar` watcher per vault over the vault root, `.md` only,
  `ignoreInitial: true`, `awaitWriteFinish` on, every dot-path ignored. Any
  event marks the vault dirty; ~10 s after the last event the vault runs the
  same `reconcileCorpus` pass startup runs. Reconciles never overlap: an event
  arriving during a pass re-arms the flag and the next pass starts when the
  current one ends. A watcher that fails to start, or errors later, logs to
  stderr and leaves the vault on reconcile-on-start — the server keeps serving.
- **Rationale**: reconcile is already hash-truthful and skips unchanged notes on
  `mtime + size`, so a batch costs a scan (~0.09 s) plus ~90 ms per genuinely
  changed note. Reusing it means one code path decides what a change is, and the
  incrementally maintained corpus stays identical to a from-scratch one.
  Ignoring dot-paths is what stops the server's own writes under
  `.neuro-vault/corpus/` from feeding the watcher back into itself.
- **Alternatives**: per-event targeted re-embed — rejected, a second definition
  of "changed" and a second failure surface for renames and deletes; `fs.watch`
  — rejected, duplicate events and rename quirks are the plugin-era bug class we
  are leaving; write-through from the write tools — rejected, the watcher sees
  the server's own writes and a second place that knows about indexing buys
  nothing.

### D7: One process-wide embed queue, with query embeds ahead of indexing

- **Choice**: a single `EmbeddingService` per process, wrapped in a FIFO queue
  with two lanes. Indexing embeds enqueue at the back; query embeds (the
  retrieval path) enqueue at the front. Every vault's indexer receives the same
  queued `EmbedFn`.
- **Rationale**: the ONNX pipeline is one instance; concurrent cold indexes of
  two vaults must not interleave into it, and per-vault queues would still
  collide. Without the priority lane a search issued during a cold index would
  wait behind thousands of queued embeds; with it, it waits for at most the one
  in flight (~25 ms).
- **Alternatives**: strictly sequential per-vault indexing — rejected, it leaves
  the second vault in `indexing` for no reason; no queue at all — rejected,
  unsynchronised re-entry into one pipeline is exactly the failure this design
  cannot debug later; a second model instance for queries — rejected, memory and
  load time.

### D8: `.neuro-vault/config.json` gets one owner

- **Choice**: a single loader parses the file once into
  `{ exclusions?: string[]; semantic?: boolean }`. `loadVaultScope` consumes its
  `exclusions`; the registry consumes its `semantic`. A non-boolean `semantic`
  warns on stderr and is treated as absent (enabled); a missing file, invalid
  JSON or wrong shape behaves exactly as it does today.
- **Rationale**: two independent readers of one file would duplicate the parse,
  the validation and the warning text, and would drift. The existing failure
  posture — warn, fall back to defaults, never fail startup — carries over
  unchanged.
- **Alternatives**: a second, `semantic`-only reader — rejected, two owners of
  one file; a separate config file — rejected, one per-vault config file is the
  convention `unified-vault-scope` established.

### D9: The registry keeps a factory seam and loses its two flags

- **Choice**: `IVaultEntry.corpus` / `semanticAvailable` /
  `semanticUnavailableReason` are replaced by `backend?: SemanticBackend`
  (absent only when the semantic module is globally off, in which case no
  semantic tool is registered to read it). `IVaultEntryDeps.corpusFactory`
  becomes `semanticBackendFactory({ vaultRoot, vaultName, reader, enabled })`,
  returning a started backend. The registry never imports chokidar, the corpus
  store or the embedding service.
- **Rationale**: the flags were a snapshot of a decision taken once — a vault
  that was cold at startup stayed unavailable until the process restarted, which
  is precisely what live promotion abolishes. With the truth changing over time,
  two mirrors of `status()` would go stale in opposite directions. Keeping the factory seam keeps the registry
  synchronous in intent and every test able to hand in a fake backend.
- **Alternatives**: keep the flags in sync with `status()` — rejected, two
  sources of truth; give the registry the concrete lifecycle — rejected, it
  drags a file watcher into a module that maps names to readers.

### D10: The server disposes backends when the transport closes

- **Choice**: the backend exposes `dispose(): Promise<void>` (close the watcher,
  cancel the debounce timer, stop enqueueing). `startNeuroVaultServer` disposes
  every entry's backend when the stdio transport closes, and returns a disposer
  for tests.
- **Rationale**: a live chokidar watcher keeps the event loop alive; without
  this the process outlives its client. This is a new failure mode introduced by
  this slice, so it is designed for rather than discovered.
- **Alternatives**: `process.on('exit')` — rejected, async close cannot run
  there; leaving the handle — rejected, hanging processes.

### D11: The existence check stays, re-anchored

- **Choice**: `filterExisting` keeps guarding every corpus-derived path, and the
  `corpus-staleness-filtering` capability is restated in terms of the own
  corpus.
- **Rationale**: the window shrinks — deletions are picked up within a debounce
  interval instead of whenever the plugin last ran — but it does not close, and
  a path a client cannot open is the same defect regardless of which corpus
  produced it.

### D12: ADR-0014 records the background-freshness decision

- **Choice**: a new ADR covering the in-process watcher, the `chokidar`
  dependency, the debounce, the degradation path, and the narrowed
  "zero infrastructure" claim. ADR-0006 and ADR-0013 are referenced, not edited.
- **Rationale**: ADR-0013 decided that the server _owns_ a corpus; it says
  nothing about the server keeping it fresh in the background, which is what
  costs a dependency and a README promise. (Confirmed with the user,
  2026-08-25.)

### D13: Smart Connections leaves the repo in this change

- **Choice**: absorb #88. Once the server stops wiring
  `createSmartConnectionsCorpusIndex`, delete `smart-connections-loader.ts`,
  `smart-connections-corpus-index.ts`, `smart-connections-types.ts` and their
  tests, `IVaultConfig.smartEnvPath`, the harness's `--backend` axis, and
  `docs/architecture/smart-connections-corpus.md`. ADR-0006 stays as history and
  is marked fully superseded.
- **Rationale**: the gate that would have deferred this is gone. #87 closed with
  parity established on the 20 golden entries the plugin corpus could serve —
  hit@3 identical, MRR within noise, p@3 favouring the own corpus — and the
  remaining 5 permanently unmeasurable, because the plugin migrated its storage
  from `.smart-env/multi/` to `.smart-env/smart_sources/` + `smart_blocks/`,
  which our reader cannot parse. So after the switch nothing reads this code at
  all: not the server, and not the `sc` axis, which cannot load a current
  plugin corpus either. Keeping it would mean carrying dead code, an unread
  `smartEnvPath` through `config.ts` and `types.ts`, and a second sweep of the
  same README and guide pages a week later.
- **The evidence also strengthened the case**: within four weeks the dependency
  broke twice, silently and in unrelated ways — an Obsidian release removed a
  private API the plugin called, then the plugin changed its storage layout.
  Neither surfaced an error; both were caught only by external measurement. Both
  tables and the timeline belong in ADR-0014 as the removal's record.
- **Alternatives**: ship the removal as its own change right after this one —
  rejected, it buys a smaller diff at the cost of a dead-code window and a
  duplicated doc sweep; write an SC 4.7.x parser to complete the 25-entry run —
  rejected, new work inside the component being deleted, with no guarantee the
  next plugin release keeps that format.

## Risks / Trade-offs

- [Risk] The watcher observes the server's own corpus writes and re-triggers
  itself → **Mitigation**: dot-paths are ignored by the watcher, and
  `.neuro-vault/` is already outside vault scope, so a corpus write can neither
  raise an event nor enter a scan.
- [Risk] A cold index makes every search slow while it runs →
  **Mitigation**: the priority lane of D7 bounds a query's wait at one in-flight
  embed; the lexical leg does not touch the model at all.
- [Risk] Two vaults indexing concurrently exhaust memory (peak RSS ~272 MB for
  one) → **Mitigation**: the shared model is loaded once and the embed queue
  serialises the work; snapshots are decoded per vault and rebuilt only on
  change.
- [Risk] chokidar is unreliable on network filesystems → **Mitigation**: an
  unusable watcher is a logged degradation to reconcile-on-start, never a
  startup failure; `neuro-vault-mcp index` remains the deterministic path.
- [Risk] The process no longer exits when the client disconnects →
  **Mitigation**: D10, plus a test that asserts dispose closes the watcher.
- [Risk] A reconcile started at startup outlives a fast client session and
  writes into a vault after the client left → **Mitigation**: dispose stops
  re-arming; the in-flight pass finishes or is abandoned mid-note, and reconcile
  is idempotent — the next run resumes from the shards on disk.
- [Trade-off] First run after upgrade is semantically degraded for minutes on a
  vault that never ran `index` → accepted: the alternative is a client that
  hangs at startup, and the state is now reported rather than silent.
- [Trade-off] `semantic_status` on every payload costs bytes on every response →
  accepted (user's call): an omitted field cannot be told apart from an older
  server.
- [Trade-off] A debounced whole-vault reconcile re-scans the vault per batch
  rather than touching only what changed → accepted: ~0.09 s per batch buys one
  definition of "changed" instead of two.
- [Trade-off] The README can no longer claim "no background processes, no
  watchers" → accepted and restated honestly; no database and no external
  process remain true.

## Migration Plan

Single PR (user's call, 2026-08-25). No deploy step, no data migration:

1. Ship the backend, lifecycle, watcher, contract fields, config key, ADR-0014
   and the doc sweep together.
2. On first start after the upgrade, each vault either serves its existing
   `.neuro-vault/corpus/` immediately or builds one in the background. A user
   who wants no degraded window runs `neuro-vault-mcp index --vault <path>`
   first — unchanged behaviour, now also the documented warm-up.
3. `.smart-env/` is neither read nor written; nothing to undo there.

Rollback: revert the PR. The previous version reads the Smart Connections corpus
again — which on a current plugin means the frozen `.smart-env/multi/` corpus
this change was opened to stop serving, so rollback is a return to a known
defect, not to a working state. `.neuro-vault/corpus/` is inert to the old code
and is picked up again on the next upgrade.

Acceptance: `npm test`, `npm run lint` and `npm run typecheck` clean; the new
capability's scenarios covered by tests; `rg -i "smart.connections|smart-env"`
over `src/`, `eval/`, `test/`, `README.md` and `docs/` returning only ADR-0006
and the ADR index row that marks it superseded.

## Open Questions

None blocking. Two settled-by-default values, recorded so a later change can
revisit them rather than rediscover them:

- The debounce is ~10 s, hardcoded. It is deliberately not a config knob until
  someone reports a vault where it is wrong.
- `status()` reports `indexed`/`total` as `0/0` between process start and the
  first progress tick, because the total is only known after the scan. #103 owns
  anything richer.
