# Embedding Models

The semantic leg of `search_notes` — and `get_similar_notes` and `find_duplicates` — ranks notes by comparing embedding vectors the server computes itself, on your machine, with a local model. This page covers which model to run, how to run it, what switching costs, and how the models measure up.

You do not have to read it to get started: the default works out of the box. Come here when you want a lighter install, better retrieval, or an explanation of the numbers.

## The profiles

A model is chosen by a **profile key**. The set is closed — three keys — because each profile bundles everything model-specific (pinned weights, pooling, query prefix, token window, similarity thresholds) and is only added after it has been measured on a retrieval benchmark. You pick one with `--model <key>`; one model serves every vault the server has registered.

| Key | For | Hugging Face repo | Dims | Pooling | Download | Cold index¹ | Peak RAM while indexing¹ | Query latency² |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `harrier-270m` | **default** — balanced quality and cost | `onnx-community/harrier-oss-v1-270m-ONNX` | 640 | last token | ≈ 344 MB | 8.8 min | 1.32 GB | ~54 ms |
| `granite-97m` | **lite** — small hosts, fast first index | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | 384 | CLS | ≈ 98 MB | 3.5 min | 1.20 GB | ~2 ms |
| `harrier-0.6b` | **quality** — when retrieval quality matters more than index time | `onnx-community/harrier-oss-v1-0.6b-ONNX` | 1024 | last token | ≈ 706 MB | TBD-12.1 | TBD-12.1 | ~189 ms |

¹ Measured on a copy of the author's private vault (949 notes, 888 with a note vector), Apple M5 (4 performance + 6 efficiency cores), CPU only, int8 weights. The indexing runs overlapped other CPU work, so read the times as upper-side. Cost scales with the number of vectors (one per note plus one per section): extrapolating from a separate benchmark, a vault of about 56,000 vectors takes roughly 24 minutes with `granite-97m` and 55–100 minutes with `harrier-270m`.

² Median, single query, CPU.

All profiles run quantised (`q8`) with a 512-token input window, and all are multilingual. Day-to-day cost is small whatever you pick: after the first index, only notes that changed are re-embedded.

