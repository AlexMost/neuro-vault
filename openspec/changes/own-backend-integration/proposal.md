Tracked by: #85, #88

## Why

The server owns an embedding corpus but does not serve from it. Every semantic
call still reads a Smart Connections corpus from `.smart-env/multi` — a layout
current plugin versions no longer write — so `search_notes`, `get_similar_notes`
and `find_duplicates` rank against a frozen index today, silently, and say
nothing about it. The corpus that would fix this is already built, already
reconciled, and already ranked against by the eval harness; only the server's
wiring is missing.

Serving from it also ends the dependency on an Obsidian installation and its
plugins, and makes semantic membership the same set the lexical leg sees. It
unblocks the removal of the Smart Connections code path (#88) and the freshness
signalling built on top of it (#103).

## What Changes

**Corpus the server serves**

- From: `VaultRegistry.create` loads a Smart Connections corpus per vault; a
  vault without one gets `semanticAvailable: false` forever.
- To: each vault entry holds a `SemanticBackend` over its own corpus
  (`.neuro-vault/corpus/`). No fallback, no backend-selection flag.
- Reason: the inherited corpus is stale, unwatched, and scoped by the plugin's
  own rules.
- Impact: breaking for anyone who relied on the plugin's corpus being the source
  — single-user project, no migration shims.

**Cold start**

- From: semantic availability is decided once at startup; a missing corpus means
  degraded-forever until restart.
- To: startup never blocks. A missing or incompatible corpus is built in the
  background and the finished index is promoted live, per vault, without a
  restart. Startup runs a reconcile so an existing corpus catches up.
- Impact: first run on a fresh vault answers `search_notes` from the lexical leg
  for the duration of the build.

**`search_notes` output contract**

- From: no statement about the semantic leg; a vault with no corpus silently
  returns lexical-only matches.
- To: every per-vault payload carries `semantic_status: { state, indexed?,
total? }` with `state` one of `ready | indexing | disabled | unavailable`.
- Impact: additive field, always present.

**Error codes for the embeddings-only tools**

- From: `SEMANTIC_INDEX_NOT_FOUND`, whose hint names Obsidian and Smart
  Connections.
- To: `SEMANTIC_INDEX_BUILDING` (with `{ indexed, total }`) while the index is
  building, `SEMANTIC_DISABLED` when the vault turned semantics off, and a
  rewritten `SEMANTIC_INDEX_NOT_FOUND` hint that names the CLI index command
  instead of the plugin.
- Impact: new codes clients may branch on; the old code keeps its meaning
  (corpus genuinely unavailable) with new wording.

**Freshness**

- New: an in-process file watcher per vault (chokidar, ~10 s debounce,
  `awaitWriteFinish`) reconciles changed notes. A watcher that fails to start or
  dies degrades to reconcile-on-start and logs; the server survives.
- The Smart Connections per-call directory-signature staleness check does not
  carry over to the own backend.

**Per-vault opt-out**

- New: `"semantic": false` in a vault's `.neuro-vault/config.json` — no
  indexing, no watcher, nothing written under `.neuro-vault/corpus/`; lexical
  works; status reports `disabled`; the two embeddings-only tools return
  `SEMANTIC_DISABLED`. The global `--no-semantic` flag still wins over it.

**Smart Connections leaves the repo**

- From: the loader and corpus index sit behind the server's semantic path, and
  the eval harness carries an `sc`/`own` backend axis.
- To: `smart-connections-loader.ts`, `smart-connections-corpus-index.ts`,
  `smart-connections-types.ts`, their tests, `IVaultConfig.smartEnvPath`, the
  harness's `--backend` axis and `docs/architecture/smart-connections-corpus.md`
  are deleted. ADR-0006 stays as history, marked fully superseded.
- Reason: the gate that deferred this — the diagnostic parity run — was met and
  closed (#87): equivalent ranking on all 20 golden entries the plugin corpus
  could serve, and the remaining 5 permanently unmeasurable because the plugin
  migrated its storage layout out from under our reader. Once the server stops
  wiring it, nothing reads this code: the `sc` axis cannot load a current
  plugin corpus either. Deleting it in the same change avoids a dead-code
  window and a second sweep of the same docs.
- Impact: the repo stops depending on Obsidian and its plugins entirely;
  `.smart-env/` is never read again.

**Docs**

- The README's "Zero infrastructure — no background processes, no watchers"
  claim is restated honestly rather than deleted, and every Smart Connections
  mention across `README.md` and `docs/` (including `docs/guide/`) is removed
  rather than left as history.
- A new ADR records the background-freshness decision and its runtime
  dependency, and carries the parity numbers and failure timeline from #87 as
  the evidence for the removal.

Out of scope: reporting staleness or drift of a built index (#103), and
upgrading the embedding model (#98).

## Capabilities

### New Capabilities

- `semantic-backend-lifecycle`: what a semantic backend is, which corpus a vault
  serves from, how a vault gets from "no index" to "serving" without a restart,
  how freshness is maintained, how each state is reported to a client, and how a
  vault opts out.

### Modified Capabilities

- `hybrid-search`: `search_notes` per-vault payload gains an always-present
  `semantic_status`; the existing degradation requirements gain the state that
  explains them.
- `corpus-staleness-filtering`: the existence check is re-anchored to the own
  corpus — it survives, because a note deleted inside the debounce window is
  still a corpus path that must not reach a client.
- `retrieval-eval`: the `--backend` axis is gone; the harness loads the own
  corpus and records one less identity field.

## Impact

- **Code**: `src/lib/vault-registry.ts` (entry shape, per-vault backend and
  lifecycle), new backend + watcher + lifecycle modules under
  `src/modules/semantic/`, a corpus-backed `SemanticBackend` promoted from
  `eval/backends.ts`, `src/lib/resolve-vault.ts` (new codes),
  `src/modules/semantic/tools/*` (status field, error branches),
  `src/server.ts` (wiring, shutdown), `src/lib/obsidian/vault-scope-config.ts`
  or a sibling (the `"semantic"` key).
- **Deleted**: `src/lib/obsidian/smart-connections-loader.ts`,
  `smart-connections-corpus-index.ts`, `smart-connections-types.ts` and their
  tests; `smartEnvPath` from `src/config.ts` and `src/types.ts`; the `sc`
  branch of `eval/backends.ts` and the `--backend` axis of `eval/run.ts`;
  `docs/architecture/smart-connections-corpus.md`.
- **Dependencies**: adds `chokidar` (runtime).
- **Contracts**: `search_notes` output shape; two new error codes; one rewritten
  hint; one new per-vault config key.
- **Smart Connections leaves the repo**

- From: the loader and corpus index sit behind the server's semantic path, and
  the eval harness carries an `sc`/`own` backend axis.
- To: `smart-connections-loader.ts`, `smart-connections-corpus-index.ts`,
  `smart-connections-types.ts`, their tests, `IVaultConfig.smartEnvPath`, the
  harness's `--backend` axis and `docs/architecture/smart-connections-corpus.md`
  are deleted. ADR-0006 stays as history, marked fully superseded.
- Reason: the gate that deferred this — the diagnostic parity run — was met and
  closed (#87): equivalent ranking on all 20 golden entries the plugin corpus
  could serve, and the remaining 5 permanently unmeasurable because the plugin
  migrated its storage layout out from under our reader. Once the server stops
  wiring it, nothing reads this code: the `sc` axis cannot load a current
  plugin corpus either. Deleting it in the same change avoids a dead-code
  window and a second sweep of the same docs.
- Impact: the repo stops depending on Obsidian and its plugins entirely;
  `.smart-env/` is never read again.

**Docs**: new ADR, `docs/architecture/own-corpus.md` (lifecycle),
`docs/architecture/vault-registry.md`, `docs/architecture/mcp-server-shape.md`,
README and `docs/guide/`.

- **Not touched**: ranking, fusion, retrieval policy, and the extraction and
  storage layers.
