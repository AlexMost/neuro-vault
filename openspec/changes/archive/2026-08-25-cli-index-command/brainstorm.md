<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — cli-index-command

**Path classification: bounded.** The flow being changed exists in the repo
(`src/cli.ts` → `parseConfig` → `startNeuroVaultServer`), the internal function
being wrapped exists (`reconcileCorpus`, own-corpus-indexer PR 2), and every
design fork above the wiring level was already closed by the wayfinder map at
`.scratch/own-embedding-pipeline/` (tickets 06 and 09) and confirmed by issue
[#83](https://github.com/AlexMost/neuro-vault/issues/83). The user's
`/opsx:propose` invocation is the promotion approval; this capture records the
imported decisions and the wiring-level questions resolved during proposal.

## Background

- Slice #3 of the own-embedding-pipeline effort (map ticket 09 queue:
  `unified-vault-scope` → `own-corpus-indexer` → **`cli-index-command`** →
  `retrieval-eval-harness` → parity run → `remove-smart-connections`;
  `own-backend-integration` is a parallel branch).
- Map ticket 06 closed the fog point: CLI command — **yes**, a thin wrapper
  over the same internal indexing function the server will use, progress on
  stdout. Consumers: the eval harness (deterministic reindex, slice #4),
  warm-up before first client start, diagnostics.
- Issue #83 scope line: `neuro-vault index --vault <path>`, progress on stdout.
- Depends on own-corpus-indexer PR 2 (`reconcileCorpus` + `ReconcileSummary` +
  `onProgress` — groups 7–9 of that change's tasks), currently in flight in the
  `own-corpus-indexer-pr2` worktree. This change cannot be applied before that
  PR merges; proposing it now is fine.

## Decisions imported from the map (not re-litigated)

- Thin wrapper: the CLI adds no indexing logic of its own — membership,
  hashing, rename detection, failure containment all live in `reconcileCorpus`
  (ticket 06, slicing 09 §3).
- Progress goes to **stdout** (ticket 06). Unlike the MCP server mode, stdout
  is not a protocol transport here — this is the one mode where stdout is ours.
- Small slice: no watcher, no server integration, no backend promotion — those
  are slice #5 (`own-backend-integration`).

## Decision chain (wiring level, resolved now)

**Q1 — command surface.** The published bin is `neuro-vault-mcp`
(package.json `bin`), not `neuro-vault`. The map's `neuro-vault index` is
shorthand. → **`neuro-vault-mcp index --vault <path>`**; no second bin alias
(a new bin name is a distribution-contract change this slice doesn't need).

**Q2 — argv structure.** `parseConfig` today is flat yargs with `.strict()`
and a `ParsedCli = run | handled` result. → Add a yargs
`.command('index', …)` with the server as the default command (`$0`);
`ParsedCli` grows a third variant `{ kind: 'index', options: IndexCliOptions }`.
`src/cli.ts` dispatches on the variant. `--vault` keeps the exact
existing semantics (array, absolute-path validation, basename identifier
rules) — one concept, one parameter name, same validation both modes.

**Q3 — multi-vault.** The server accepts repeated `--vault`; the index command
accepts the same and reconciles each vault **sequentially** (one shared
`EmbeddingService`/ONNX instance, mirroring the map's global-embed-queue
decision for slice #5). Per-vault progress and per-vault summary.

**Q4 — progress format.** Human-readable, not machine-parseable: the harness
consumer needs determinism and the exit code, not parseable progress. When
stdout is a TTY, a single in-place line (`\r`) per vault
(`indexing <vault>: 137/832`); when not a TTY (CI, harness), a line at every
10% step. Final per-vault summary line always printed:
`embedded/reused/renamed/deleted/failed/total` counts from `ReconcileSummary`.

**Q5 — exit code.** `0` only if every vault reconciled with `failed === 0`.
Any contained per-note failure (`failed > 0`) or any fatal error → exit `1`
(summary still printed; fatal error message on stderr). Rationale: the
harness's "deterministic reindex" promise is broken by silently-skipped notes,
so partial failure must be visible in the exit code.

**Q6 — what `index` ignores.** `--no-semantic` applies to the server mode only
(it gates tool registration); `index`'s whole purpose is embedding, so the
flag is rejected-by-strictness rather than silently accepted on the
subcommand. Per-vault `"semantic": false` config arrives with slice #5 and is
out of scope here — noted as a forward obligation on that change (its config
should also gate `index`).

**Q7 — wiring.** The command reuses the server's seams, no new abstractions:
`loadVaultScope(vaultRoot)` → `new FsVaultReader({ vaultRoot, scope })` for
scoped `scan()`, `node:fs/promises` `stat`/`readFile` for `stat`/`readNote`,
`new EmbeddingService()` (same `MODEL_KEY`/model id defaults as the server)
for `embed`, `CorpusStore` for storage. Warnings from reconcile go to stderr
(its default), progress to stdout.

## YAGNI — considered and dropped

- `--force` / full-rebuild flag: manifest incompatibility already triggers a
  rebuild; deleting `.neuro-vault/corpus/` covers the manual case. Add later
  if a real consumer asks.
- JSON output mode: no consumer parses progress today (harness reads the
  corpus, not the CLI output).
- Concurrency / worker pool: embedding is the bottleneck and is serial ONNX;
  measured full reindex ≈ 1.5 min (map ticket 03) — fast enough.
- Watch mode: that is the server watcher, slice #5.

## Acceptance criteria

- `npm test && npm run lint && npm run typecheck` and
  `npx openspec validate --all` pass.
- `neuro-vault-mcp index --vault <abs-path>` cold-indexes a vault, prints
  progress and a summary, exits 0; an immediate second run reports all-reused,
  changes nothing, exits 0.
- `--help` on both the root and the `index` subcommand documents the surface;
  server mode behaviour is unchanged.