How the pipeline works: [`docs/architecture/embedding-pipeline.md`](../architecture/embedding-pipeline.md#profiles).

## Choosing

- **`harrier-270m` — most people.** Much better on Ukrainian notes than the lite model, comparable on the few English queries measured, and a first index measured in minutes on a vault of about a thousand notes. It is the default for that reason.
- **`granite-97m` — small hosts or a fast first index.** Under a third of the download, about 40 % of the indexing time, and the lowest memory and query latency of the three. On this benchmark its Ukrainian retrieval is clearly behind the harrier models (see [Benchmarks](#benchmarks)), so choose it when resources, not recall, are the constraint.
- **`harrier-0.6b` — quality first.** The largest model: use it when you do not mind a long first index and have the RAM and download to spare.

Language quality in one line each, from the [measurements below](#benchmarks): on Ukrainian queries (21 of the 25), `harrier-270m` reaches an MRR of 0.694 against `granite-97m`'s 0.463; on the four English queries the lite model happens to score higher, but four queries are too few to rank models on — see the caveat there.

## Configuring

Add `--model <key>` to the server's `args` in your MCP client config. For Claude Code (`~/.claude/settings.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "neuro-vault": {
      "command": "neuro-vault-mcp",
      "args": ["--vault", "/absolute/path/to/your/vault", "--model", "harrier-0.6b"]
    }
  }
}
```

Leave `--model` out to get the default, `harrier-270m`.

**Pre-warming with `index`.** The first index of a vault runs in the background when the server starts, and `search_notes` answers from its lexical leg until it finishes. To do that work ahead of time, run the `index` subcommand with the same `--model`:

```bash
neuro-vault-mcp index --vault /absolute/path/to/your/vault --model harrier-0.6b
```

The `SEMANTIC_INDEX_NOT_FOUND` error's hint prints `neuro-vault-mcp index --vault <path>` without `--model` — add yours when your server runs a non-default model.

**Where the model lives.** Weights download on first use into `$XDG_CACHE_HOME/neuro-vault/models` when `XDG_CACHE_HOME` is an absolute path, otherwise `~/.cache/neuro-vault/models`. Each profile is fetched once per machine and shared across upgrades; switching back to a model you used before does not download it again.

**CPU-only Linux x64.** onnxruntime's install script starts a CUDA provider download on that platform. If you have no GPU, skip it when installing:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install -g neuro-vault-mcp
```

Other platforms download nothing extra. Install and first-run details: [Installation](./installation.md#first-run-behavior).

## Switching models

A vault has **one corpus, built by one model** — vectors from two models do not live in the same space, and two models of equal width would score as noise rather than fail. So changing `--model` discards the vault's corpus and re-indexes it from scratch. Nothing is ever mixed silently.

What you will see:

- The server prints one line per vault on stderr:

  ```text
  neuro-vault corpus: vault "<name>" was indexed with <stored> (embed_version <n>); active model is <active> (embed_version <m>) — discarding the corpus and re-indexing in the background
  ```

  The `index` subcommand prints `rebuilding <name>: corpus was indexed with <stored>; active model is <active>` before its progress.
- While the rebuild runs, `search_notes` reports `semantic_status: { state: "indexing", indexed, total }` and keeps answering from its **lexical leg** — lexical search is unaffected. `get_similar_notes` and `find_duplicates` return `SEMANTIC_INDEX_BUILDING` until it finishes.
- A fresh vault with no corpus is not a rebuild, just a first index.

Two practical rules:

- **Keep the server and `index` on the same `--model`.** If they differ, each rebuilds the other's corpus every time it runs.
- **Upgrading from a release with a different default model rebuilds every vault once**, for the same reason. Run `neuro-vault-mcp index --vault <path>` after upgrading if you would rather pay that cost ahead of time.

An unknown key fails at startup with an error that lists the valid keys.

More on why a model change is a rebuild: [`docs/architecture/own-corpus.md`](../architecture/own-corpus.md#a-model-change-is-a-rebuild-and-never-silent).

## Similarity thresholds per model

Every model spreads its cosine similarities over its own range, so a fixed cut-off would be right for one model and wrong for the others. Each profile therefore carries six calibrated defaults, used whenever you do not pass `threshold` / `expansion_floor` yourself:

| Default | `harrier-270m` (default) | `granite-97m` | `harrier-0.6b` | Governs |
| --- | --- | --- | --- | --- |
| `quick` | 0.20 | 0.71 | TBD-12.1 | `search_notes` semantic floor at `effort: "quick"` |
| `deep` | 0.13 | 0.66 | TBD-12.1 | `search_notes` semantic floor at `effort: "deep"`; also the block-evidence floor |
| `fallback` | 0.05 | 0.65 | TBD-12.1 | one-shot retry floor when a default finds nothing |
| `expansionFloor` | 0.20 | 0.65 | TBD-12.1 | `search_notes` expansion leg (`expansion_floor`) |
| `similarNotes` | 0.22 | 0.67 | TBD-12.1 | `get_similar_notes` `threshold` |
| `duplicates` | 0.77 | 0.90 | TBD-12.1 | `find_duplicates` `threshold` |

How they were derived: on the author's vault, each model's threshold is the value at which the same share of the vault's similarity scores passes as did under the reference model the original defaults were tuned on, rounded down; floors that cut nothing on that reference are set just below each profile's own minimum; and two checks on the labelled queries then confirm that `deep` filters out no relevant first hit and that `quick` keeps hit@3 within one query of unfiltered. The full method, the guards and the aggregates are in [ADR-0017](../adr/0017-embedding-model-profiles.md) and [`docs/architecture/retrieval-policy.md`](../architecture/retrieval-policy.md#calibration).

You can read the numbers in force from the `search_notes` tool description, which quotes the active model's `quick`, `deep`, `fallback` and `expansionFloor`; `get_similar_notes` and `find_duplicates` apply their defaults without quoting them.

**An explicit `threshold` is on the active model's scale and does not carry over to another model.** A value copied from a `granite-97m` setup (say `0.7`) filters nearly everything out on `harrier-270m`; one tuned on `harrier-270m` (say `0.2`) lets almost everything through on `granite-97m`. When you switch models, drop explicit thresholds and let the defaults apply, or re-tune against the new table. Tuning advice: [Finding Notes → Tuning threshold](./finding-notes.md#tuning-threshold-semantic-leg).

## Benchmarks

Measured on **2026-10-13** on a copy of the author's private vault: **949 notes in scope, 888 with a note vector**. The golden set is **25 queries — 21 Ukrainian, 4 English** — each with the notes a person would consider the right answers. Numbers are aggregates only. The semantic leg alone is scored (no lexical leg, no expansion, no similarity threshold), so the table compares the models' ranking quality and nothing else.

- **MRR** (mean reciprocal rank) — the mean of 1 ÷ the rank of the first correct note in the top 10; 1.0 means the right note is always first.
- **hit@3** — the share of queries with a correct note in the top 3.

| Model | MRR overall | MRR UA | MRR EN | hit@3 overall | hit@3 UA | hit@3 EN |
| --- | --- | --- | --- | --- | --- | --- |
| `harrier-270m` (default) | 0.709 | 0.694 | 0.786 | 0.800 | 0.810 | 0.750 |
| `granite-97m` | 0.549 | 0.463 | 1.000 | 0.600 | 0.524 | 1.000 |
| `harrier-0.6b` | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 |

For the default model, the full `search_notes` pipeline (semantic + lexical + expansion fused) scores a **fused MRR of TBD-12.1** on the same queries.

**Read the English column with care.** It rests on four queries, and a single query moving from first place to seventh shifts English MRR by up to 0.25 (each English query is worth a quarter of the slice). `harrier-270m`'s 0.786 is exactly that: one query landing at rank 7 rather than near the top. The Ukrainian slice (21 queries) and the overall figures are the more reliable signal, and the vault is one person's, mostly Ukrainian — your notes may rank differently.

Times are in [The profiles](#the-profiles). To reproduce the comparison on your own vault, use a copy (a vault has one corpus, and indexing it for another model discards the first), and follow the procedure in [`eval/README.md`](../../eval/README.md#axis-model): for each model run `neuro-vault-mcp index --vault <copy> --model <key>`, then the eval harness on the same copy with the same `--model`. The harness needs a golden set of your own queries; the format is described there. The research behind the model choice is in the [embedding bake-off report](../research/2026-10-embedding-model-bakeoff.md).
