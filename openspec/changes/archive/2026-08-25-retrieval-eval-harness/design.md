# Design — retrieval-eval-harness

## Context

Ranking changes in this repo (RRF fusion 14.0.0, weighted expansion 15.0.0,
threshold split) have been judged by hand-run queries. The own-embedding
effort makes that untenable: the diagnostic parity run (#87) must show the
own corpus is "at least not worse" than Smart Connections before the SC code
is deleted (#88), and every later `embed_version` bump (model upgrade #98,
better note-vector strategies) needs the same judgement. The second customer
is RRF weight tuning: `EXPANSION_WEIGHT`, adaptive `k`, and leg pools were
hand-picked and can only be re-tuned against measured data.

Current state: slices #1–#3 of the effort queue have shipped —
`VaultScope` governs membership (15.4.0), the own corpus is built and
reconciled by `src/lib/obsidian/corpus/` (#96/#97), and
`neuro-vault-mcp index` builds it from the CLI (#100). The production search
path (`search_notes`) composes importable pieces: `executeRetrieval`
(semantic leg), `LexicalIndex.search` (lexical leg), `flattenExpansion` +
`fuseRanks` (fusion). `own-backend-integration` (#85) — serving live search
from the own corpus — has NOT landed and proceeds in parallel.

Constraints:

- The runner must not need MCP or a running server — it imports the ranking
  pipeline as a library (`(query) => ranked note paths`).
- The golden set is private vault data; the repo carries only synthetic
  fixtures.
- Harness code passes the standard gates (`npm test`, `eslint .`,
  `tsc --noEmit`) but the runner itself never runs in CI (needs a live vault
  and a built corpus).
- Decisions inherited from the wayfinder map and issue #84 are fixed inputs
  (see brainstorm.md provenance); this design does not re-open them.

## Goals / Non-Goals

**Goals:**

- A local command that scores a ranking pipeline against a golden set and
  writes a comparable JSON report: `npm run eval -- --vault <path>
  --pipeline semantic|fused --backend sc|own`.
- Two orthogonal axes: `--pipeline` (ranking method) × `--backend` (vector
  source). Both recorded in the report.
- Metrics: precision@3, MRR, hit@3; slices overall / UA / EN.
- Reports carry code git SHA, vault git SHA, model id, pipeline, backend and
  the full run config — two reports are mechanically comparable iff their
  `vault_sha` match.
- Golden-set validation at startup: a broken `relevant` path fails the run
  with a non-zero exit naming the offenders.

**Non-Goals:**

- Curating the real golden set (issue #86, manual).
- Running the parity comparison and recording the SC baseline (issue #87).
- A `reranked` pipeline (blocked on reranker research; the axis is shaped to
  take it later).
- Serving live search from the own corpus (issue #85).
- CI integration, longitudinal dashboards, per-leg metrics.

## Decisions

### D1 — Runner in `eval/`, results gitignored, golden set in the vault

- **Choice**: runner code in `eval/` in this repo; reports in
  `eval/results/` (gitignored); golden set at
  `<vault>/.neuro-vault/eval/golden.yaml`, committed to the vault's git.
- **Why**: the runner imports the semantic module — an interface change
  updates the runner in the same PR. Reports are machine-generated and tied
  to a code SHA (noise in vault backups); the golden set is hand-curated
  private data and belongs with the vault. The dot-path is auto-excluded
  from indexing by the always-excluded-dot-paths scope rule — zero exclusion
  config.
- **Alternatives**: private data-repo with runner (dead: importing the
  semantic module externally is the complexity that blocked the harness);
  reports in the vault (rejected: machine-generated noise);
  `NEURO_VAULT_EVAL_DATA` env for data location (killed: `--vault` + fixed
  convention).

### D2 — Golden-set schema: YAML list, binary relevant set

- **Choice**: one YAML file, entries
  `{ id, query, lang: ua|en, source, relevant: [vault-relative paths] }`;
  a hit on any `relevant` path counts. Parsed with the existing `yaml`
  dependency; entries validated structurally (non-empty unique ids,
  non-empty query, known lang, ≥1 relevant path).
- **Why**: a manually-curated artifact — comments, Cyrillic, hand edits.
  Binary set because top-1 is brittle ("different but relevant" = false
  failure at n≈30) and graded/NDCG is overkill; a binary set is a degenerate
  graded set, upgrade is painless.
- **Alternatives**: JSONL (hostile to comments/hand edits); strict top-1 and
  graded relevance (above).

### D3 — Two orthogonal axes: `--pipeline` × `--backend`

- **Choice**: `--pipeline semantic|fused` = ranking method;
  `--backend sc|own` = vector source. Both required in the report; the
  parity run (#87) is one pipeline across two backends. `--backend` (and the
  `sc` implementation) dies with SC removal (#88).
- **Why**: keeps "did the ranking method change" separable from "did the
  vector source change" — exactly the ambiguity the parity run must avoid.
- **Alternatives**: a single flat mode enum (conflates the axes; #87 would
  compare apples to oranges).

### D4 — Backends produce the same snapshot shape

- **Choice**: a backend is `(vaultRoot) => Map<string, SmartSource>`.
  `sc` reuses `createSmartConnectionsCorpusIndex().snapshot()`. `own` is an
  `eval/`-local adapter: `CorpusStore.listShards()` + `decodeVector` →
  `SmartSource` map (skip null note embeddings; blocks decoded likewise).
  A missing/empty corpus is a startup error telling the user what to run
  (`neuro-vault-mcp index` for `own`; Obsidian/SC for `sc`).
- **Why**: `Map<string, SmartSource>` is what every downstream piece
  (`findNeighbors`, `executeRetrieval`) already consumes. The adapter stays
  in `eval/` because promoting it into `src/` would preempt #85's backend
  contract (promotion, status, watching) with none of its obligations; if
  #85 finds it reusable, promotion is #85's call.
- **Alternatives**: build the production `SemanticBackend` seam now
  (rejected: that is #85's scope, running in parallel); read shards ad hoc
  per query (rejected: pointless — snapshot-at-start matches how the server
  works and how eval should be reproducible mid-run).

### D5 — Pipelines: positions-only scoring

- **Choice**:
  - `semantic`: embed query (`EmbeddingService`) → `findNeighbors` with
    **threshold 0, limit 10** → ranked paths.
  - `fused`: production legs at deep-effort pool sizes — `executeRetrieval`
    (pool 8, expansion on, floor 0.35) with **threshold 0**,
    `LexicalIndex.search` (noteCap 10, perNoteCap 3, real
    `WikilinkGraphIndex` backlink counts for its tie-break),
    `flattenExpansion`, then `fuseRanks` (`totalNotes` from the lexical
    index, weight 0.85) → top-10 fused paths. This is `assembleUnified`'s
    exact ordering, minus the MCP envelope.
  - Every knob (pools, floors, weight, k policy, caps) is echoed into the
    report's `config`.
- **Why**: production thresholds (0.5/0.35 + fallback) are calibrated to one
  model's similarity scale; scales across models/backends are incomparable,
  so eval counts rank positions only. Reusing the production functions means
  the harness measures the real pipeline, not a reimplementation.
- **Alternatives**: bit-faithful production behaviour including thresholds
  (rejected: breaks cross-model comparability — the harness's whole point);
  a harness-local reimplementation of fusion (rejected: measures the wrong
  thing and rots).

### D6 — Metrics and slices

- **Choice**: per query, over the top-10 ranked paths: rank of first
  relevant hit (or none). Aggregates: **precision@3** (mean of
  |relevant ∩ top-3| / 3), **MRR** (mean of 1/first-relevant-rank, 0 when
  absent from top-10), **hit@3** (share of queries with any relevant in
  top-3). Sliced overall / `lang: ua` / `lang: en`.
- **Why**: fixed by the 2026-08-08 design; small-n-friendly, position-based.
- **Alternatives**: NDCG (needs graded labels — D2 rejected them).

### D7 — Report: paired-comparison identity

- **Choice**: one JSON file per run in `eval/results/`,
  named `<timestamp>-<pipeline>-<backend>.json`, carrying:
  `{ code_sha, vault_sha, model_id, pipeline, backend, config, golden:
  { path, count }, metrics: { overall, ua, en }, per_query: [{ id, query,
  lang, first_relevant_rank, top: [paths] }] }`. `code_sha` and `vault_sha`
  via `git rev-parse HEAD` (`execFile`, per ADR-0004) in the repo and vault
  respectively; a dirty tree or non-git vault records the fact (e.g.
  `"<sha>-dirty"` / `null`) rather than lying.
- **Why**: `vault_sha` (issue #84 comment) makes comparability mechanical:
  same vault SHA → comparable, different → not. The harness is a
  paired-comparison instrument on one vault state, not an absolute ruler
  across time. `per_query` ranks are what weight-tuning actually diffs.
- **Alternatives**: no vault identity (rejected by the issue comment); a
  results database (overkill; files diff fine).

### D8 — Golden-set path validation is a startup gate

- **Choice**: before any embedding, every `relevant` path is checked for
  existence in the vault; any miss → exit non-zero listing the broken
  entries (id + path). Structural YAML errors fail the same way.
- **Why**: notes move (this harness's own task note moved to `Archive/`
  mid-effort). A broken path silently turns a query unwinnable — metric
  degradation with no retrieval degradation. This is the golden set's
  "compile error" (issue #84 comment).
- **Alternatives**: warn-and-skip (rejected: a skipped query changes n and
  silently shifts every aggregate).

### D9 — Repo wiring

- **Choice**: npm script `"eval": "tsx eval/run.ts"`; `eval` added to
  `tsconfig.json` `include`; `eval/results/` added to this repo's
  `.gitignore`. No changes to `src/` beyond none-at-all if possible; the
  harness only imports.
- **Why**: tsx is already the dev runner; tsconfig inclusion makes
  `tsc --noEmit` authoritative and puts `eval/` under type-aware eslint
  (`eslint .` covers repo root and all included dirs) with zero
  special-casing.
- **Alternatives**: a compiled `dist/` entry (needless — local tool);
  separate tsconfig for eval (more machinery, weaker gates).

### D10 — Testing

- **Choice**: unit tests under `test/eval/`: metrics math on known rankings;
  golden-set parse/validation failures (broken path → error listing ids);
  own-backend adapter decoding (shard fixture → SmartSource map); report
  assembly (axes + SHAs + config present). An end-to-end runner test over a
  synthetic mini-vault fixture with a tiny prebuilt corpus, exercising the
  CLI parse → validate → rank → report path with a stub embedder.
- **Why**: pipelines are production code already under test — harness tests
  cover the glue. A stub embedder keeps e2e hermetic (no model download in
  CI).
- **Alternatives**: none serious.

## Risks / Trade-offs

- **[Trade-off] Threshold-0 eval ≠ production behaviour.** Eval can rank a
  note production would filter. → Accepted: cross-model comparability is the
  point; the divergence is explicit in the report's `config`.
- **[Risk] `eval/`-local own-corpus adapter drifts from #85's production
  backend.** → Mitigation: the adapter is ~a screenful built on
  `CorpusStore` + `decodeVector` (both production code); the parity run #87
  happens before #85 flips defaults, and #85 may absorb the adapter.
- **[Risk] Dirty working tree / non-git vault makes SHAs lie.** →
  Mitigation: record `-dirty` suffix and `null` honestly (D7); the parity
  run protocol (#87) demands clean states.
- **[Risk] Stub-embedder e2e misses real-model issues (e.g. the 512-token
  ONNX trap).** → Accepted: the trap lives in the indexer (already handled);
  the runner embeds only short queries, same as the server does today.
- **[Trade-off] Reports are local-only; baselines survive by manual
  transcription** (vault task note, SC-removal ADR). → Accepted by design —
  durable numbers need human context anyway.

## Migration Plan

N/A — no deployment surface. New local tooling plus config touches
(`package.json` script, tsconfig `include`, `.gitignore`). No MCP contract,
no server behaviour, no release-note-worthy runtime change. Rollback =
delete `eval/`.

## Open Questions

None blocking. Deferred by scope: `reranked` pipeline value (post-reranker
research), per-leg metrics, golden-set curation (#86), parity run (#87),
LLM judge over eval reports (#101 — optional qualitative stage consuming the
report format this change stabilizes; never mixed into the mechanical
metrics).
