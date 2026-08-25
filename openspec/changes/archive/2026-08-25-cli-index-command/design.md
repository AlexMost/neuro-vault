## Context

Slice #3 of the own-embedding-pipeline effort (wayfinder map,
`.scratch/own-embedding-pipeline/`, tickets 06 + 09; issue #83). Change
`own-corpus-indexer` delivers `reconcileCorpus(deps, opts)` — an internal,
dependency-injected function that brings `.neuro-vault/corpus/` into agreement
with a vault, reporting `{ indexed, total }` progress and returning a
`ReconcileSummary` (`total/embedded/reused/renamed/deleted/failed`). Nothing
invokes it outside tests.

The CLI entry today (`src/cli.ts` → `parseConfig` in `src/config.ts`) is a
flat yargs parser producing `ParsedCli = { kind: 'run' | 'handled' }` and
always starts the MCP server. The published bin is `neuro-vault-mcp`
(package.json), consumed via `npx`.

Consumers of this slice: the retrieval eval harness (slice #4 — deterministic
reindex before a run), warm-up before first client start, and diagnostics.

Constraints: server-mode stdout is the MCP transport and must stay untouched;
`--vault` semantics are part of the MCP parameter dictionary discipline (one
concept, one name, one validation); no new runtime dependencies.

## Goals / Non-Goals

**Goals:**

- `neuro-vault-mcp index --vault <path>` (repeatable) reconciles each vault's
  corpus on demand, with progress on stdout and a per-vault summary.
- Exit code truthfully reflects completeness: `0` ⇔ every note in every vault
  is indexed (`failed === 0` everywhere).
- Server mode behaviour is byte-for-byte unchanged, including `--help` /
  `--version` short-circuits (capability `cli-startup-flags`).

**Non-Goals:**

- No server integration, backend promotion, or watcher — slice #5
  (`own-backend-integration`).
- No `--force` rebuild flag, no JSON/machine-readable output, no concurrency
  controls (YAGNI; see brainstorm).
- No handling of per-vault `"semantic": false` config — that key arrives with
  slice #5, which takes the obligation to gate `index` on it.
- No second bin name.

## Decisions

### D1: Subcommand under the existing bin, server stays the default command

- **Choice**: `neuro-vault-mcp index …` via yargs `.command()`, with the
  server as the default command (`$0`). `parseConfig` returns a third variant
  `{ kind: 'index', options: IndexCliOptions }`; `src/cli.ts` dispatches.
- **Why**: issue #83's `neuro-vault index` is shorthand — the published bin is
  `neuro-vault-mcp`, and adding a bin alias is a distribution-contract change
  this slice doesn't need. Keeping the server as `$0` makes the change
  invisible to every existing MCP client config.
- **Alternatives**: a separate bin/entry file (`neuro-vault-index`) — rejected:
  two bins to document and version for one small command; a `--index` boolean
  flag — rejected: modes with different required options and different
  lifecycles are commands, not flags.

### D2: `--vault` reuses server semantics exactly

- **Choice**: same option name, array form, absolute-path requirement,
  basename-identifier validation and case-insensitive uniqueness as server
  mode, via the same `buildVaultConfig` code path.
- **Why**: parameter-dictionary discipline (ADR-0005 applies in spirit to the
  CLI surface); users copy `--vault` between the two invocations.
- **Alternatives**: positional vault path — rejected: diverges from server
  syntax for zero gain.

### D3: Thin wrapper wiring mirrors the server's seams

- **Choice**: per vault — `loadVaultScope(vaultRoot)` →
  `new FsVaultReader({ vaultRoot, scope })` for scoped `scan()`;
  `node:fs` promises for `stat`/`readNote`; one shared `EmbeddingService`
  (same model defaults as server mode) for `embed`; `CorpusStore` on
  `<vault>/.neuro-vault/corpus/`; call `reconcileCorpus`. Multiple vaults run
  **sequentially**.
- **Why**: the CLI must produce the identical corpus the server-side reconcile
  (slice #5) will produce — same scope module, same store, same embed path.
  Sequential vaults mirror the map's one-ONNX-instance global-queue decision.
- **Alternatives**: new orchestration module shared with slice #5 — premature;
  slice #5 generalizes when it lands. Parallel vaults — the embedder is the
  serial bottleneck, parallelism buys nothing.

### D4: Progress on stdout, shaped by TTY

- **Choice**: TTY → one in-place (`\r`) line per vault
  (`indexing <vault>: <indexed>/<total>`); non-TTY → a line at each 10% step.
  Always a final per-vault summary line with the six `ReconcileSummary`
  counts. Reconcile warnings keep their default stderr channel.
- **Why**: ticket 06 fixed "progress on stdout"; `index` mode owns stdout (no
  MCP transport). 3,500-vector vaults would spray thousands of lines into CI
  logs without the non-TTY step filter.
- **Alternatives**: machine-readable JSON progress — no consumer parses it
  (the harness reads the corpus and the exit code); silent-until-summary —
  a 1.5-minute cold index with no output reads as a hang.

### D5: Exit code `0` means complete

- **Choice**: exit `0` only when every vault's summary has `failed === 0`;
  otherwise `1` (summaries still print; fatal errors also print to stderr).
- **Why**: the harness's deterministic-reindex guarantee is void if notes were
  silently skipped; reconcile contains per-note failures by design, so the
  exit code is the only place the CLI can surface them.
- **Alternatives**: `0` with failures noted in the summary — hides partial
  corpora from scripts; distinct codes per failure kind — no consumer.

## Risks / Trade-offs

- [Risk] `reconcileCorpus`'s final surface may drift while own-corpus-indexer
  PR 2 is in review → Mitigation: this change is blocked on that PR's merge;
  tasks reference the merged interface, and apply starts only after it lands.
- [Risk] yargs default-command restructuring could disturb the
  `cli-startup-flags` behaviours (`--help`/`--version` short-circuit paths) →
  Mitigation: the existing spec scenarios are already covered by tests; they
  gate the refactor. New tests assert `index --help` too.
- [Trade-off] Sequential multi-vault indexing is slower than interleaving →
  accepted: the embedder is serial anyway; simplicity wins.
- [Trade-off] No machine-readable output ties scripts to the exit code only →
  accepted: that is the only contract consumers asked for; JSON can be added
  additively later.

## Migration Plan

N/A — no deployment change. Ships as a minor release of the npm package; the
new subcommand is additive and server mode is untouched. Rollback = releasing
without the subcommand. Acceptance: `npm test`, `npm run lint`,
`npm run typecheck`, `npx openspec validate --all` green; manual cold index +
idempotent second run against the real vault recorded in the PR body.

## Open Questions

_None blocking. One forward obligation recorded for slice #5
(`own-backend-integration`): when per-vault `"semantic": false` config lands,
`index` must respect it (skip the vault with an explicit message)._
