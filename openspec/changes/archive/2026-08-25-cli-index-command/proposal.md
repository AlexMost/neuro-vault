## Why

The own-corpus indexer (change `own-corpus-indexer`, issue #82) lands as an
internal function with no way to invoke it: nothing outside the test suite can
build or refresh `.neuro-vault/corpus/`. The eval harness (slice #4, issue #84)
needs a deterministic reindex before every run, and users need warm-up before
first client start plus a diagnostic entry point. Map ticket 06 resolved this
fog point: a thin CLI wrapper, now — it blocks the harness slice.

## What Changes

- New CLI subcommand: `neuro-vault-mcp index --vault <path> [--vault <path> …]`
  runs a corpus reconcile for each named vault and exits — no MCP server, no
  stdio transport, no watcher.
- The subcommand is a thin wrapper over `reconcileCorpus` from
  `src/lib/obsidian/corpus/`: scope, hashing, rename detection, and failure
  containment all stay in the internal function.
- Progress is written to stdout (in-place line on a TTY, 10%-step lines
  otherwise) and each vault ends with a summary line of the
  `ReconcileSummary` counts.
- Exit code contract: `0` only when every vault reconciled with zero failed
  notes; any contained per-note failure or fatal error exits `1`.
- Argument parsing gains yargs command structure: the server remains the
  default command (`$0`), so `neuro-vault-mcp --vault <path>` behaves exactly
  as today; `ParsedCli` gains an `index` variant dispatched in `src/cli.ts`.

## Capabilities

### New Capabilities

- `cli-index-command`: the on-demand indexing subcommand — its argument
  surface, progress/summary output, exit-code contract, and its equivalence
  guarantee (the corpus it produces is the same one the internal reconcile
  produces; the CLI adds no indexing logic).

### Modified Capabilities

_None. `cli-startup-flags` requirements (`--version`, `--help`, clean
parser-satisfied exits) keep holding unchanged under the new command
structure; no existing requirement's behavior changes._

## Impact

- **Code**: `src/config.ts` (yargs `.command()` structure, `ParsedCli` third
  variant), `src/cli.ts` (dispatch), new `src/cli-index.ts` (or sibling)
  wiring `loadVaultScope` + `FsVaultReader` + `EmbeddingService` +
  `CorpusStore` + `reconcileCorpus`; tests for parsing and the command runner.
- **Dependencies (ordering)**: blocked by `own-corpus-indexer` PR 2
  (`reconcileCorpus`, groups 7–9 of its tasks) — currently in flight. Blocks
  `retrieval-eval-harness` (#84). Tracking issue: #83 (`Closes #83` on the
  final PR).
- **No MCP tool contract changes**, no new runtime dependencies, no watcher,
  no README infrastructure-promise change (that text moves with slice #5).
