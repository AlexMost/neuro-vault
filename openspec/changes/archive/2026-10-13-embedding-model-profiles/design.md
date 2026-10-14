## Context

The server embeds every vault with one hardcoded model, `TaylorAI/bge-micro-v2` (384 dims, mean pooling), through `@xenova/transformers` v2's `pipeline('feature-extraction')`. Model identity is a set of constants in `src/lib/obsidian/corpus/types.ts` that six modules read directly: `reconcile.ts` and `backend/corpus-backend.ts` build the manifest identity from them, `shard-store.ts` defaults its dimension check to `MODEL_DIMS`, `embedding-service.ts` loads `MODEL_ID` and caps the tokenizer at `MAX_TOKENS`, `config.ts` puts `MODEL_KEY`/`MODEL_ID` into `ServerConfig`, and `eval/run.ts` records `MODEL_ID`.

The bake-off (`docs/research/2026-10-embedding-model-bakeoff.md`, #98) settled the model: `harrier-oss-v1-270m` lifts Ukrainian MRR from 0.317 to 0.695 on the owner's golden set. It also surfaced three facts any swap has to absorb:

1. transformers.js applies the tokenizer post-processor (BOS/EOS) **before** truncation, so every input over the cap loses its trailing special token — for a last-token-pooled model the vector becomes that of a mid-sentence token. Qwen3 scored 0.164 that way, 0.611 once tokenisation was done by hand.
2. `EMBED_CHAR_BUDGET = 512 × 3.7` matches no model (measured 1.63 chars/token for bge-micro, 2.3–2.9 for granite/harrier).
3. One model per process is already the invariant: `server.ts` builds one `EmbeddingService` and one `createQueuedEmbedder` shared by every vault (queries on a priority lane); `index` builds one embed function shared by every vault.

Other constraints:

- **Settled by the user** (not revisited here): default `harrier-270m`; a closed profile set (`harrier-270m`, `granite-97m`, `harrier-0.6b`) chosen by `--model`, no free-form repo ids; one profile per process with each vault's manifest validated against it; a provider-agnostic `EmbeddingProvider` seam, because the hosted hub (#126, Linux) may embed through a remote API.
- **Module boundary**: `src/lib/obsidian/corpus/` imports nothing from `src/modules/`; it sees the model only through a function port.
- **Distribution**: `npx` install; no native build step (onnxruntime-node ships prebuilt binaries, as today).
- **Production is Linux CPU.** No macOS-only accelerators.
- Similarity thresholds (`search_notes` 0.5 / 0.35 / fallback 0.3 / `expansion_floor` 0.35, block-evidence pass at the deep threshold, `get_similar_notes` 0.5, `find_duplicates` 0.9) are calibrated to bge-micro's similarity scale; three living specs and the tool descriptions restate them.

The decision log behind this design is `brainstorm.md`.

## Goals / Non-Goals

**Goals:**

- Embed with `harrier-270m` by default and let an operator choose `granite-97m` or `harrier-0.6b` with `--model`, on both the server and `index`; reject anything else with the allowed list.
- Make the profile — not a constant — the single source of everything model-specific: repo, pinned revision, dtype, dims, pooling, prefixes, max tokens, and similarity thresholds.
- Own tokenisation in the local provider so no profile can lose its special-token template to truncation; prove it with a test that fails on the "truncated note without EOS" bug.
- Truncate by tokens, not characters.
- Record in the manifest exactly what produced a corpus's vectors, and say so out loud when a vault's corpus does not match the active profile.
- Batch document embeds without letting indexing starve queries.
- Recalibrate every similarity default per profile, with the numbers written down.
- Make the bake-off reproducible in the repo (`npm run eval -- --model`).

**Non-Goals:**

- A remote / API embedding provider. The seam is shaped for one; implementing it belongs to the hub work (#126).
- Per-vault model selection. One profile per process stays (D7 of the backend design).
- Per-profile corpus directories, or keeping two corpora side by side (D9).
- Cross-note batching in the indexer (D6 — a measured follow-up if needed).
- GPU / CoreML / q4 variants (ruled out by the bake-off).
- Changing any MCP tool's parameter names, schemas, or output shape. Default threshold *values* change; the contract does not.
- Growing the golden set's English slice (an open question in the bake-off, not this change).

## Decisions

### D1: Four independently mergeable PRs

- **Choice**:

  | PR | Scope | Default | Forced re-index |
  |---|---|---|---|
  | 1 · `Refs #98` | transformers.js 4.x with the provider calling tokenizer + model directly (v2-equivalent truncation, mask-aware mean/CLS pooling); `ModelProfile` + closed registry (`bge-micro-v2` transitional default, `granite-97m`); `--model` on server and `index`; profile identity threaded into corpus/store/backend; explicit mismatch reporting; stable model cache dir | bge-micro-v2 | no |
  | 2 · `Refs #98` | template-aware tokenisation for every profile + last-token pooling; `embedQuery`/`embedDocuments` contract; batched document embeds; `harrier-270m` and `harrier-0.6b` join the registry | bge-micro-v2 | no |
  | 3 · `Refs #98` | eval `--model` axis + manifest gate + similarities/stats in reports; similarity thresholds become profile data (values unchanged) | bge-micro-v2 | no |
  | 4 · `Closes #98` | default → `harrier-270m`; `bge-micro-v2` removed from the registry; `EMBED_CHAR_BUDGET` removed; manifest v2; recalibrated per-profile thresholds; ADR-0017; docs sweep; opsx verify → retrospective → archive | **harrier-270m** | **yes, once** |

- **Why**: each PR leaves `main` coherent and releasable, and the one corpus rebuild every user pays happens exactly once, in PR 4. PR 1 still ships a real end-to-end deliverable (`--model granite-97m`).
- **Deviations from the brief's 3-PR sketch** (for ack): harrier profiles cannot ship in PR 1 — under the v4 `pipeline` they would embed noise for every note over 512 tokens (59 % of the owner's notes) — so they move to PR 2 with the tokeniser; granite-97m can ship in PR 1 because CLS pooling is insensitive to the lost `[SEP]` (bake-off control: 0.004); eval gets its own PR and comes before the switch because calibration needs it; threshold plumbing rides with eval (PR 3) so PR 4 only changes numbers.
- **Alternatives considered**: the 3-PR sketch verbatim (ships a broken harrier profile in PR 1); one PR (removes the user's review checkpoints; violates incremental delivery).

### D2: A closed registry of `ModelProfile`s in the semantic module

- **Choice**: `src/modules/semantic/model-profiles.ts` exports `ModelProfile`, `MODEL_PROFILES` (a frozen record keyed by profile key), `DEFAULT_MODEL_KEY`, `MODEL_KEYS`, and `resolveModelProfile(key)`. Final registry (PR 4):

  | key | repo (pinned revision) | dtype | dims | pooling | query prefix | doc prefix | max_tokens |
  |---|---|---|---|---|---|---|---|
  | `harrier-270m` (default) | `onnx-community/harrier-oss-v1-270m-ONNX` @ `d59c919d0159aea2c19ed7d04288fcdd048d0f9c` | q8 | 640 | last_token | `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ` | — | 512 |
  | `granite-97m` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` @ `536a9f241cb3f02a9c5995a1e708c784bd274859` | q8 | 384 | cls | — | — | 512 |
  | `harrier-0.6b` | `onnx-community/harrier-oss-v1-0.6b-ONNX` @ `e4daffa011e666dcd2ff2a3c6c05084090ac314d` | q8 | 1024 | last_token | same as harrier-270m | — | 512 |

  PRs 1–3 also carry `bge-micro-v2` (`TaylorAI/bge-micro-v2` @ `3edf6d7de0faa426b09780416fe61009f26ae589`, q8, 384, mean, no prefixes, 512) as the default; its `model_key` is `bge-micro-v2` and its `model_id` is `TaylorAI/bge-micro-v2`, so existing corpora stay compatible until PR 4. A profile also carries its `similarity` defaults (D10).
- **Why**: the profile is the one record that says everything model-specific. The **pinned revision** is what makes "verified" mean something: the weights and tokenizer a profile was measured against cannot change under it, and upgrading a revision is a reviewed code change that the manifest sees (D8). Living in the semantic module keeps the corpus library model-agnostic: the corpus gets an identity value, the provider gets tokenisation fields, tools get thresholds, `config.ts` gets the key list.
- **Template is derived, not declared**: the special-token prefix/suffix is computed from the tokenizer at load (D5), as the brief requires; the CI test (D13) asserts the derived template per profile so a mis-pinned revision fails CI, not retrieval.
- **Alternatives considered**: profiles in `corpus/types.ts` (drags pooling/padding/thresholds into a library that should not know about them); a new `src/lib/embedding/` package (a package for one data file); free-form `--model <repo>` (rejected by the user; unverifiable).

### D3: `--model` is one yargs option shared by both invocations

- **Choice**: `config.ts` declares one `MODEL_OPTION` (`type: 'string'`, `choices: MODEL_KEYS`, `default: DEFAULT_MODEL_KEY`, description listing the keys) attached to both the default command and `index`, exactly as `VAULT_OPTION` is shared today. `ServerConfig.semantic` becomes `{ enabled, model: ModelProfile }` (resolved once at parse time); `IndexCliOptions` gains `model: ModelProfile`. The `modelKey`/`modelId` pair in `ServerConfig` and `ISemanticModuleConfig` is replaced by the profile.
- **Why**: yargs `choices` rejects an unknown value with the allowed list and a non-zero exit, through the same code path for both invocations — the parity the `--vault` requirement already demands. Resolving the profile at parse time means no downstream code ever handles an unknown key.
- **`--no-semantic`** keeps meaning "no model at all"; `--model` is then accepted and inert.
- **Alternatives considered**: an env var (invisible in `--help`, not copyable between invocations); per-vault config (violates one profile per process).

### D4: The provider contract separates queries from documents and carries its identity

- **Choice** (PR 2; PR 1 adds `identity` only):

  ```ts
  interface EmbeddingIdentity {
    provider: string;     // 'transformers.js' for the local provider
    model_key: string;    // profile key, e.g. 'harrier-270m'
    model_id: string;     // repo id
    revision: string;
    dtype: string;
    dims: number;
    pooling: string;
    max_tokens: number;
  }

  interface EmbeddingProvider {
    readonly identity: EmbeddingIdentity;
    readonly maxBatchSize: number;                        // 8 for the local provider
    initialize(): Promise<void>;
    embedQuery(text: string): Promise<number[]>;          // applies the profile's query prefix
    embedDocuments(texts: string[]): Promise<number[][]>; // bare; at most maxBatchSize texts
  }
  ```

  The queue (`createQueuedEmbedder`) keeps its shape: `embedQuery` → query lane; `embedDocuments(texts)` → index lane, split into batches (D6). Its `asProvider()` view is what the retrieval path receives; its `asIndexEmbedFn()` becomes `asDocumentEmbedFn(): EmbedDocumentsFn` for reconcile. The corpus library's port changes from `EmbedFn = (text) => Promise<number[]>` to `EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>`.
- **Why**: harrier's query prefix is asymmetric. With one `embed(text)` either every caller learns about prefixes or the provider guesses; both fail silently (a query embedded without its instruction ranks measurably worse). Explicit `embedQuery` makes the wrong call impossible to write by accident. Remote APIs already distinguish query and document inputs, and `identity` is how a remote provider will tell the manifest what produced its vectors.
- **`embed` → `embedQuery`** is an internal rename across the retrieval path and its tests; there is no MCP surface.
- **Alternatives considered**: keep `embed` and add `embedDocuments` (ambiguous name for the query path); put the prefix in the caller (leaks profile data into tools).

### D5: The local provider owns tokenisation, for every profile

- **Choice**: `EmbeddingService` stops using `pipeline()` (in PR 1 already — see "Staging" below). It loads the profile's tokenizer (`AutoTokenizer`) and model (`AutoModel`) separately, at the pinned revision with `dtype: 'q8'`, through an injectable loader, and embeds a batch as follows:
  1. Cut each raw text at `max_tokens × 32` characters — a work bound so a multi-megabyte note cannot exhaust tokenizer memory. At 32 chars/token it cannot bind before the token limit for real text (measured 1.6–2.9); it is not a budget.
  2. Encode the content with `add_special_tokens: false`. For a query, also encode the profile's query prefix the same way.
  3. Template (derived once at load): encode a fixed sentinel with and without special tokens; the ids before the raw run are the template prefix, the ids after it the suffix. A profile whose tokenizer adds nothing yields an empty template.
  4. Content budget = `max_tokens − |template prefix| − |template suffix| − |query prefix|`; truncate content ids to it. The query prefix itself is never truncated.
  5. Row = `template prefix + query prefix + content + template suffix`.
  6. Pad every row to the batch's longest with the tokenizer's pad id, on the tokenizer's declared `padding_side`; build `attention_mask`.
  7. Forward pass with `input_ids` and `attention_mask` only (transformers.js fills `position_ids`, empty cache inputs and `token_type_ids` where a graph declares them). Pool per profile over the token states (`last_hidden_state`, else `token_embeddings`): `mean` = masked mean; `cls` = the first unmasked position; `last_token` = the last unmasked position — found from the mask, never from the pad id, because harrier-0.6b's pad id equals its template suffix id. L2-normalise. If spike 1.1 finds that a harrier export exposes only its in-graph `sentence_embedding` (pooled, mask-aware per the model cards), that profile reads it instead and the batch-invariance test guards it; own pooling over token states is preferred wherever both exist, so all profiles share one tested pooling path.
  8. At load, check the session's `inputNames`/`outputNames` against what this path needs and fail initialisation with a message naming the profile — a mis-exported revision fails fast instead of embedding garbage.
- **Padding side in practice**: all three target tokenizers pad **right** in transformers.js 4.3.1 (Gemma and granite declare it; harrier-0.6b's Qwen tokenizer declares nothing and defaults to right). The brief's "harrier-0.6b pads left" came from Qwen3-Embedding-0.6B, whose config does declare left. The provider follows whatever the tokenizer declares; the CI tokenizer check pins the observed side per profile.
- **Staging**: transformers.js 4.x's feature-extraction pipeline truncates after the post-processor, pools by physical position (not by mask), and exposes `model_max_length` as a getter, so today's token-cap override has nothing to assign to. PR 1 therefore already calls tokenizer + model directly, with **v2-equivalent** encoding (`tokenizer(texts, { padding: true, truncation: true, max_length: maxTokens })` — special tokens, then truncation, exactly as v2's pipeline did) and mask-aware `mean`/`cls` pooling. That keeps bge-micro's vectors equal to the corpora v2 built (PR 1 verify proves it with the eval parity run). PR 2 swaps the encoding step for steps 1–6 above and adds `last_token`.
- **Why**: this is the bake-off's working recipe, applied to every profile so the registry has one truncation semantics and one test suite. The alternative — `pipeline()` for encoders, own path for decoders — doubles the code and leaves encoders with a quietly different contract. Pooling by mask position (rather than "last column") is what makes last-token pooling correct under right padding (harrier-270m) and CLS correct under left padding.
- **DI seams for tests**: `EmbeddingServiceOptions` takes `profile` and a `loader` that returns `{ tokenizer, model }` behind minimal structural interfaces (encode with/without special tokens, pad id, padding side; forward returning `{ dims, data }`). Unit tests use fakes; no test downloads a model.
- **Cost**: for inputs over 512 tokens, bge-micro/granite vectors change by one token (the `[SEP]` the pipeline used to drop). No `embed_version` bump in PR 2 — PR 4 rebuilds every corpus once anyway, and a bump here would force a second full rebuild for a change below eval resolution. PR 2's verify measures the drift (cosine old vs new on a few capped notes) and its description states it.
- **Alternatives considered**: keep `pipeline()` and post-fix the EOS (cannot: the truncated sequence is already gone); hardcode each profile's template (drifts from the tokenizer; the brief asks for derivation).

### D6: Batching is per note, bucketed by length; queries interleave between batches

- **Choice**: `reconcileCorpus`'s `embedNote` gathers a note's inputs (note text + qualifying blocks) and makes **one** `EmbedDocumentsFn` call. The queue's `embedDocuments(texts)` sorts the texts by length, greedily groups them into batches of at most `provider.maxBatchSize` (8) where the longest is at most 2× the shortest, enqueues each batch as one index-lane entry, and reassembles vectors in input order. The query lane drains between batches.
- **Why bucketing**: a note's inputs differ widely in length, and one naive batch `[note, b1..b6]` pads every input to the longest — slower than batch 1. The note text holds every block uncut, so it is usually the longest input, but not always: a block's heading breadcrumbs can make it outrun a note that is little more than that block. Blocks also differ widely in length among themselves. So bucketing sorts by measured length, which groups like with like whichever input is longest.
- **Why per note**: failure containment and abort semantics stay exactly as specified — a failed batch fails only its own note, which keeps its previous shard; an abort still stops at a note boundary; progress still counts notes.
- **Latency bound**: a query now waits for at most one batch in flight (~0.5 s on harrier-270m, ~2 s on harrier-0.6b at 8 × 512 tokens), not for one embed.
- **Alternatives considered**: cross-note windows with global length sorting (best throughput; widens a failure to every note in a window and moves the abort boundary — the follow-up if PR 2's measured cold index misses "minutes"); bounded note concurrency + a coalescing queue (keeps per-note code but makes progress order nondeterministic).

### D7: The corpus library receives its identity; the model constants go away

- **Choice**: a `CorpusIdentity` = `EmbeddingIdentity` + `{ embed_version, strategy }` is built once per process from the active provider and passed as data: `ReconcileDeps.identity`, `CorpusStore` `dims` (already injectable — now always passed), and the backend's expected identity (`createOwnCorpusBackendFactory({ embedder, identity })`). `EMBED_VERSION` and the strategy name stay corpus constants (they describe text extraction, not the model). `MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS` and `MAX_TOKENS` leave `corpus/types.ts` in PR 1; `EMBED_CHAR_BUDGET` leaves in PR 4.
- **Why**: with a constant per model, a profile switch would need six coordinated edits; with identity as data, the manifest, the shard dimension check and the backend's compatibility check cannot disagree with the provider that produced the vectors.
- **PR 1's identity** for the transitional default keeps today's five manifest fields byte-identical, so no existing corpus is invalidated before PR 4.

### D8: Manifest v2 records the producing identity; a mismatch is named, then rebuilt

- **Choice**:
  - **PR 4** — manifest = `{ embed_version: 2, provider, model_key, model_id, revision, dtype, dims, pooling, max_tokens, strategy: 'token-window-v1', created }`. Every field that changes a stored vector is in it; the query prefix is not (it changes no stored vector). Compatibility compares every field except `created`.
  - Parsing tolerates the legacy shape: a manifest missing the new fields still parses (as an incompatible identity) so its `model_key`/`embed_version` can be named, instead of reading as "failed validation".
  - **Reporting** (PR 1): `ensureManifest` returns `{ rebuilt, previous }`. The server's startup selection writes one stderr line per vault when a stored manifest with shards is incompatible:
    `neuro-vault corpus: vault "<name>" was indexed with <stored model_key> (embed_version <n>); active model is <active model_key> (embed_version <m>) — discarding the corpus and re-indexing in the background`.
    `index` prints `rebuilding <name>: corpus was indexed with <stored>; active model is <active>` before that vault's progress. `npm run eval` refuses (D11).
  - The vault reports `indexing` during the rebuild — already surfaced as `semantic_status` on `search_notes` and as `SEMANTIC_INDEX_BUILDING` on the embeddings-only tools. No tool output changes.
- **Why**: auto-rebuild is how every user lands on the new model without a manual step (ADR-0013's migration lever), so it stays; what changes is that it stops being silent. Recording the full producing identity is decision 4 of the brief, and it is what lets a remote provider coexist later.
- **Known cost**: a server and an `index` run with different `--model` on the same vault rebuild against each other. The warnings make it visible; docs say to keep them equal.
- **Alternatives considered**: per-profile corpus directories (D9); refusing to rebuild without a flag (friction on every upgrade, for a case the warning already explains).

### D9: One corpus directory per vault, as today

- **Choice**: keep `<vault>/.neuro-vault/corpus/`; a profile switch discards and rebuilds it.
- **Why**: the brief wants the bge-micro corpus invalidated, not kept; one profile per process makes switching rare; stale per-profile corpora would accumulate unseen (the 56k-vector vault's corpus is ~130 MB at 384 dims, ~220 MB at 640).
- **Consequence for eval**: comparing two profiles on one vault means re-indexing between runs — destructive by construction and documented in `eval/README.md`. Verification runs use a copy of the vault (Migration Plan) so they never fight a live server over the corpus.

### D10: Similarity thresholds are profile data

- **Choice** (plumbing in PR 3 with values unchanged; values in PR 4): `ModelProfile.similarity = { quick, deep, fallback, expansionFloor, similarNotes, duplicates }`. `EFFORT_PROFILES` keeps only model-independent knobs (pools, caps, expansion on/off); `semanticThreshold`, `FALLBACK_THRESHOLD`, `DEFAULT_EXPANSION_FLOOR`, `get_similar_notes`'s `DEFAULT_THRESHOLD` and `find_duplicates`'s `DEFAULT_DUPLICATE_THRESHOLD` are read from the active profile, passed through the semantic module's deps into the retrieval policy (including the deep block-evidence pass, which uses the deep threshold) and the tool builders. Tool descriptions interpolate the active profile's values, and drop scale claims that hold for one model only (the `expansion_floor` description's "0.9+ is typical").
- **Why**: an encoder-CLS model and a decoder-last-token model do not share a similarity scale; one threshold set would be wrong for two of three profiles, and `--model granite-97m` must work end-to-end.
- **In PRs 1–2** every profile still runs on today's constants (granite knowingly mis-scaled until PR 4).

### D11: Calibration reproduces the thresholds' behaviour on each profile's scale

- **Choice** (PR 4, using PR 3's eval statistics):
  1. **Baseline first, while `bge-micro-v2` is still in the registry.** Before any other profile indexes the vault copy, run `--model bge-micro-v2 --stats` against its bge-micro corpus and keep the report outside git. Task 11.3 removes the profile that could reproduce it, and one corpus directory per vault means the baseline is unrecoverable once the vault is re-indexed. The report records, for each default, its pass rate over an **unranked** population: one that holds pairs a user never sees as well as those they do, so a threshold has something to cut:

     | default | population it is matched on |
     |---|---|
     | `quick`, `deep`, `fallback` | `query_all`: each golden query's similarity to every note with a vector |
     | `expansionFloor` | `seed_all`: each seed (a query's top-`semantic_pool` candidates) against every note that is not one of that query's seeds |
     | `similarNotes` | `note_all`: every note against every other note (ordered pairs) |
     | `duplicates` | `note_max`: each note's maximum similarity to any other note |

     The ranked populations stay in the report as context: top-10 candidates, the expansion leg's neighbours, and top-10 neighbours. They show where a threshold sits against what a user actually gets back, but they do not drive the suggestion. PR 3's baseline was taken on the ranked populations, so PR 4 re-captures it on these (Task 11.0, before Task 11.3).
  2. For each profile: index a copy that shares the baseline's `vault_sha`, run `--stats --baseline`, and take each default's suggested threshold, the value at which the same share of the new profile's population passes. Round it **down** to two decimals and enforce `quick ≥ deep > fallback` (if needed, `fallback = deep − 0.01`, recorded).
  3. Guard on the golden set: with the new `deep`, no first-relevant hit that threshold 0 finds in the deep pool may be filtered out; with the new `quick`, hit@3 stays within one query of threshold 0. The guards model a plain filter, without the fallback retry, so they are conservative. A guard failure lowers the threshold until it passes, and the adjustment is recorded.
  4. Record baseline pass rates, per-profile values and guard results in `calibration.md`, ADR-0017 and `docs/architecture/retrieval-policy.md`.
- **Why**: there is no labelled data for note↔note thresholds, so "keep doing what they did" (distribution matching) is the defensible target, and the golden-set guard catches a quantile that would cost recall where labels exist. The populations have to be unranked. PR 3's baseline measured each default on the ranked population it filters in production (top-10 candidates, top-10 neighbours), and on bge-micro five of the six defaults passed **100 %** of it: bge's similarities sit in a narrow high band, and the lowest top-10 candidate scores 0.559 against a `quick` of 0.50. Reproducing a pass rate of 1.0 just means "the new population's minimum". `quick`, `deep` and `fallback` would collapse to one value, which breaks `quick ≥ deep > fallback` and leaves the fallback retry with nothing to retry at. A sample minimum also says nothing about where a new model's scores for "unrelated" begin. Against every note, a bge threshold sits **inside** the distribution. Its pass rate is the share of the vault it treats as related at all, a rank property that carries over to a scale of a different spread and offset.
- **Decision rule**: if a bge default still passes 1.0 of its unranked population, matching cannot place it either. Calibration stops and the owner decides that default.
- **Outcome of the rule (owner's decision, PR 4)**: the re-captured baseline tripped it. `fallback` (0.30) passes 1.0 of query↔every note, whose minimum is 0.337. `expansionFloor` (0.35) passes 1.0 of seed↔every note, whose minimum is 0.471. On bge both thresholds sit below every pair on the vault, so they cut nothing at all. Reproducing that behaviour on a profile means: **each is set just below the minimum of its own unranked population on that profile, rounded down to 0.05**, keeping `fallback < deep` (if the rounded value is not below `deep`, it steps down another 0.05). A quantile match would have pinned them to one sample's extreme. `deep` (0.9991) and `similarNotes` (0.99974) pass less than 1.0, so they are matched as in step 2. They come from the far tail of their populations, which leaves them sensitive to a handful of pairs, and `calibration.md` says so.
- **Alternatives considered**: tune each threshold to maximise a golden-set metric (25 queries, positions only; eval ranks at threshold 0 by design, so there is nothing for a threshold to maximise; overfits). Match a deeper ranked population, such as ranks beyond 10 (the depth is arbitrary and still filters nothing at bge's shallow ranks). Anchor on the bge threshold's position relative to the bge distribution, as a z-score (assumes the distribution's shape carries over). Keep "filters nothing in the top 10" and pick values under the new population's minimum (no principled spacing between `quick`, `deep` and `fallback`).

### D12: `npm run eval -- --model`

- **Choice** (PR 3): `--model <key>` (default: the registry default) builds the embedder from the profile; before embedding anything the runner checks the vault's corpus manifest against the profile's identity and fails, naming `neuro-vault-mcp index --vault <path> --model <key>`, on a mismatch. The report records `model_key` and the full identity; each `per_query` entry records the similarity of every ranked path and the best similarity of any relevant note regardless of rank; the filename becomes `<stamp>-<model_key>-<pipeline>.json`. `--stats` adds the D11 distributions. `EVAL_CONFIG.expansion_floor` reads the active profile's value (semantic thresholds stay 0 by design).
- **Why**: today eval would cosine a 640-dim query against a 384-dim corpus without complaint. With the gate, a bake-off run is `index --model X && eval --model X` per profile, from the repo.
- **Spec change**: `retrieval-eval` drops "SHALL accept one axis" and "SHALL NOT accept a corpus-selection axis" in favour of a model axis gated on the manifest (still one corpus; the axis selects the embedder, and the gate ensures it matches the corpus).

### D13: Tests — unit fakes for the algorithm, a CI job for the real tokenizers

- **Choice**:
  - Unit (DI, no network): a fake tokenizer whose encoding of a long text exceeds `max_tokens` and whose post-processor adds `<bos>`/`<eos>`. Assert each row has exactly `max_tokens` real ids ending in `<eos>`; padding sits on the declared side; last-token pooling selects the `<eos>` column under both left and right padding; CLS selects the first real token under left padding; mean ignores pad positions; the query prefix survives truncation; vectors are unit length. The last-token/right-padding case is the regression test for the bake-off's EOS bug — it fails against a pipeline-style "special tokens, then truncate" implementation.
  - CI: `test/integration/profile-tokenizers.test.ts`, skipped unless `NEURO_VAULT_HF_TESTS=1`, loads each registry profile's **tokenizer only** at its pinned revision and asserts the derived template (`[2]`/`[1]` — `<bos>`/`<eos>` — for harrier-270m, `[]`/`[151643]` — `<|endoftext|>` — for harrier-0.6b, `[179934]`/`[179938]` — `<|startoftext|>`/`<|return|>` — for granite-97m), the padding side (right for all three today), and that a > 512-token input encodes to exactly `max_tokens` ids ending in the template suffix. A new CI job runs it with the model cache directory (D15) under `actions/cache`. Source-level tests cannot observe what a real tokenizer config does, so this property needs a CI step, not a one-time manual check.
  - End-to-end: the acceptance eval runs (Migration Plan) — UA MRR ≥ 0.6, EN MRR ≥ 0.8 for `harrier-270m`; `granite-97m` indexes and searches end-to-end.
- **Alternatives considered**: download full models in CI (706 MB for harrier-0.6b per cache miss; the algorithm is already covered by fakes); manual checks only (the memory of past incidents says these rot).

### D14: ADR-0017, and the docs that change with each PR

- **Choice**: new ADR-0017 "Embedding models are a closed set of verified profiles" (PR 4, with calibrated numbers): the closed registry, harrier default, provider seam, provider-owned tokenisation, per-profile thresholds, manifest v2. ADR-0006 is already superseded and is not amended; ADR-0013 is cited (its `embed_version` + full rebuild lever is what PR 4 pulls) and `INDEX.md` marks it "refined in part by 0017". Docs move with the PR that changes the behaviour: PR 1 — `cli-startup.md`, `docs/guide/configuration.md` (`--model`), `embedding-pipeline.md` (library + profiles); PR 2 — `embedding-pipeline.md` (tokenisation, batching), `semantic-backend.md` (latency bound), `own-corpus.md` (port); PR 3 — `eval/README.md`; PR 4 — full sweep of `docs/` (architecture, guide, README, AGENTS.md's stale "Smart Connections" line) against the inventory gathered for this change.

### D15: Runtime environment of the local provider

- **Choice**: the local loader sets transformers.js's global `env` once, before the first load: `env.cacheDir` = `$XDG_CACHE_HOME/neuro-vault/models` (falling back to `~/.cache/neuro-vault/models`), and `env.logLevel` = error. `package.json` `engines.node` becomes `>=20.9.0`. The installation guide documents `ONNXRUNTIME_NODE_INSTALL=skip` for Linux x64 hosts without a GPU.
- **Why**:
  - Cache: the v4 default cache lives inside the package directory, which moves with the rename (so a v2 cache is never reused) and, under `npx`, sits in a cache npm may purge — a 344 MB re-download each time. A stable user cache dir survives package upgrades and gives the CI tokenizer job a fixed path to cache. transformers.js's tokenizer file probe reads only the global `env` (per-call `cache_dir` is ignored), so it has to be global.
  - Log level: the MCP transport owns stdout; library chatter must stay off it.
  - Node floor: `@huggingface/transformers` 4.x depends on `sharp`, whose engine floor is Node 20.9.0.
  - Install: `onnxruntime-node` 1.30's postinstall downloads CUDA 12 execution-provider binaries on Linux x64 by default; production is CPU-only Linux.
- **Alternatives considered**: keep the package-local default cache (silent re-downloads); a new `NEURO_VAULT_*` env var for the cache path (new config surface nobody has asked for; `XDG_CACHE_HOME` already covers relocation).

## Risks / Trade-offs

- [Risk] transformers.js 4.x API differs from the bake-off script's usage (input names for Gemma-3 / Qwen3 / ModernBERT exports, `revision` support, tokenizer fields) → Mitigation: PR 1's first task is a spike that loads each profile's tokenizer and model in a scratch script and records the exact calls; the plan's snippets are corrected from it before any production code.
- [Risk] onnxruntime-node or transformers.js writes to **stdout** during model load, corrupting the MCP stdio transport → Mitigation: `env.logLevel` = error (D15); PR 1 verify starts the built server over stdio with `--model granite-97m` and asserts every stdout line parses as JSON-RPC; the existing `index` stdout contract test covers the CLI.
- [Risk] The heavier dependency tree (`sharp` native binaries, ORT 1.30, CUDA EP download on Linux x64) slows or breaks `npx` installs and `npm ci` → Mitigation: CI on ubuntu exercises the install on every PR; the guide documents `ONNXRUNTIME_NODE_INSTALL=skip`; PR 1's description reports the install size delta.
- [Risk] Note text containing a literal special-token string (`<eos>`, `<|endoftext|>`) is tokenised as that special token even with `add_special_tokens: false` (no split option in tokenizers.js) → accepted: it can only perturb that note's own vector, and the real template suffix is always appended after truncation.
- [Risk] Per-note bucketed batching gains less than the bake-off's globally sorted batches → Mitigation: PR 2 verify records cold-index wall time batched vs unbatched on the vault copy; if harrier-270m misses "minutes" (bake-off: 6–11 min for ~6k vectors), cross-note batching becomes a follow-up issue rather than a silent regression.
- [Risk] Users on a PR 2/3 build carry a one-token vector drift for long inputs → Mitigation: stated in PR 2's description, measured in its verify; PR 4's bump rebuilds everyone.
- [Risk] A live MCP server and a verification `index` run fight over the owner's corpus (different `--model`) → Mitigation: all verification runs use a copy of the vault (Migration Plan); the real-vault run happens when the owner upgrades their server.
- [Risk] Calibration baseline lost to an early re-index, or to `bge-micro-v2` leaving the registry → Mitigation: D11 step 1 runs while bge-micro is still selectable, read-only against an existing bge corpus on a vault copy. PR 3 captured it on the ranked populations; PR 4's Task 11.0 re-captures it on the unranked ones before Task 11.3 removes the profile.
- [Risk] A Hugging Face repo deletes or rewrites history and a pinned revision 404s → Mitigation: the CI tokenizer job fails loudly; a profile's revision is a one-line reviewed change.
- [Risk] The CI tokenizer job flakes on a Hugging Face outage → Mitigation: cached; on a cache hit no network is needed. It is a separate job, so an outage is attributable at a glance.
- [Trade-off] Default install grows from 17 MB to ~344 MB of weights and ~2 GB peak RSS; cold index on the owner's vault from ~2 min to ~6–11 min, ~1 h on a 56k-vector vault → accepted by the user for the UA quality gain; `granite-97m` is the documented lite option at today's cost.
- [Trade-off] Query latency 1 ms → ~54 ms (harrier-270m) → invisible behind an MCP round trip.
- [Trade-off] Removing `bge-micro-v2` from the registry in PR 4 breaks anyone who passed `--model bge-micro-v2` on a PR 1–3 build → acceptable; it was only ever the transitional default, and the rejection names the allowed keys.
- [Trade-off] Comparing profiles on one vault re-indexes it each time (D9) → documented; cheap for granite, slow for harrier-0.6b.

## Migration Plan

**Per PR** — gates: `npm test && npm run lint && npm run typecheck && npm run build`; the user reviews and merges before the next PR starts (incremental delivery).

Verification uses a copy of the owner's vault (same notes, same `.neuro-vault/eval/golden.yaml`, corpus copied where a PR needs the existing one) under the session scratchpad, so no run touches the corpus a live MCP server is reconciling.

- **PR 1**: `npm run eval -- --vault <copy> --pipeline semantic` against the existing bge-micro corpus reproduces 0.398 overall MRR within 0.005 (proves v4 + `dtype: 'q8'` produce the same query space as v2's quantized default); starting the server against it triggers **no** rebuild; `index --model granite-97m` on the copy prints the rebuild line and completes; the server started with `--model granite-97m` answers `search_notes` with semantic hits; `--model nope` exits non-zero listing the keys; stdout of the stdio server stays JSON-RPC only.
- **PR 2**: `index --model harrier-270m` on the copy, batched vs unbatched wall time recorded; vector drift for long inputs on bge-micro measured.
- **PR 3**: `eval --model granite-97m` against a bge-micro corpus fails naming the index command; the bge-micro `--stats` baseline report is captured and kept with the change's verify notes.
- **PR 4** (in order): re-capture the bge baseline on the unranked populations (D11) while bge-micro is still in the registry → index the copy with each profile → `--stats` per profile → calibrate (D11) → acceptance: default profile cold index time in minutes; `npm run eval -- --pipeline semantic` UA MRR ≥ 0.6 and EN MRR ≥ 0.8; `--model granite-97m` end-to-end → ADR-0017 + docs sweep → verify → retrospective → archive → PR.

**Upgrade path for users** (PR 4 release): nothing to do; on first start each vault logs the rebuild line and re-indexes in the background (lexical search unaffected), or run `neuro-vault-mcp index --vault <path>` ahead of time. The new model downloads on first use (~344 MB).

**Rollback**: revert the PR. A corpus built by the reverted build carries an identity the older build rejects, so it rebuilds with the older profile on next start — the same mechanism, in reverse.

**Release**: PR 4 is a `feat!` (BREAKING CHANGE footer: default model, forced re-index, download and memory requirements); PRs 1–3 are `feat`. Releases stay the owner's call, from `main`, after merge.

## Open Questions

- None blocking. Resolved during apply, each with an owner and a decision rule already stated: the ONNX input/output names of each pinned export and whether a harrier export exposes token states or only `sentence_embedding` (spike 1.1, D5 step 7); throughput of per-note batching (PR 2 verify, D6); the calibrated threshold values (PR 4, D11).
