# Tasks — embedding-model-profiles

Four PRs (design D1). Each PR ends at a review stop: open it, then wait for the user's review and merge before starting the next one. PRs 1–3 carry `Refs #98`, PR 4 `Closes #98`. Every task keeps `npm test`, `npm run lint`, `npm run typecheck` green at its commit.

Verification runs use a copy of the owner's vault in the session scratchpad (design, Migration Plan) — never the live vault a running MCP server reconciles.

---

# PR 1 — transformers.js 4.x, profile registry, `--model` (`Refs #98`)

## 1. Library migration and the profile registry

Sequential: each builds on the types of the one before (1.3 imports `Pooling` from 1.2; 1.4 imports `ModelOutput` from 1.3). 1.4 adds `@huggingface/transformers` beside the old package; 1.5 removes `@xenova/transformers` together with its last importer.

- [ ] 1.1 Spike (throwaway probe script, nothing committed): with `@huggingface/transformers` 4.3.1, load each profile's tokenizer and model at its pinned revision with `dtype: 'q8'` — including both harrier profiles, so PR 2 starts from facts. Record per export: `sessions.model.inputNames`/`outputNames` (token states vs only `sentence_embedding`), tokenizer `padding_side`/`pad_token_id`, the sentinel-derived template, whether loading writes to stdout at `env.logLevel` error, and the install size delta. Correct the plan's later snippets from the findings (design D5 step 7, Risks).
- [ ] 1.2 Add `src/modules/semantic/model-profiles.ts` (design D2): `ModelProfile`, `EmbeddingIdentity`, the closed registry with `bge-micro-v2` (default) and `granite-97m` at their pinned revisions, `MODEL_KEYS`, `DEFAULT_MODEL_KEY`, `resolveModelProfile`, `identityOf(profile)`. Tests: exact key set and default; unknown key throws listing keys; repo ids are not keys; `bge-micro-v2`'s identity reproduces today's manifest fields (`bge-micro-v2`, `TaylorAI/bge-micro-v2`, 384).
- [ ] 1.3 Add `src/modules/semantic/pooling.ts`: `poolAndNormalize(output, mask, method)` for `mean`, `cls` and `last_token` over real tokens only (positions from the mask, never from ids), plus pass-through normalisation of an already-pooled output; L2-normalised rows. Tests: mean ignores pad positions; CLS takes the first real token under right and left padding; last-token takes the last real token under right padding and the final column under left padding; unit length; non-finite values rejected.
- [ ] 1.4 Add `@huggingface/transformers` 4.3.1 (exact pin; `@xenova/transformers` stays until 1.5); `engines.node` → `>=20.9.0`. Add `src/modules/semantic/local-model-loader.ts` (design D15): sets `env.cacheDir` (XDG cache) and `env.logLevel` once, loads `AutoTokenizer` + `AutoModel` at the profile's revision with `dtype: 'q8'`, checks the session's input/output names, returns structural `{ tokenizer, model }` handles. DI over the transformers module for tests: env set once, options passed, a missing required input/output fails naming the profile.
- [ ] 1.5 Rewrite `EmbeddingService` on the loader (design D5 "Staging") and remove `@xenova/transformers`: takes `profile` and `loader`, exposes `identity`; call sites (`server.ts`, `cli-index.ts`, `semantic/index.ts`, `eval/run.ts`) resolve the profile from today's `modelKey` / the default key; v2-equivalent encoding `tokenizer([text], { padding: true, truncation: true, max_length: profile.maxTokens })`; forward with `input_ids` + `attention_mask`; `poolAndNormalize` by `profile.pooling`; shared initialisation with retry-after-failure kept. Tests with a fake loader: pooling per profile, truncation option passed, identity, an over-long input returns a vector, a failed load is retried. Delete the `capTokenizer` path and its tests.

## 2. Identity as data, `--model`

Sequential; each task lands with every call site it breaks (typecheck gate). Depends on group 1.

