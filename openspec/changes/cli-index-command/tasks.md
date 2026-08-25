Delivery is one PR (`Closes #83`). **Apply gate: do not start before
`own-corpus-indexer` PR 2 (reconcile, groups 7–9 of its tasks) is merged to
`main`** — this slice wraps `reconcileCorpus` and must build against the merged
interface, not the in-flight worktree.

## 1. Command parsing and dispatch [sequential, do first]

- [x] 1.1 Failing test → implementation: restructure `parseConfig` around
  yargs `.command()` — the server invocation becomes the default command
  (`$0`) and `index` becomes a subcommand; `ParsedCli` gains
  `{ kind: 'index', options: IndexCliOptions }` (vault configs list). Update
  the `src/cli.ts` dispatch in the same task — the variant and its call site
  ship together.
- [x] 1.2 Failing test → implementation: `index --vault` reuses
  `buildVaultConfig` unchanged — absolute-path requirement, basename
  identifier rules, case-insensitive uniqueness, repeatability — and a missing
  `--vault` on `index` exits non-zero naming the option (spec: "The index
  subcommand's vault option matches server semantics").
- [x] 1.3 Test: every existing `cli-startup-flags` scenario still holds under
  the command restructure — `--help` and `--version` short-circuit with exit 0
  and no transport, a plain `--vault` invocation still resolves to
  `kind: 'run'`, and `index --help` prints the subcommand's help cleanly.

## 2. Index runner [sequential, needs 1]

- [x] 2.1 Failing test → implementation: `runIndexCommand(options, deps)` in a
  new `src/cli-index.ts` — per vault, wire `loadVaultScope` →
  `FsVaultReader.scan`, `node:fs` `stat`/`readFile` as `stat`/`readNote`,
  a single shared `EmbeddingService` (server model defaults) as `embed`, and
  `CorpusStore` on `<vault>/.neuro-vault/corpus/`, then call
  `reconcileCorpus`. Vaults run sequentially in argument order. Inject
  reconcile/embedding fakes in tests; no real model load in the suite.
- [x] 2.2 Failing test → implementation: progress rendering — TTY: one
  in-place `\r` line per vault (`indexing <vault>: <indexed>/<total>`);
  non-TTY: a line per 10%-step at most; both driven by the `onProgress`
  callback (spec: "Progress and summary are reported on stdout").
- [x] 2.3 Failing test → implementation: per-vault summary line printed on
  completion with all six `ReconcileSummary` counts, and warnings left on
  stderr.
- [x] 2.4 Failing test → implementation: exit-code contract — 0 only when
  every vault's `failed === 0`; a `failed > 0` summary or a thrown fatal error
  → non-zero, with completed vaults' summaries still printed and the fatal
  message on stderr (spec: "The exit code reflects corpus completeness").
- [x] 2.5 Test: the runner constructs no MCP server and connects no transport
  — assert the server module is never touched by the `index` path (spec: "No
  server surface is touched").

## 3. Real-vault sanity check [sequential, needs 2]

- [x] 3.1 Outside the test suite: run `npm run dev -- index --vault <real vault>`
  cold, then immediately again; record wall-clock, vector count, and the
  second run's all-reused summary plus both exit codes in the PR body.

## 4. Gates and delivery [sequential]

- [x] 4.1 `npm test`, `npm run lint`, `npm run typecheck`,
  `npx openspec validate --all` all green; paste the output in the PR body.
- [x] 4.2 Confirm the slice stayed thin: no MCP tool contract change, no
  watcher, no new runtime dependency, no README/docs infrastructure-promise
  edits (those belong to slice #5).
- [ ] 4.3 Open the PR (`Closes #83`), then run `/opsx:verify` before
  archiving.
