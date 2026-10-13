# ADR-0017 — Embedding models are a closed set of verified profiles

- **Status**: Accepted
- **Date**: 2026-10-13

## Context

[ADR-0013](0013-own-embedding-corpus.md) made the server own its corpus, and with it one hardcoded model: `TaylorAI/bge-micro-v2` (384 dims, mean pooling), run through the transformers.js feature-extraction pipeline. Its identity was a set of constants in `src/lib/obsidian/corpus/types.ts` that six modules read directly — the manifest builders, the shard store's dimension check, the embedding service, `config.ts` and the eval harness — so swapping the model meant six coordinated edits.

That model fails the quality bar. On the owner's golden set its Ukrainian MRR is 0.317, against a gate of 0.4. The bake-off ([`docs/research/2026-10-embedding-model-bakeoff.md`](../research/2026-10-embedding-model-bakeoff.md), #98) found models that clear it, and three engineering facts that any swap has to absorb:

1. transformers.js runs the tokenizer's post-processor (BOS/EOS) **before** truncating, so every input over the cap loses its trailing special token. For a last-token-pooled model the vector then belongs to whatever mid-sentence token sits at the cut; Qwen3 scored UA MRR 0.164 that way and 0.611 once tokenisation was done by hand.
2. The character budget (`512 × 3.7`) matches no model: measured chars per token were 1.63 for bge-micro and 2.3–2.9 for granite and harrier.
3. One model per process is already the invariant — the server builds one embedding service shared by every vault, and `index` builds one embed function the same way.