- [ ] 2.1 Thread the corpus identity (design D7): remove `MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS`, `MAX_TOKENS` from `corpus/types.ts`; add `CorpusIdentity` and `corpusIdentityOf(identity)`; `ReconcileDeps.identity`; `CorpusStore` requires `dims`; `createCorpusBackend` and `createOwnCorpusBackendFactory` take the expected identity; `server.ts`, `cli-index.ts`, `eval/` pass it. Tests updated to a shared test identity; a store built for 640 dims rejects a 384-dim shard.
- [ ] 2.2 Rebuild reporting in the corpus library (design D8): `ensureManifest` returns `{ rebuilt, previous }`; `ReconcileOptions.onRebuild({ stored, active })` fires before the first note when a stored manifest with shards is replaced; `formatIdentity()` renders `<model_key> (embed_version <n>)`. Tests: fires once on mismatch, never on a match or on a fresh corpus.
- [ ] 2.3 Server-side announcement: the backend's startup selection writes the stderr rebuild line (design D8 wording) when the stored manifest is incompatible and shards exist. Tests with a fake store: line names both identities; no line for a compatible or empty corpus.
- [ ] 2.4 `--model` (design D3): one shared `MODEL_OPTION` (`choices`, default) on the server command and `index`; `ServerConfig.semantic = { enabled, model }`; `IndexCliOptions.model`; `ISemanticModuleConfig` carries the profile; `server.ts` and `cli-index.ts` build the provider from it; `index` prints the rebuild line via `onRebuild` before progress. Tests: valid key, unknown key rejected listing all keys (both invocations), `--help` lists choices and default, `--no-semantic --model x` accepted, `index` rebuild line printed / not printed.

## 3. Docs and delivery (PR 1)

3.1 after group 2; 3.2 last.

- [ ] 3.1 Docs: `docs/architecture/cli-startup.md` (`--model`, both invocations), `docs/architecture/embedding-pipeline.md` (v4 library, profiles, identity), `docs/guide/configuration.md` (`--model` row), `docs/guide/installation.md` (stable model cache dir, first run re-downloads, Node ≥ 20.9, `ONNXRUNTIME_NODE_INSTALL=skip` on CPU-only Linux), `README.md` index section.
- [ ] 3.2 Verify on the vault copy: gates + build; `npm run eval -- --pipeline semantic` against the existing bge-micro corpus reproduces 0.398 overall MRR ± 0.005; server start triggers no rebuild; `index --model granite-97m` prints the rebuild line and completes; the server with `--model granite-97m` answers `search_notes` with semantic hits; `--model nope` exits non-zero with the key list; stdio server stdout stays JSON-RPC only. Commit the change folder with the code. Open PR 1 (`Refs #98`) via `gh pr create`. **Stop for review.**

---

# PR 2 — provider-owned tokenisation, batching, harrier profiles (`Refs #98`)

## 4. The provider contract

Sequential; 4.1 lands with all its call sites.

- [ ] 4.1 New `EmbeddingProvider` (design D4): `identity`, `maxBatchSize`, `initialize`, `embedQuery`, `embedDocuments`. Rename `embed` → `embedQuery` across the retrieval policy, pipeline, tools, eval pipelines and every test helper/fake in the same task. The queue's `asProvider()` maps `embedQuery`; `embedIndex` remains single-text until 6.1. Tests: existing suites green under the rename; queue query lane uses `embedQuery`.

## 5. Template-aware tokenisation

5.1 then 5.2 (one file, `tokenization.ts`; pure, fake inputs only). 5.3 depends on both.

