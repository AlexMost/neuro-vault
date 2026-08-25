# ADR-0014 — Background corpus freshness, and the removal it enabled

- **Status**: Accepted
- **Date**: 2026-08-25

## Context

[ADR-0013](0013-own-embedding-corpus.md) decided that the server builds and owns its embedding corpus under `<vault>/.neuro-vault/corpus/`, reconciled incrementally against content hashes. It said nothing about keeping that corpus fresh once the server is running: reconcile has a caller only at startup and from `neuro-vault-mcp index`. Left there, the corpus goes stale the moment a note changes after boot, and the only ways to catch up are a stale index until the next restart, or blocking every call on an on-demand reconcile pass that costs a scan plus embeds for whatever changed.

The corpus this ADR keeps fresh is also, as of this change, the only corpus the server reads: [ADR-0006](0006-smart-connections-corpus.md)'s read-only consumption of the Smart Connections plugin's index is retired (see Decision below), so what used to be "for free" background freshness supplied by another process is now this server's own obligation.

## Decision

Each vault entry runs one in-process `chokidar` watcher over its vault root, `.md` files only, ignoring every dot-path so the server's own writes under `.neuro-vault/corpus/` cannot feed the watcher back into itself. Any add/change/unlink event marks the vault dirty; ~10 s after the last event (`DEBOUNCE_MS` in `src/modules/semantic/backend/vault-watcher.ts`) the vault runs the same whole-vault `reconcileCorpus` pass that startup runs — one definition of "changed," reused rather than duplicated. Reconciles never overlap: an event arriving mid-pass re-arms the debounce rather than starting a second pass, and the next pass runs when the current one ends.

`chokidar` is a runtime dependency (`package.json` `dependencies`), not a dev dependency — every install pays for it. At the major version pinned here (`^4.0.3`) it carries exactly one dependency of its own, `readdirp`, pure JavaScript with no native binary; it does not compile on install and ships no platform artifact, so `npx` distribution (ADR-0013's constraint) is unaffected.

A watcher that fails to start, or that reports an error once running, degrades rather than fails: `startVaultWatcher` logs the failure to stderr and leaves that vault on reconcile-on-start — whatever it built at boot, or the next explicit `neuro-vault-mcp index` run. The server keeps serving every other vault normally; a broken watcher is never a startup failure.

Because the watcher's `chokidar.watch()` handle keeps the Node event loop alive, the server now must release it: `dispose()` on the assembled backend (`src/modules/semantic/backend/index.ts`) closes the watcher before disposing the underlying corpus lifecycle, and `startNeuroVaultServer` (`src/server.ts`) calls every vault's `dispose()` when the stdio transport's `onclose` fires, so the process still exits when its client disconnects.

Smart Connections leaves the repo in the same change. Once the server stops wiring the plugin's read-only corpus, nothing reads that code path at all, so it is deleted rather than kept dead: `smart-connections-loader.ts`, `smart-connections-corpus-index.ts`, `smart-connections-types.ts` and their tests, `IVaultConfig.smartEnvPath`, the eval harness's `--backend` axis, and `docs/architecture/smart-connections-corpus.md`. [ADR-0006](0006-smart-connections-corpus.md) stays as history, marked fully superseded.

The evidence for that removal is recorded here because there is no other change to hold it:

- **Parity.** The retrieval-eval harness (`eval/`) ran both backends against the same golden query set. Of the 25 golden entries, 20 could still be answered by the plugin corpus; on those 20, hit@3 was identical between the two backends, MRR was within noise, and p@3 favoured the own corpus. The remaining 5 are permanently unmeasurable against the plugin backend — not merely stale — because the plugin migrated its on-disk storage from `.smart-env/multi/` to `.smart-env/smart_sources/` + `smart_blocks/`, a format this repo's reader was never written to parse.
- **A four-week failure timeline.** Within four weeks of that measurement, the Smart Connections dependency broke twice, both times silently: an Obsidian release removed a private API the plugin called, and separately the plugin changed its storage layout (the same migration that stranded the 5 unmeasurable golden entries above). Neither failure surfaced as an error anywhere the server could observe; both were caught only by external measurement, not by anything the read-only consumer itself could detect.

## Consequences

- The README's "no background processes, no watchers" half of its zero-infrastructure claim is retired — it was true only while the plugin, not this server, did the watching. What remains true, and is now the claim this repo makes: no database, and no external process. The watcher is an in-process, in-memory timer and filesystem listener; it starts no subprocess and opens no network or database connection.
- The server now holds a handle — the chokidar watcher — that it must explicitly release. `dispose()` and the `onclose` wiring in `src/server.ts` exist because of this decision, not as pre-existing plumbing; a server that forgot to close the watcher would outlive the client that started it.
- Corpus freshness is now entirely the server's own responsibility, with a bounded degradation path: a watcher failure is a logged fallback to whatever reconcile-on-start already produces, never a hang and never a crash.
- The Smart Connections plugin dependency is gone from the codebase: no `smart-env` parsing, no `--backend` axis in the eval harness, no `smartEnvPath` config field. `neuro-vault-mcp index --vault <path>` is the one deterministic, on-demand way to build or refresh a corpus outside the watcher's debounce window.

## Alternatives considered

- **`fs.watch` directly** — no dependency at all, but duplicate events and platform-specific rename quirks are exactly the bug class the Smart Connections plugin's own watcher-adjacent staleness problems belonged to; `chokidar` exists to normalize this.
- **Per-call staleness checks** (stat the vault, or specific paths, on every semantic call) — pushes the reconcile cost onto the request path instead of a background debounce, and still needs a definition of "changed" independent of the one reconcile already has.
- **Write-through from the write tools** (`edit_note`, `create_note`, …) — the watcher would still need to see edits made outside this server (Obsidian itself, another tool, sync), so write-through would be a second, narrower "changed" detector layered on top of the one this ADR keeps, not a replacement for it.
- **Polling** — no filesystem event dependency, but the interval is a knob to tune per vault size and OS, trading one dependency for a different, worse one (either wasted CPU or added latency); `chokidar`'s `awaitWriteFinish` already handles the case polling is usually reached for (partial/chunked writes).