The hub may also embed remotely (#126), so the seam must not assume a local model.

## Decision

Embedding models are a **closed, versioned registry of verified profiles** (`src/modules/semantic/model-profiles.ts`), chosen with `--model <key>` on both the server and `index`. A profile is the one record that holds everything model-specific: repository, pinned revision, dtype, dimensions, pooling, query and document prefixes, token limit, and the similarity defaults. A profile joins the registry only after it has been measured on the retrieval eval and verified against the pinned transformers.js version. No input ever names a repository; an unknown key is rejected at parse time with the allowed list.

| key            | role    | download | dims | pooling    |
| -------------- | ------- | -------- | ---- | ---------- |
| `harrier-270m` | default | ≈ 344 MB | 640  | last_token |
| `granite-97m`  | lite    | ≈ 98 MB  | 384  | cls        |
| `harrier-0.6b` | quality | ≈ 706 MB | 1024 | last_token |

Each is int8 (`q8`) and pinned to an exact repository commit, never a branch, so the weights and tokenizer a profile was measured against cannot change under it. Upgrading a revision is a reviewed one-line change, and the manifest sees it. `bge-micro-v2` leaves the registry.

The provider seam is an `EmbeddingProvider` with an `identity`, `embedQuery` and `embedDocuments`. Queries and documents are separate calls because harrier's query instruction is asymmetric: with a single `embed(text)`, either every caller learns about prefixes or the provider guesses, and both fail silently. The provider applies the prefix, so no caller can forget it. `identity` is how a provider, local or remote, tells the manifest what produced its vectors. The corpus library receives that identity as data and imports no model constants.

The local provider owns tokenisation for every profile, so the registry has one truncation semantics and one test suite. It encodes content without special tokens, derives the profile's special-token template from the tokenizer, truncates the content to `max_tokens` minus the template and the query prefix, re-attaches the template, pads on the side the tokenizer declares, and pools by the attention mask (masked mean, first unmasked token, or last unmasked token). Last-token pooling finds its position from the mask, never from the pad id, because harrier-0.6b's pad id equals its template suffix. This is the fix for fact 1, and a unit test fails against the "special tokens, then truncate" behaviour. Truncation is by tokens, which retires the character budget (fact 2).

Similarity defaults are per-profile data, because an encoder-CLS model and a decoder-last-token model do not share a similarity scale. They are calibrated by distribution matching against the bge-micro baseline, with golden-set guards:

- `quick`, `deep`, `similarNotes` and `duplicates` are set to the threshold at which the same share of the profile's population passes as bge-micro's default did, rounded down to two decimals. The populations are unranked: query against every note, note against every note, and each note's maximum similarity to any other. A ranked population would not do: five of bge's six defaults passed 100 % of it, and "reproduce 100 %" only means "the new population's minimum".
- `fallback` and `expansionFloor` passed 1.0 even of the unranked populations, so on bge they cut nothing. Each is set just below the profile's own unranked-population minimum, rounded down to 0.05, keeping `fallback < deep`.
- Two guards are then checked on the golden set: no first-relevant hit that threshold 0 finds in the deep pool is filtered out by `deep` (`deep_filtered_first_relevant` = 0), and `quick` costs at most one query of hit@3. A failing guard lowers the threshold. None failed.

The manifest becomes v2 and records the producing identity: `embed_version`, `provider`, `model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens`, `strategy`, `created`. Every field that changes a stored vector is in it; the query prefix is not, since it changes none. Compatibility compares every field except `created`. A mismatch rebuilds the corpus automatically, as ADR-0013 intended, but no longer silently: the server writes one stderr line per vault naming the stored and active model, and `index` prints a rebuild line, when it discards the corpus. A legacy manifest still parses, so it can be named.

## Consequences

**Cost, measured.** Every vault re-indexes once on first start with the new build; lexical search keeps working while it does. On the owner's vault (949 notes, 888 with a note vector; Apple M5, CPU, int8), a cold index took 8.8 min for `harrier-270m` and 3.5 min for `granite-97m`. These runs shared the CPU with other work, so read them as the upper side. The bake-off put harrier-270m's cold index at roughly 2.5–4× bge-micro-v2's, and granite-97m's at about the same as bge-micro-v2's. The bake-off extrapolates a ~56k-vector vault to about 24 min for granite and 55–100 min for harrier-270m. Peak RSS while indexing was 1.32 GB for harrier-270m and 1.20 GB for granite-97m. The bake-off's measuring script peaked near 1.9 GB for harrier-270m, but it also held the whole corpus and token statistics in memory, so that figure is an upper bound on serving, not a measurement of it. The default download grows from 17 MB to about 344 MB. Query latency is about 54 ms for harrier-270m (2 ms granite-97m, 189 ms harrier-0.6b), which hides behind an MCP round trip.

**Quality.** Ukrainian MRR rises from 0.317 in the bake-off (0.321 on the calibration baseline) to 0.694 on the same golden set with harrier-270m; overall MRR 0.398 → 0.709, hit@3 0.400 → 0.800. English missed the acceptance bar. This run's EN MRR for harrier-270m is 0.786 against the bake-off's 0.812 for the same model; the difference is one query at rank 7 instead of rank 4, which is what puts EN below the 0.8 bar and below bge-micro's 0.800. The EN slice has n = 4, so the figure separates "broke" from "did not break" and nothing finer. We accept it, and the golden set needs more English queries before this column can mean anything.

Calibrated defaults and quality, per profile (UA/EN MRR are semantic-only on the golden set, 21 UA and 4 EN queries):

| key            | quick | deep | fallback | expansionFloor | similarNotes | duplicates | UA MRR   | EN MRR   |
| -------------- | ----- | ---- | -------- | -------------- | ------------ | ---------- | -------- | -------- |
| `harrier-270m` | 0.20  | 0.13 | 0.05     | 0.20           | 0.22         | 0.77       | 0.694    | 0.786    |
| `granite-97m`  | 0.71  | 0.66 | 0.65     | 0.65           | 0.67         | 0.90       | 0.463    | 1.000    |
| `harrier-0.6b` | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| bge-micro-v2 (retired) | 0.50 | 0.35 | 0.30 | 0.35 | 0.50 | 0.90 | 0.321 | 0.800 |

Guards at the chosen values: `deep_filtered_first_relevant` and `quick_hit_at_3_drop` are 0 for harrier-270m and granite-97m, and TBD-12.1 for harrier-0.6b. `deep` and `similarNotes` come from the far tail of their bge populations (0.09 % and 0.03 % of pairs cut), so they rest on a few dozen to a few hundred extreme pairs and are sensitive to them. A future recalibration should expect those two to move.

Acceptance of the default profile on the vault copy: cold index wall time TBD-12.1, peak RSS TBD-12.1; semantic MRR TBD-12.1; fused MRR TBD-12.1; `granite-97m` end to end through the server TBD-12.1.

**Operations.**

- A server and an `index` run given different `--model` values on one vault discard and rebuild each other's corpus. The stderr lines make it visible, and the docs say to keep the two equal. The corpus keeps one directory per vault, so comparing profiles on a vault re-indexes it each time.
- The `SEMANTIC_INDEX_NOT_FOUND` hint (`src/lib/resolve-vault.ts`) still says `neuro-vault-mcp index --vault <path>` without `--model`. It does not carry the active profile yet; this is a known gap, left as a follow-up.
- The local loader sets a stable model cache (`$XDG_CACHE_HOME/neuro-vault/models`, else `~/.cache/neuro-vault/models`) and silences library logging so it stays off the MCP stdout. `engines.node` is `>=20.9.0` because transformers.js 4.x depends on `sharp`.
- A real tokenizer's behaviour cannot be observed from source-level tests, so a CI job (`profile-tokenizers`, `test/integration/profile-tokenizers.test.ts`) loads every profile's tokenizer at its pinned revision and asserts the derived template, the padding side, and that a >512-token input encodes to exactly `max_tokens` ids ending in the template suffix. It downloads tokenizers only, not weights, and caches them. A deleted or rewritten upstream revision fails it loudly.
- The decision constrains what follows: a new model is a new profile with its own measurement, calibration and tokenizer check, not a string passed through. A remote provider implements `EmbeddingProvider` and reports its own identity.

## Alternatives considered

- **Free-form repository ids** — nothing would pin a revision, verify the tokenizer template, or give the thresholds a scale to live on; any typo or upstream change becomes silently different vectors.
- **Qwen3-Embedding-0.6B** — clearly lower quality than harrier-0.6b in the bake-off (UA MRR 0.611 against 0.758, EN 0.625 against 0.875) and a larger peak memory (~4.5 GB against ~3.5 GB in the measuring script). It is smaller and faster per query (614 against 706 MB, 28 against 189 ms), but that does not buy back the quality loss.
- **q4 quantisation** — smaller file but slower on CPU than int8 (6.4 against 9–14 vectors/s for harrier-270m).
- **CoreML** — slower than CPU on the quantised graph, and macOS-only, while production is Linux CPU.
- **Per-profile corpus directories** — stale corpora would accumulate unseen, and one profile per process makes switching rare; discarding and rebuilding is simpler and is the lever ADR-0013 already established.
- **One threshold set for all profiles** — wrong for at least two of three scales, and `--model granite-97m` would not work end to end.
- **Keeping the feature-extraction pipeline** — it truncates after the post-processor and pools by physical position, so the lost-EOS defect cannot be fixed from outside; the truncated sequence is already gone.