- [ ] 5.1 `deriveTemplate(tokenizer)` → `{ prefix, suffix }` from a sentinel encoded with and without special tokens. Tests: `[2] … [1]` (harrier-270m shape), suffix-only `… [151643]` (harrier-0.6b shape), `[179934] … [179938]` (granite shape), no template; a tokenizer whose output does not contain the raw run throws.
- [ ] 5.2 `encodeRow({ content, queryPrefix, template, maxTokens, encode })` with the `max_tokens × 32` character work bound applied before tokenising, and `padBatch(rows, padId, side)` → `{ ids, mask }`. Tests: short input unchanged; long input is exactly `maxTokens` and ends with the template suffix (**the EOS regression test** — it fails against "special tokens, then truncate"); the query prefix survives truncation; the work bound cuts a 5 MB string before tokenising; right and left padding; a pad id equal to the suffix id still yields a mask that marks the suffix as real.
- [ ] 5.3 Switch `EmbeddingService` to template-aware rows: derive the template at load, `embedQuery` (query prefix) / `embedDocuments` (≤ `maxBatchSize`, padded on the tokenizer's side), read token states, or the export's pooled output when it has no token states (loader, 1.4). Tests through the service with a fake loader: batch invariance (same text alone vs batched with longer texts), query prefix only on queries, EOS present for an over-long document under right padding.

## 6. Batching

Sequential; depends on 4.1.

- [ ] 6.1 Queue `embedDocuments(texts)` (design D6): length-sorted buckets of ≤ `maxBatchSize` with longest ≤ 2× shortest, one index-lane entry per bucket, results in input order; a query submitted mid-run runs after the in-flight bucket and before queued ones; a failed bucket rejects only its call. Tests with a controllable provider.
- [ ] 6.2 Corpus port `EmbedFn` → `EmbedDocumentsFn`; `embedNote` makes one call per note; wire `asDocumentEmbedFn()` in the server and `index`. Tests: one call per note with note text + blocks in order; a rejected call fails only that note and keeps its old shard.

## 7. Harrier profiles, CI check, docs, delivery (PR 2)

7.1 and 7.2 are parallel-safe; 7.3 after both; 7.4 last.

- [ ] 7.1 Add `harrier-270m` and `harrier-0.6b` to the registry (default unchanged). Registry tests updated.
- [ ] 7.2 `test/integration/profile-tokenizers.test.ts` (skipped unless `NEURO_VAULT_HF_TESTS=1`) and a `profile-tokenizers` CI job caching the model cache dir (design D15): per profile, derived template, padding side, > `max_tokens` input encodes to exactly `max_tokens` ending in the suffix.
- [ ] 7.3 Docs: `embedding-pipeline.md` (tokenisation, pooling, prefixes, batching), `semantic-backend.md` (query waits for one batch), `own-corpus.md` (document-embed port, batching), `docs/guide/configuration.md` (`--model` choices).
- [ ] 7.4 Verify on the vault copy: gates; `index --model harrier-270m` cold-index wall time batched vs unbatched recorded; bge-micro drift for capped inputs measured (cosine old vs new); PR description states the drift. Open PR 2 (`Refs #98`). **Stop for review.**

---

# PR 3 — eval model axis, thresholds as profile data (`Refs #98`)

## 8. Similarity defaults move into the profile

Sequential; each lands with its call sites.

- [ ] 8.1 `ModelProfile.similarity` (design D10) with today's values on every profile; `executeRetrieval` and the retrieval pipeline take the similarity defaults and stop reading the effort-profile threshold constants; the semantic module passes the active profile's. Tests: a fake profile with distinct values drives quick/deep/fallback/block-evidence/expansion defaults; the calibration-curve suite still passes.
- [ ] 8.2 `search_notes` descriptions interpolate the active profile's values and drop the "0.9+ is typical" scale claim; the fallback note text uses the profile's fallback; then `semanticThreshold`, `FALLBACK_THRESHOLD` and `DEFAULT_EXPANSION_FLOOR` are deleted. Tests: description under a fake profile states its values; effort-profile pin updated.
- [ ] 8.3 `get_similar_notes` and `find_duplicates` defaults come from the profile. Tests: omitted threshold applies the profile value.

## 9. Eval `--model`

Sequential after 8.1 (EVAL_CONFIG reads the profile's floor). 9.5 is parallel-safe with 9.2–9.4.

- [ ] 9.1 `parseEvalArgs`: `--model` (registry keys, default), `--stats` (boolean flag), `--baseline <report>` (only with `--stats`); usage text. Tests: valid, unknown listing keys, `--stats` parsed, flag-as-value still rejected.
- [ ] 9.2 Manifest gate (design D12): before any embed, compare the corpus manifest with the profile's corpus identity; mismatch → error naming the stored model and `neuro-vault-mcp index --vault <path> --model <key>`. Tests.
- [ ] 9.3 Report: `model_key` + identity; `per_query` ranked paths with similarity; best relevant similarity regardless of rank; filename `<stamp>-<model_key>-<pipeline>.json`. Tests.
- [ ] 9.4 `EVAL_CONFIG.expansion_floor` from the selected profile; the production-fusion pin still asserts identical order.
- [ ] 9.5 `eval/stats.ts`: quantile summaries of the four populations (design D11), per-default pass rates, the two golden-set guards (deep filters no in-pool first-relevant hit; quick costs at most one hit@3), and with `--baseline <report>` the threshold reproducing each baseline pass rate; wired behind `--stats`. Pure-function tests on small fixtures.
- [ ] 9.6 `eval/README.md`: model axis, the manifest gate, `--stats`, the calibration procedure, and the destructive cross-model workflow.

## 10. Delivery (PR 3)

- [ ] 10.1 Verify on the vault copy: gates; `eval --model granite-97m` against the bge-micro corpus fails naming the index command; **capture the calibration baseline**: `npm run eval -- --model bge-micro-v2 --stats` on the existing corpus, aggregates only (quantiles, pass rates — no note paths) copied into `openspec/changes/embedding-model-profiles/calibration.md`. Open PR 3 (`Refs #98`). **Stop for review.**

---

# PR 4 — default switch, manifest v2, calibration, ADR, docs (`Closes #98`)

## 11. Corpus identity v2 and the switch

Sequential.

- [ ] 11.1 Manifest v2 (design D8): `CorpusManifest` gains `provider`, `revision`, `dtype`, `pooling`, `max_tokens`; `EMBED_VERSION` = 2; strategy `token-window-v1`; compatibility compares every field but `created`; a legacy manifest parses as incompatible and is named in rebuild messages. Tests: legacy bge manifest → rebuild report names `bge-micro-v2` and 1; each new field's mismatch rebuilds.
- [ ] 11.2 Remove `EMBED_CHAR_BUDGET`: the note formula is breadcrumbs + full text. Tests: embed-text and types tests updated; a 5 000-character note's embed text is untruncated.
- [ ] 11.3 Default → `harrier-270m`; remove `bge-micro-v2` from the registry. Tests: default, key set, `--model bge-micro-v2` rejected.

## 12. Calibration and acceptance

Sequential; manual runs on the vault copy, results committed as aggregates.

- [ ] 12.1 Confirm `calibration.md` holds the bge-micro baseline. Index the copy with each profile; `eval --stats` per profile; set every similarity default by design D11 (quantile matching + golden guard); record values, pass rates and guard results in `calibration.md`; put the values in the registry. Test: registry pin of the calibrated values.
- [ ] 12.2 Acceptance: default-profile cold index wall time (minutes); `npm run eval -- --pipeline semantic` UA MRR ≥ 0.6 and EN MRR ≥ 0.8; `fused` recorded; `--model granite-97m` end-to-end through the server. Results into `calibration.md`.

## 13. ADR and docs sweep

Parallel-safe among themselves; after 12.

- [ ] 13.1 `docs/adr/0017-embedding-model-profiles.md` (design D14) with the calibrated numbers; `docs/adr/INDEX.md` row; 0013 marked "refined in part by 0017".
- [ ] 13.2 Architecture sweep: `embedding-pipeline.md`, `own-corpus.md` (constants, formula, manifest v2, tokenizer-cap section, benchmarks), `semantic-backend.md`, `retrieval-policy.md` (thresholds per profile + calibration), `mcp-parameter-dictionary.md`, `module-structure.md`, `cli-startup.md`, `docs/architecture/README.md`.
- [ ] 13.3 Guide + top-level sweep: `docs/guide/finding-notes.md` (threshold guidance per profile), `configuration.md`, `installation.md` (download sizes, RAM, cold-index cost, upgrade re-index), `README.md`, `AGENTS.md` (stale Smart Connections line). Grep `docs/`, `README.md`, `eval/README.md` for `bge`, `xenova`, `1894`, `3.7`, `0.35`, `0.3 `, `~40 MB` and resolve every hit outside `docs/research/` and accepted ADRs.

## 14. Delivery (PR 4)

Strictly in this order.

- [ ] 14.1 `/opsx:verify` → `verify.md` (gates, test count, acceptance numbers).
- [ ] 14.2 `retrospective.md`.
- [ ] 14.3 `npx openspec archive -y`.
- [ ] 14.4 After retrospective and archive — `superpowers:finishing-a-development-branch`: PR 4 (`Closes #98`), `feat!` with a BREAKING CHANGE footer (default model, forced re-index, download and memory). **Stop for review.**
