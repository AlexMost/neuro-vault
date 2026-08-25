# Embedding model alternatives to bge-m3 (August 2026)

Research question: is there a better embedding model than `BAAI/bge-m3` for semantic search over a personal Obsidian vault, under these constraints — multilingual retrieval (Ukrainian + English) as a hard requirement, local inference on macOS, runnable from Node ≥ 20 (transformers.js / ONNX Runtime preferred, Ollama / llama.cpp as fallback), and co-existence with a Smart Connections-style corpus.

All claims below are sourced to model cards, official release posts, the Smart Connections source, or this repo's source. Findings are as of 2026-08-25. Models released after the researcher's January 2026 knowledge cutoff (Granite R2, KaLM) were found via live search, not memory.

## Context: what this repo actually runs today

Before comparing against bge-m3, note the baseline in this repo is **not** bge-m3:

- The default query-embedding model is **`TaylorAI/bge-micro-v2`** — 384-dim, 512 tokens, ~17M params, **English-only** ([`src/config.ts`](../../src/config.ts) `DEFAULT_MODEL_ID`; [`src/lib/obsidian/corpus/types.ts`](../../src/lib/obsidian/corpus/types.ts) `MODEL_KEY = 'bge-micro-v2'`, `MODEL_DIMS = 384`).
- It was chosen for parity with Smart Connections' default so query and corpus vectors share one space ([embedding-pipeline.md](../architecture/embedding-pipeline.md), [ADR-0006](../adr/0006-smart-connections-corpus.md)).
- The server-owned corpus builder (`src/lib/obsidian/corpus/`) pins the same model in its manifest (`model_key`, `dims`, `strategy: 'sc-parity-v1'`).
- The runtime is **`@xenova/transformers` ^2.17.2** ([`package.json`](../../package.json)) — the legacy v2 package, superseded by [`@huggingface/transformers` v3+](https://huggingface.co/docs/transformers.js/index). This matters: several candidates below use architectures (Qwen3, ModernBERT, Gemma 3) that only the v3+ package supports.

So for a Ukrainian+English vault, *any* competent multilingual model — including bge-m3 itself — is a large upgrade over the status quo. The question is which one.

## TL;DR verdict

**Yes, there are better models than bge-m3 in 2026, and the switch is worth the re-embedding cost** — primarily because the current corpus (bge-micro-v2) is English-only, so Ukrainian notes are effectively invisible to semantic search today. Re-embedding is unavoidable for *any* model change (embedding spaces are never compatible), so the marginal cost of picking a better model than bge-m3 is zero.

Recommendation, in order:

1. **`ibm-granite/granite-embedding-97m-multilingual-r2`** (Apr 2026) — the pragmatic pick. Apache-2.0, 97M params, **384-dim (same as the current corpus dimension)**, 32k context, Ukrainian in its 52 enhanced-support languages, Multilingual MTEB Retrieval 60.3 (vs bge-m3's ~54.6 on MMTEB retrieval), int8 ONNX is **98 MB**, and — decisive for co-existence — **Smart Connections v3 already ships it as a built-in local model option** (`onnx-community/granite-embedding-97m-multilingual-r2-ONNX`, marked "experimental"). Both the plugin corpus and this server's query path can use the same model.
2. **`Qwen/Qwen3-Embedding-0.6B`** (Jun 2025) — the quality pick if the server-owned corpus becomes the primary index. Apache-2.0, best-in-class small-model multilingual retrieval (MMTEB retrieval 64.64 vs bge-m3's 54.60), MRL dims 32–1024, 32k context, community ONNX (~614 MB int8) with a transformers.js example, and an official Ollama package as fallback. Cost: ~6× granite-97m's inference footprint, needs instruction-prefixed queries and last-token pooling — a bigger code change.
3. **bge-m3 itself** is still respectable (MIT, 8k context, dense+sparse+ColBERT) and is the only multilingual candidate runnable on the *current* `@xenova/transformers` v2 dependency (`Xenova/bge-m3` conversion exists), but it is a Feb 2024 model that now trails both picks on multilingual retrieval and is the heaviest option (2.27 GB fp32 / ~570 MB int8) — and Smart Connections does not offer it as a local model, so the plugin corpus could never match it.

Either pick requires: migrating to `@huggingface/transformers` v3+, making pooling/prefix per-model configuration instead of hardcoded `mean` pooling, bumping the corpus manifest (`model_key`, `dims`, `embed_version`), and a full re-embed of every vault.

## Comparison table

Multilingual scores are **MTEB(Multilingual) / MMTEB** as reported on the [Qwen3-Embedding model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) (leaderboard snapshot of 2025-05-24) unless noted; Granite R2 numbers come from its own card's "Multilingual MTEB Retrieval (18 tasks)" and are close but not guaranteed task-identical — treat cross-source comparisons as approximate.

| Model | Released | Params | Dims (MRL) | Max ctx | License | MMTEB mean (task) | MMTEB retrieval | ONNX / transformers.js | Ukrainian |
|---|---|---|---|---|---|---|---|---|---|
| TaylorAI/bge-micro-v2 (current) | 2023 | ~17M | 384 | 512 | MIT | — (English-only) | — | yes (SC default) | **no** |
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) (baseline) | Feb 2024 | ~568M | 1024 | 8192 | MIT | 59.56 | 54.60 | official onnx/ + [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3) (works on v2) | yes (XLM-R) |
| [intfloat/multilingual-e5-large-instruct](https://huggingface.co/intfloat/multilingual-e5-large-instruct) | 2024 | ~560M | 1024 | 512 | MIT | 63.22 | 57.12 | official onnx/ folder; no maintained tjs conversion found | yes (XLM-R) |
| [Snowflake/snowflake-arctic-embed-l-v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0) | Dec 2024 ([paper](https://arxiv.org/abs/2412.04506)) | ~568M (XLM-R base) | 1024 (MRL 256) | 8192 | Apache-2.0 | not on Qwen table; card claims strong BEIR/CLEF | — | full onnx/ incl. quantized; transformers.js tagged | 74 languages (XLM-R base) |
| [nomic-ai/nomic-embed-text-v2-moe](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe) | Feb 2025 | 475M (305M active) | 768 (MRL 256) | 512 | Apache-2.0 | — | BEIR 52.86, MIRACL 65.80 (**below** bge-m3's 69.20 on MIRACL, per its own card) | custom arch, `trust_remote_code` | ~100 languages |
| [jinaai/jina-embeddings-v3](https://huggingface.co/jinaai/jina-embeddings-v3) | Sep 2024 | 570M | 1024 (MRL) | 8192 | **CC-BY-NC-4.0** | — | — | onnx/ present | yes |
| [jinaai/jina-embeddings-v4](https://huggingface.co/jinaai/jina-embeddings-v4) | Jun 2025 | 4B (Qwen2.5-VL base) | 2048 (MRL 128–2048) | 32768 | **Qwen research license (non-commercial)** | — | — | no; Python stack | 30+ languages |
| [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | Jun 2025 | 0.6B | 1024 (MRL 32–1024) | 32768 | Apache-2.0 | **64.33** | **64.64** | [onnx-community ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX) + tjs example; [Ollama](https://ollama.com/library/qwen3-embedding) | yes (100+ languages) |
| [Qwen/Qwen3-Embedding-4B / 8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B) | Jun 2025 | 4B / 8B | up to 2560/4096 (MRL) | 32768 | Apache-2.0 | 69.45 / 70.58 | 69.60 / 70.88 | GGUF official; too heavy for in-process Node | yes |
| [google/embeddinggemma-300m](https://huggingface.co/google/embeddinggemma-300m) | Sep 2025 | 308M | 768 (MRL 512/256/128) | **2048** | **Gemma license** | 61.15 | — | [onnx-community ONNX](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX), tjs tagged; [Ollama](https://ollama.com/library/embeddinggemma) | 100+ languages |
| [ibm-granite/granite-embedding-97m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2) | **Apr 2026** | 97M | **384** (from 311m's MRL family) | 32768 | Apache-2.0 | — | **60.3** (18-task Multilingual MTEB Retrieval, own card) | [onnx-community ONNX](https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX) (int8 = 98 MB); **in Smart Connections v3 model list** | **yes (enhanced-support 52)** |
| [ibm-granite/granite-embedding-311m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2) | **Apr 2026** | 311M | 768 (MRL 768→128) | 32768 | Apache-2.0 | — | **65.2** (same 18-task set) | ONNX/OpenVINO published by IBM | **yes (enhanced-support 52)** |

Not evaluated in depth: `mxbai-embed-large-v1` (English-focused, reports MTEB English v1 — fails the multilingual hard requirement, per [comparison notes](https://www.morphllm.com/ollama-embedding-models)); `KaLM-Embedding-Gemma3-12B` (tops a May 2026 MMTEB snapshot at 75.7 retrieval per [search results](https://presenc.ai/research/best-open-weight-embedding-models-2026), but 12B params is not a local-Node-on-a-laptop model); `gte-multilingual-base` (superseded by Qwen3 from the same lab).

## Per-model detail

### Baseline: BAAI/bge-m3

- ~568M params (XLM-RoBERTa-large based), 1024-dim dense, 8192-token context, MIT license, 100+ working languages; unique dense + sparse + ColBERT multi-vector output from one model ([model card](https://huggingface.co/BAAI/bge-m3), [paper](https://arxiv.org/abs/2402.03216)).
- MMTEB: mean(task) 59.56, retrieval 54.60 — now clearly behind 2025–2026 peers at similar or smaller size ([Qwen3 card table](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), leaderboard snapshot 2025-05-24).
- Runnable today on the repo's existing `@xenova/transformers` v2 via [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3) (XLM-R architecture; 2.27 GB fp32, 568 MB int8, per HF file listing). No query prefix, mean-pooling-compatible — the *smallest code change* of any candidate, but the largest runtime footprint and the weakest retrieval of the serious contenders.
- Not offered by Smart Connections as a local model (see compatibility section), so choosing it commits the vault to the server-owned corpus.

### Qwen3-Embedding-0.6B — best small-model quality

- 0.6B params, 1024-dim with MRL user-defined dims 32–1024, 32k context, Apache-2.0, 100+ languages incl. Ukrainian ([model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [release blog](https://qwenlm.github.io/blog/qwen3-embedding/), [paper](https://arxiv.org/abs/2506.05176)).
- MMTEB mean 64.33 / retrieval 64.64 — beats bge-m3 by ~10 retrieval points and multilingual-e5-large-instruct by ~7.5, at the same parameter count; also beats `text-embedding-3-large` (58.93 mean) on the same table.
- Official repo ships no ONNX; **[onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX)** provides fp32/fp16/q8 with a transformers.js `pipeline('feature-extraction', ...)` example. Sizes (HF API): fp32 2.40 GB, int8/quantized 614 MB, q4f16 568 MB. Official [GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF) and [Ollama package](https://ollama.com/library/qwen3-embedding) exist for the local-server fallback.
- Caveats: **instruction-aware asymmetric embedding** — queries should carry an instruction prefix, documents none ([card usage notes](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)); pooling is last-token, not mean — the repo's hardcoded `pooling: 'mean'` ([embedding-pipeline.md](../architecture/embedding-pipeline.md)) must become per-model config. Causal-LM-sized inference: noticeably slower per chunk on CPU than any encoder model here; fine for query-time embedding, slower for full-vault indexing.

### Granite Embedding Multilingual R2 (97M / 311M) — best efficiency and ecosystem fit (post-cutoff release)

- Released 2026-04-29 ([311m card](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2), [97m card](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2), [paper](https://arxiv.org/abs/2605.13521)). ModernBERT architecture, 32,768-token context, Apache-2.0, trained on 200+ languages with **explicit enhanced support for 52 languages — Ukrainian (uk) is on the list** (311m card, "Supported Languages").
- 311m: 768-dim with Matryoshka 768/512/384/256/128, Multilingual MTEB Retrieval (18 tasks) **65.2** (+13 over the R1 278m generation). 97m: pruned+distilled from 311m, 384-dim, **60.3** on the same 18-task set — both above bge-m3's MMTEB retrieval, with the cross-source caveat noted at the table.
- ONNX: IBM publishes ONNX for both; [onnx-community/granite-embedding-97m-multilingual-r2-ONNX](https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX) is transformers.js-ready with int8 at **97.9 MB** (fp32 390 MB) — roughly the memory class of today's bge-micro-v2 setup while being genuinely multilingual with a 32k window. [Ollama granite-embedding](https://ollama.com/library/granite-embedding) exists as fallback.
- Decisive ecosystem fact: **Smart Connections v3's built-in local model list includes exactly this model** (see next section) with CLS pooling and no prefixes. CLS pooling again means the repo's hardcoded mean pooling needs to become configurable.
- ModernBERT is not supported by `@xenova/transformers` v2 — requires `@huggingface/transformers` v3+.

### EmbeddingGemma-300m

- 308M params, 768-dim MRL (512/256/128), 100+ languages, MMTEB mean(task) 61.15, released Sep 2025 ([model card](https://huggingface.co/google/embeddinggemma-300m), [paper](https://arxiv.org/abs/2509.20354)). ONNX with q4/quantized variants at [onnx-community/embeddinggemma-300m-ONNX](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) (transformers.js-tagged); on [Ollama](https://ollama.com/library/embeddinggemma).
- Ruled out as the primary pick: **2048-token max context** (shortest of the field), required task prefixes, **Gemma license** (usage-restricted, not OSI) vs Apache-2.0 alternatives, and a lower multilingual mean than Qwen3-0.6B (61.15 vs 64.33).

### multilingual-e5-large-instruct

- ~560M, 1024-dim, MIT, XLM-R based (Ukrainian covered), MMTEB mean 63.22 / retrieval 57.12 ([card](https://huggingface.co/intfloat/multilingual-e5-large-instruct); score from the Qwen table). Official repo carries an `onnx/` folder (HF API file listing).
- Solid, but dominated: Qwen3-0.6B beats it on both MMTEB columns at the same size; granite-97m-r2 gets within ~3 retrieval points at 1/6 the params with 64× the context (512-token limit is a real constraint for note chunks). Requires instruction-formatted queries. Smart Connections ships only its *small* sibling (`Xenova/multilingual-e5-small`, 384-dim) as a built-in option — the low-effort in-plugin multilingual choice, but the weakest of this field.

### Snowflake arctic-embed-l-v2.0

- XLM-R-based, Apache-2.0, 74 languages, 8192 context, MRL-trained, full quantized ONNX set in the official repo, transformers.js-tagged ([card + HF API](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0), [paper](https://arxiv.org/abs/2412.04506)). The card's headline claims center on BEIR/CLEF rather than MMTEB, and it does not appear on the Qwen MMTEB comparison table; nothing found suggests it beats Qwen3-0.6B or granite-311m-r2 on multilingual retrieval in 2026. A reasonable Apache-2.0 alternative in the bge-m3 weight class, not a reason to switch by itself.

### nomic-embed-text-v2-moe

- 475M total / 305M active MoE, 768-dim (MRL 256), Apache-2.0, ~100 languages, but **512-token context** and — per its own model card — **MIRACL 65.80 vs bge-m3's 69.20** (it wins BEIR 52.86 vs 48.80, i.e., English-leaning strength) ([card](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe)). Custom architecture needing `trust_remote_code`; no official transformers.js path found. Not better than the baseline for the multilingual hard requirement.

### jina-embeddings-v3 / v4

- v3: 570M, 1024-dim MRL, 8192 context, task LoRA adapters, ONNX in-repo — but **CC-BY-NC-4.0** ([HF API license tag](https://huggingface.co/jinaai/jina-embeddings-v3)). Personal-vault use is arguably fine, but it poisons any future distribution of this open-source server's defaults; with equal-or-better Apache-2.0 options available, not recommended.
- v4: 4B multimodal on a Qwen2.5-VL base, non-commercial license inherited from the base, Python-stack deployment, no ONNX — fails the local-Node constraint ([card](https://huggingface.co/jinaai/jina-embeddings-v4)).

## Smart Connections compatibility

Primary source: the Smart Connections v3 environment source, [`brianpetro/obsidian-smart-env`](https://github.com/brianpetro/obsidian-smart-env), file `src/adapters/embedding-model/transformers_v4_worker.js` (fetched 2026-08-25), plus `default.settings.js`.

**Built-in local (transformers) models in Smart Connections v3:**

| Model id | Dims | Max tokens | Pooling | Prefixes | Multilingual |
|---|---|---|---|---|---|
| `TaylorAI/bge-micro-v2` (**default**) | 384 | 512 | mean | none | no |
| `Snowflake/snowflake-arctic-embed-xs` | 384 | 512 | cls | query prefix | no |
| `Snowflake/snowflake-arctic-embed-s` | 384 | 512 | cls | query prefix | no |
| `Xenova/multilingual-e5-small` | 384 | 512 | mean | `query: ` / `passage: ` | **yes** |
| `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` ("experimental") | 384 | 512 | cls | none | **yes** |
| `onnx-community/DenseOn-ONNX` ("experimental") | 768 | 512 | cls | `query: ` / `document: ` | no |

Implications:

- **bge-m3 is not a Smart Connections local option at all.** If the corpus must remain plugin-generated, the realistic multilingual choices are `multilingual-e5-small` (weakest) or `granite-97m-r2` (strongest in-plugin). The adapter directory contains only transformers adapters — SC v3 embeds locally; there is no bring-your-own-model config beyond this list (`src/adapters/embedding-model/` listing, same repo).
- **Model swap forces a full plugin re-embed.** Each model entry carries an `embedding_space_id`; corpus entries are stored per model key (`value.embeddings[<model-key>]`, see [smart-connections-corpus.md](../architecture/smart-connections-corpus.md)) — vectors from different models never share a space, and SC re-embeds the vault when the model changes. Historic default remains `TaylorAI/bge-micro-v2` ([default.settings.js](https://github.com/brianpetro/obsidian-smart-env/blob/main/default.settings.js), [Smart Connections docs](https://docs.smartconnections.app/Settings/Smart-Sources-settings)).
- **All SC models cap at 512 tokens** regardless of the underlying model's window (granite-97m is configured at 512 despite a 32k-capable model) — matching this repo's `MAX_TOKENS = 512` parity constant.
- SC's per-model `semantic_profile` (pooling, normalize, query/document prefixes) is exactly the configuration surface this repo's embedding service currently lacks (it hardcodes `pooling: 'mean', normalize: true` — [embedding-pipeline.md](../architecture/embedding-pipeline.md)). Any model with CLS or last-token pooling or prefixes (granite, arctic, e5, Qwen3) needs that surface added.

## What a model swap means for this repo

1. **Full re-embedding, always.** Vectors from different models (or the same model at different prefixes/pooling) are incompatible; there is no conversion. The loader already enforces same-dimension corpora at load time. Two paths:
   - *SC-coupled path*: user switches the model in Smart Connections (→ `granite-97m-r2` or `multilingual-e5-small`), the plugin re-embeds `.smart-env/multi/*.ajson`, and the server changes `DEFAULT_MODEL_ID` + `MODEL_KEY` + the semantic profile to match. Note the loader matches the model key by substring against the embeddings map — the new SC key must be reflected in `MODEL_KEY`.
   - *Server-owned path*: the corpus builder (`src/lib/obsidian/corpus/`) re-embeds with the new model and stamps the manifest (`model_key`, `dims`, `embed_version`, new `strategy` replacing `sc-parity-v1`). This path frees model choice entirely (Qwen3-0.6B becomes available) at the cost of owning indexing time and staleness — partially walking back the "embeddings for free" premise of [ADR-0006](../adr/0006-smart-connections-corpus.md); an ADR amendment/supersession is warranted.
2. **Dimension change.** 384 → 1024 (Qwen3 full) or 384 → 384 (granite-97m: no change) or → 768 (granite-311m). Dims are corpus-derived at runtime (search engine checks query dim against corpus dim), so mostly `MODEL_DIMS`/manifest bookkeeping; storage grows linearly with dims (MRL truncation on Qwen3/granite-311m can hold dims at 384–512 with modest quality loss — both are MRL-trained).
3. **Dependency migration**: `@xenova/transformers` ^2.17.2 → [`@huggingface/transformers` v3+](https://huggingface.co/docs/transformers.js/index). Required for Qwen3 (arch present in transformers.js `models.js`), ModernBERT/granite-R2, and Gemma3/EmbeddingGemma. Only bge-m3/e5/arctic (XLM-R family) run on v2.
4. **Embedding service config surface**: per-model `pooling` (mean/cls/last-token), `normalize`, `query_prefix`/`document_prefix` (and Qwen3's instruction template), mirroring SC's `semantic_profile`. Also revisit `EMBED_CHAR_BUDGET` (`512 tokens × 3.7 chars`) — the 3.7 chars/token figure is calibrated to bge-micro-v2's tokenizer and English; Cyrillic text tokenizes at a different ratio per tokenizer.
5. **Memory/latency budget** (int8 ONNX, in-process): granite-97m ≈ 98 MB; Qwen3-0.6B ≈ 614 MB (and decoder-class latency); bge-m3 / e5-large / arctic-l ≈ 570 MB. Fallback for anything heavier: [Ollama](https://ollama.com/library/qwen3-embedding) (`qwen3-embedding`, `bge-m3`, `granite-embedding`, `embeddinggemma` all verified present) behind the existing `EmbeddingProvider` interface.

## Open questions

- **Live MMTEB leaderboard snapshot**: the [leaderboard space](https://huggingface.co/spaces/mteb/leaderboard) is dynamic and could not be fetched directly; the head-to-head numbers here are the Qwen card's 2025-05-24 snapshot plus each 2026 model's self-reported card numbers. Before committing, eyeball the current leaderboard filtered to <1B params + Multilingual — in particular whether anything post-June-2026 (e.g., distilled KaLM variants) has appeared in the small-model class.
- **Granite's 18-task "Multilingual MTEB Retrieval" vs MMTEB's retrieval split**: likely the same family of tasks but not verified identical; the granite-vs-Qwen gap (60.3/65.2 vs 64.64) is within cross-source noise. A vault-local eval would settle it.
- **Ukrainian-specific retrieval quality**: no UA-specific public benchmark was found (MIRACL has no Ukrainian; MMTEB includes uk tasks but per-language splits weren't extracted). Cheap decisive test: embed ~50 Ukrainian notes + 20 UA/EN cross-lingual queries with granite-97m-r2, Qwen3-0.6B, and bge-m3 via a scratch script, compare nDCG by hand.
- **Smart Connections trajectory**: granite-97m-r2 is flagged "experimental" in SC's list, and SC caps it at 512 tokens; whether SC raises token caps or promotes it to recommended affects the SC-coupled path's longevity. The old `smart-embed-model` package in `jsbrains` is marked DEPRECATED — the `obsidian-smart-env` repo is now the authoritative source for what the plugin supports.
- **Chunking strategy**: all candidates except EmbeddingGemma/e5/nomic support ≥8k tokens. If the server-owned corpus path wins, `MAX_TOKENS = 512` / `MIN_CHARS = 200` (SC-parity values) could be rethought for long-note retrieval — but that is a corpus-strategy change (`strategy` field exists for exactly this), separate from the model choice.
