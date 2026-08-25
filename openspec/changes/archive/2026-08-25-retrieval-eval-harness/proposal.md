# Proposal — retrieval-eval-harness

## Why

Ranking changes are currently judged by anecdote — a few hand-run queries.
Two consumers now need real measurement: the diagnostic parity run (#87) that
gates deleting Smart Connections ("own corpus at least not worse"), and RRF
weight re-tuning (expansion weight, adaptive k, pools were hand-picked).
A repeatable harness — golden queries scored against the ranking pipeline as
a library — turns both into mechanical comparisons of JSON reports.

## What Changes

- New `eval/` directory: a local runner invoked as
  `npm run eval -- --vault <path> --pipeline semantic|fused --backend sc|own`.
  No MCP, no running server — the ranking pipeline is imported directly.
- Golden set convention: `<vault>/.neuro-vault/eval/golden.yaml` (YAML,
  binary relevant sets, `lang` slices), committed to the vault's git;
  auto-excluded from indexing by the dot-path scope rule. The runner
  validates every `relevant` path at startup and exits non-zero on broken
  entries.
- Two orthogonal run axes: `--pipeline` (ranking method: pure semantic vs
  RRF-fused) × `--backend` (vector source: Smart Connections `.smart-env` vs
  own `.neuro-vault/corpus/` shards). The `sc` backend and the flag's `sc`
  value are removed together with Smart Connections (#88).
- Metrics precision@3 / MRR / hit@3, sliced overall / UA / EN, computed over
  threshold-0 top-10 rankings (positions only — cross-model comparable).
- JSON report per run in gitignored `eval/results/`: code git SHA, vault git
  SHA, model id, pipeline, backend, full run config, per-query ranks.
- Repo wiring: `"eval"` npm script (tsx), `eval` in tsconfig `include`
  (typecheck + type-aware lint cover it), `eval/results/` gitignored.

Out of scope: golden-set curation (#86), the parity run itself (#87), serving
live search from the own corpus (#85), a `reranked` pipeline, CI runs.

## Capabilities

### New Capabilities

- `retrieval-eval`: the offline evaluation harness — golden-set contract
  (location, schema, startup validation), run axes (`--pipeline` ×
  `--backend`), scoring rules (threshold-0 top-10, precision@3 / MRR /
  hit@3, language slices), and the comparable-report contract (code SHA,
  vault SHA, model id, config; paired comparability iff vault SHAs match).

### Modified Capabilities

_None. No MCP tool contract, server behaviour, or existing capability
requirement changes — the harness only imports production modules._

## Impact

- **Code**: new `eval/` (runner, backends adapter, pipelines glue, metrics,
  report); new `test/eval/` suites. No `src/` changes.
- **Config**: `package.json` (script), `tsconfig.json` (`include`),
  `.gitignore` (`eval/results/`).
- **Dependencies**: none new — `yaml` and `tsx` already present.
- **Systems**: reads a vault and its corpora (`.smart-env` for `sc`,
  `.neuro-vault/corpus/` for `own`); writes only `eval/results/`.
- **Issues**: implements #84; unblocks #87 (parity run) and #86 curation
  targets; `--backend sc` scheduled for removal with #88.
