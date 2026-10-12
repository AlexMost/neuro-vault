# Embedding model bake-off on a real vault (October 2026)

Follow-up to [`2026-08-embedding-model-alternatives-to-bge-m3.md`](2026-08-embedding-model-alternatives-to-bge-m3.md), which compared candidates on published benchmarks. This document measures them on the thing that matters here: retrieval over one owner's Obsidian vault, Ukrainian-heavy, with the repo's own golden set and ranking code. It is the measuring stick [issue #98](https://github.com/AlexMost/neuro-vault/issues/98) asked for.

Findings are as of 2026-10-13. Every number below was produced in one session on one machine (Apple M5, 4P+6E cores, CPU inference via `onnxruntime-node` 1.30 through `@huggingface/transformers` 4.3.1); treat throughput as indicative, not as a spec.

## TL;DR

- **Recommended default: `microsoft/harrier-oss-v1-270m`** via `onnx-community/harrier-oss-v1-270m-ONNX` (MIT, 640 dims, int8 344 MB). On the golden set it lifts Ukrainian MRR from **0.317 → 0.695** and hit@3 from 0.333 → 0.810, with English unchanged. It beats every Granite R2 and Qwen3 variant tested at equal or lower cost, and it was missing from the August survey (released March 2026).
- **Quality ceiling: `harrier-oss-v1-0.6b`** (UA MRR 0.758) at 2× the size, ~4× the index time and 3.5× the query latency. An opt-in, not a default.
- **Lite option: `granite-embedding-97m-multilingual-r2`** (UA MRR 0.463, 98 MB) costs the same index time as today's bge-micro-v2 and still clears the issue's gate.
- **Qwen3-Embedding-0.6B is dominated** by harrier-0.6b on every axis (quality, size, speed). Drop it.
- The issue's acceptance gate (**UA MRR > 0.4** on the golden set) is cleared by every candidate; bge-micro-v2 fails it (0.317).
- Three engineering facts fall out of the measurements and shape the implementation: last-token models need template-aware truncation (§ EOS), the character budget must come from the tokenizer (§ chars/token), and the cold-index cost of a decoder model is real but one-off (§ Cost).

## Setup

- **Vault**: the owner's personal vault, 947 notes in scope, 886 above `MIN_CHARS` and therefore embedded. Mixed Ukrainian/English, Ukrainian-heavy.
- **Golden set**: `<vault>/.neuro-vault/eval/golden.yaml`, 25 queries (21 `ua`, 4 `en`), binary relevance, the format [`eval/README.md`](../../eval/README.md) describes. About half of the Ukrainian queries are transliterated English terms written in Cyrillic («харнес», «флайвіл», «Пуассон», «Кріт», «Карпатий») — a deliberately hard cross-lingual slice, and exactly the kind of query bge-micro-v2 cannot serve. One entry (`q006`) pointed at a note that had moved to `Archive/`; the path was fixed before any run (the harness refuses to run otherwise, by design).
- **Method**: a throwaway script (session scratchpad, not in the repo) that imports the production modules by path and reuses them verbatim: `FsVaultReader` + `loadVaultScope` for the note listing, `pathBreadcrumbs` for the note embed text, `findNeighbors` via `eval/pipelines.ts`'s semantic pipeline for ranking, `scoreQuery`/`aggregate` from `eval/metrics.ts` for the numbers. Only the embedding function differs per model. It embeds **note-level vectors only** (what the semantic pipeline ranks on), caps input at `MAX_TOKENS = 512` for parity with the production chunker, and does **not** apply `EMBED_CHAR_BUDGET` — the tokenizer truncates instead, which is what the issue argues the indexer should do.
- **Parity check**: the script run on bge-micro-v2 reproduces `npm run eval -- --pipeline semantic` on the existing corpus to within 0.002 MRR (0.396 vs 0.398 overall), so cross-model numbers are comparable with the harness's.
- **Quantisation**: int8 (`dtype: 'q8'`, i.e. `model_quantized.onnx`) for every model, so the memory story is like-for-like. No fp32 run was made; int8 is what would ship.

## Results

Semantic-only ranking, top-10, binary relevance. `hit@3` = share of queries with a relevant note in the top 3.

| Model                                  | License | int8   | dims | UA MRR    | UA hit@3  | EN MRR | EN hit@3 | overall MRR |
| -------------------------------------- | ------- | ------ | ---- | --------- | --------- | ------ | -------- | ----------- |
| `TaylorAI/bge-micro-v2` (current)      | MIT     | 17 MB  | 384  | 0.317     | 0.333     | 0.800  | 0.750    | 0.395       |
| `granite-embedding-97m-multilingual-r2`  | Apache  | 98 MB  | 384  | 0.463     | 0.524     | 1.000  | 1.000    | 0.549       |
| `granite-embedding-311m-multilingual-r2` | Apache  | 313 MB | 768  | 0.571     | 0.714     | 0.812  | 0.750    | 0.610       |
| **`harrier-oss-v1-270m`**              | MIT     | 344 MB | 640  | **0.695** | **0.810** | 0.812  | 0.750    | **0.714**   |
| `Qwen3-Embedding-0.6B`                 | Apache  | 614 MB | 1024 | 0.611     | 0.714     | 0.625  | 0.750    | 0.613       |
| `harrier-oss-v1-0.6b`                  | MIT     | 706 MB | 1024 | **0.758** | **0.857** | 0.875  | 1.000    | **0.777**   |

Per-query rank of the first relevant note, Ukrainian queries only (`-` = not in top 10):

```
query   001 002 003 004 005 006 007 008 010 011 012 014 016 018 019 020 021 022 023 024 025
bge-micro 2   -   -   -   -   1   1   1   -   1   1   1   -   -   -   -   -   -   -   6   -
granite97 1   6   -   7   1   3   1   3   -   1   1   2   -   -   -   1   4   -   -   1   1
granite311 1  3   -   6   3   2   1   3   4   1   1   1   3   -   2   1   1   4   -   1   1
harrier270 1  1   8   2   7   1   1   1   1   1   1   1   2   -   2   1   1   3   -   1   2
qwen3-0.6b 2  6   1   -   -   1   1   3   2   1   1   1   1   -   -   1   1   1   3   1   -
harrier0.6b 1 1   1   2   2   1   4   2   1   1   1   1   2   -   6   1   2   1   1   1   1
```

Reading the table: harrier-270m puts 15 of 21 Ukrainian queries at rank 1, including every transliterated term («харнес» q010, «Мобі» q002, «Пуассон» q024, «Кріт» q020). Its two remaining misses — «дрони defense-tech» (q018) and «флайвіл» (q023) — are notes with one or two mentions in the whole vault; the lexical leg's job, not semantic's.

**Caveat on the English slice.** Four queries. One query moving one rank shifts EN MRR by up to 0.19, so the EN column distinguishes "did not break" from "broke" and nothing finer. Every model except Qwen3 (0.625) stays at or above the baseline's 0.800. Growing the EN slice of the golden set to 10–15 queries would make this column meaningful.

## Cost

### Index-time workload is notes + blocks, not notes

The production indexer embeds a note vector **and** a vector per qualifying block ([`buildEmbedInputs`](../../src/lib/obsidian/corpus/embed-text.ts)). On this vault that is **6,089 vectors for 886 notes** (≈ 6.9 per note), median 200 tokens, p90 at the 512 cap, 18 % capped. A ~4,900-note corporate vault measured elsewhere ([issue #98 comment](https://github.com/AlexMost/neuro-vault/issues/98)) carries 56,351 vectors. Throughput below was measured on the real production text set (notes + blocks, length-sorted within batches), sampled at ~400 vectors per setting:

| Model        | batch 1 (what the indexer does today) | batch 8     | this vault, cold | 56k-vector vault, cold |
| ------------ | ------------------------------------- | ----------- | ---------------- | ---------------------- |
| granite-97m  | 40 vec/s                              | 40 vec/s    | ~2.5 min         | ~24 min                |
| harrier-270m | 9–14 vec/s (run-to-run spread)        | 16–17 vec/s | 6–11 min         | ~55–100 min            |

For reference, bge-micro-v2 indexed the 56k-vector vault in 27.6 min in the earlier study, and a batch-free run of it here did 71 notes/s on note-level text. So **granite-97m costs what bge-micro-v2 costs today; harrier-270m costs roughly 2.5–4× that**, one-off, with batching halving the gap. After the cold index, `reconcileCorpus` re-embeds only changed notes, so day-to-day cost is seconds.

Query latency (median, single query, CPU): bge-micro 1 ms · granite-97m 2 ms · granite-311m 5 ms · harrier-270m 54 ms · Qwen3-0.6B 28 ms · harrier-0.6b 189 ms. Decoder-class models pay per query, but 54 ms is invisible behind an MCP round trip.

Peak RSS of the measuring script (Node + model + whole in-memory corpus + token statistics, so an upper bound on serving): bge-micro ~1.0 GB · granite-97m/311m ~1.5 GB · harrier-270m ~1.9 GB · Qwen3-0.6B ~4.5 GB · harrier-0.6b ~3.5 GB.

### Things that did not help

- **q4 quantisation** of harrier-270m (205 MB) is _slower_ on CPU than int8: 6.4 vs 9–14 vec/s. Smaller file, more work per op.
- **CoreML execution provider** (`device: 'coreml'`, macOS only) with the int8 model: 5.2 vec/s at batch 1 — slower than CPU, because the quantised ops are not supported and fall back. Not pursued further: the hosted deployment runs on Linux, so a macOS-only accelerator was never going to be the production path.

## Findings that shape the implementation

### Last-token models lose their EOS to truncation (the Qwen3 "bug")

The first Qwen3-Embedding-0.6B run scored **UA MRR 0.164 — worse than bge-micro-v2**. Cause: transformers.js runs the tokenizer's post-processor (which appends `<|endoftext|>` for Qwen3, `<bos> … <eos>` for the Gemma-based harrier-270m) **before** truncating to `max_length`, so any text over the cap loses its trailing special token. With last-token pooling the vector is then that of whatever mid-sentence token happened to be at position 511 — noise. 59 % of this vault's note texts were over the cap, so most of the corpus was noise. Re-running with template-aware tokenisation (raw ids → truncate → re-attach the prefix/suffix special tokens → pad on the tokenizer's declared side) gave the 0.611 in the table. The same fix applied to both harrier models; granite-97m (CLS pooling) re-run as a control moved by 0.004 overall — encoder models with CLS/mean pooling are insensitive to a lost `[SEP]`.

**Consequence**: the embedding service cannot delegate truncation to the pipeline for any last-token model. It must own tokenisation: derive the special-token template from the tokenizer, truncate the raw ids to `max_tokens − template length`, re-attach, and pad on the declared side (Qwen3 pads left, harrier right). This is a per-model property alongside pooling and prefixes.

### `EMBED_CHAR_BUDGET` is wrong for every model, including the current one

Measured chars/token on this vault's note texts: bge-micro-v2 **1.63**, granite R2 **2.80–2.86**, harrier/Qwen3 (same tokenizer family) **2.32–2.80**. The constant `3.7` in [`types.ts`](../../src/lib/obsidian/corpus/types.ts) matches none of them; for bge-micro-v2 it means 65 % of notes exceed 512 tokens inside the "budget" (the earlier study found 82 % on the corporate vault). The budget should be the tokenizer's own count, i.e. truncate by tokens, not by characters.

### One model per process is already the invariant

[`startNeuroVaultServer`](../../src/server.ts) builds one `EmbeddingService` and one `createQueuedEmbedder`; every vault's indexing and every query go through that one queue (queries on a priority lane). The `index` CLI likewise shares one embed function across vaults. A multi-vault process therefore has exactly one model in memory, and the model swap must keep model identity (key, repo id, dims, pooling, prefixes, truncation template) **process-wide**, with each vault's corpus manifest checked against it at load.

### The production provider may not be a local model at all

The hosted hub ([#126](https://github.com/AlexMost/neuro-vault/issues/126)) runs on Linux and may use a remote embedding API rather than an in-process ONNX model. The swap should therefore land as a **model profile + `EmbeddingProvider` implementation**, with the local transformers.js provider being one implementation and the corpus manifest recording whichever produced the vectors — not as "replace one hardcoded repo id with another".

## Recommendation

1. Default local model: **harrier-oss-v1-270m**, int8, last-token pooling with template-aware truncation, query prefix `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `, documents bare.
2. Make the model a **parameter chosen from a closed, versioned set of profiles** (e.g. `--model harrier-270m|granite-97m|harrier-0.6b`), not a free-form repo id: each profile carries the repo id, dims, pooling, prefixes, truncation template and the `model_key` the manifest records, and only profiles verified against this bake-off and against the pinned transformers.js version are in the set. Keep **granite-97m-r2** in it as the lite profile (CLS pooling, no prefixes, 98 MB) for memory-constrained hosts, and **harrier-0.6b** as the quality profile for a hub that indexes once.
3. Batch the indexer's embeds (8 is enough; 32 gains nothing on CPU) — it halves harrier's cold-index time and is free for encoders.
4. Do not pick Qwen3-Embedding-0.6B, q4 variants, or CoreML.

## Open questions

- **English slice** is four queries; grow it before trusting EN deltas.
- **One vault.** The transliteration-heavy golden set favours cross-lingual models; a vault with long-form Ukrainian prose might rank granite-311m and harrier-270m closer. The script is cheap to re-run on the 4,900-note corporate vault, which also has a 14-query golden set.
- **int8 only.** fp32 might lift granite's numbers slightly; it would also triple its footprint, so it was not measured.
- **Block-level and fused pipelines** were not re-measured per model. Blocks reuse the same embedder, so relative ordering should hold, but `expansion` thresholds (`expansion_floor` 0.35 etc.) are calibrated to bge-micro's similarity scale and will need re-tuning for whichever model ships — the eval harness exists for that.
- **Reproducibility**: the bake-off ran from a throwaway script. Giving `npm run eval` a `--model` axis would make this comparison a repo capability rather than a session artefact.

## Sources

- Model cards and ONNX repos: [microsoft/harrier-oss-v1-270m](https://huggingface.co/microsoft/harrier-oss-v1-270m) · [onnx-community/harrier-oss-v1-270m-ONNX](https://huggingface.co/onnx-community/harrier-oss-v1-270m-ONNX) · [microsoft/harrier-oss-v1-0.6b](https://huggingface.co/microsoft/harrier-oss-v1-0.6b) · [onnx-community/harrier-oss-v1-0.6b-ONNX](https://huggingface.co/onnx-community/harrier-oss-v1-0.6b-ONNX) · [ibm-granite/granite-embedding-97m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2) · [onnx-community/granite-embedding-311m-multilingual-r2-ONNX](https://huggingface.co/onnx-community/granite-embedding-311m-multilingual-r2-ONNX) · [onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX)
- Granite R2 report, Table 5 (harrier-270m 66.4 vs granite-311m 65.2 on 18-task multilingual retrieval): [arXiv 2605.13521](https://arxiv.org/html/2605.13521v1)
- Independent Slavic-language evidence (harrier-0.6b > bge-m3 > Qwen3-0.6B on RU/PL): [arXiv 2609.12913](https://arxiv.org/html/2609.12913)
- Survey of what else appeared since June 2026 (EmbeddingGemma 2, jina v5, ML-Embed, EuroDense — all skipped, reasons in the issue comment): run in this session, 2026-10-12.
