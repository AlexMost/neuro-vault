# Tasks — retrieval-eval-harness

## 1. Repo wiring

- [x] 1.1 Add `eval` to `tsconfig.json` `include`; add `eval/results/` to `.gitignore`; add `"eval": "tsx eval/run.ts"` npm script (placeholder `eval/run.ts` so `eslint .` and `tsc --noEmit` stay green from the first commit)
- [x] 1.2 Test that pins the gate coverage: assert `tsconfig.json` `include` contains `eval` (guards against the harness silently dropping out of typecheck/lint)

## 2. Golden set module (`eval/golden.ts`)

- [x] 2.1 Parse `golden.yaml` (existing `yaml` dep) into typed entries `{ id, query, lang, source, relevant[] }`; structural validation — non-empty unique ids, non-empty query, `lang` ∈ {ua, en}, ≥1 relevant path — each failure names the offending entry
- [x] 2.2 Relevant-path existence validation against the vault: collect ALL broken entries (id + path), fail with them listed; tests for structural failures, broken-path failure (no report written), and the passing case

## 3. Backend snapshots (`eval/backends.ts`)

- [x] 3.1 `sc` backend: load `Map<string, SmartSource>` via `createSmartConnectionsCorpusIndex().snapshot()`; missing/empty corpus → error naming the SC corpus
- [x] 3.2 `own` backend: adapter over `CorpusStore.listShards()` + `decodeVector` → `SmartSource` map (skip null note embeddings, decode block vectors); missing/empty corpus → error mentioning `neuro-vault-mcp index`; tests with shard fixtures (decode correctness, null-embedding skip, empty-corpus error)

## 4. Pipelines (`eval/pipelines.ts`)

- [x] 4.1 `semantic`: `EmbeddingService.embed(query)` → `findNeighbors(threshold 0, limit 10)` → ranked paths; embedder injected so tests stub it
- [x] 4.2 `fused`: production legs at deep pools — `executeRetrieval` (pool 8, expansion on, floor 0.35, threshold 0), `LexicalIndex.search` (noteCap 10, perNoteCap 3, real `WikilinkGraphIndex` backlink counts), `flattenExpansion`, `fuseRanks(totalNotes from lexical index)` → top-10 paths; the whole knob set surfaced as a `config` object for the report; test that fused ordering equals `fuseRanks` output over the three legs (production-fusion reuse pin)

## 5. Metrics (`eval/metrics.ts`)

- [x] 5.1 Per-query first-relevant-rank + aggregates precision@3 / MRR / hit@3 over slices overall / ua / en; tests on known rankings (rank-3 hit → 1/3 contributions; miss outside top-10 → zeros; slice partitioning)

## 6. Report (`eval/report.ts`)

- [x] 6.1 Assemble + write `eval/results/<timestamp>-<pipeline>-<backend>.json`: `code_sha`, `vault_sha` (git `rev-parse` via `execFile` per ADR-0004; `-dirty` suffix on a dirty tree, `null` for a non-git vault), `model_id`, `pipeline`, `backend`, `config`, golden-set size, per-slice metrics, per-query results; tests for identity fields, dirty/non-git cases, and shape

## 7. Runner CLI (`eval/run.ts`)

- [x] 7.1 Arg parsing (`--vault` required; `--pipeline semantic|fused`, `--backend sc|own` — unknown values exit non-zero naming supported ones) and orchestration: parse → validate golden set → load backend → rank → score → write report → print summary
- [x] 7.2 End-to-end test over a synthetic mini-vault fixture (tiny prebuilt own-corpus shards, stub embedder): full run produces a report with correct metrics; broken-path fixture exits non-zero without a report

## 8. Docs

- [x] 8.1 `eval/README.md`: what the harness is, golden-set convention + schema, run examples, comparability rule (`vault_sha`), pointer to #86/#87
- [x] 8.2 Docs sweep (all of `docs/`, per doc-sweep scope rule): references to the eval harness / golden set match the shipped contract; add the harness to the docs map if a natural slot exists
