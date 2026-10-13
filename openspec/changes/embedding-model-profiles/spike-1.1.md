# Spike 1.1 — the `@huggingface/transformers` 4.3.1 surface per profile

Throwaway probe (deleted afterwards), run on macOS arm64, Node 24.13.0, against
`@huggingface/transformers@4.3.1` installed with `--no-save`. Every profile was loaded at its
pinned revision with `AutoModel.from_pretrained(repo, { revision, dtype: 'q8', device: 'cpu' })`
and `AutoTokenizer.from_pretrained(repo, { revision })`, with `env.logLevel = LogLevel.ERROR`.
Contains no vault data: the only inputs were synthetic strings.

## Verdict

Nothing in the plan's snippets for Tasks 1.4, 1.5, 5.3 or 7.2 is contradicted. See "Plan
corrections" (none). Three facts the later tasks lean on deserve to be read first:

1. **Both harrier exports expose only a pooled `sentence_embedding`** (no `last_hidden_state`,
   no `token_embeddings`). Task 1.4's loader already falls back to `kind: 'pooled'` for exactly
   this case, so harrier profiles never reach `poolAndNormalize`'s token-state branch. The
   in-graph pooling is mask-aware and **assumes right padding** (see "Pooled-output behaviour").
2. `tokenizer.encode(text, { add_special_tokens })` is the correct v4 call shape and returns a
   plain `number[]`. It does **not** truncate on its own (`model_max_length` is `1e30` for
   bge-micro-v2 and harrier-270m, and 32768 / 131072 for granite / harrier-0.6b, so a 3000+
   token input comes back whole). Truncation is entirely the caller's job, which is what
   `encodeRow` does.
3. bge-micro-v2 under v4 is **not bit-identical** to what v2 produced from the same bytes
   (cosine 0.99836 on one sentence). See "bge-micro-v2 parity with v2".

## Per profile

| | bge-micro-v2 | granite-97m | harrier-270m | harrier-0.6b |
|---|---|---|---|---|
| repo @ revision | `TaylorAI/bge-micro-v2` @ `3edf6d7d…` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` @ `536a9f24…` | `onnx-community/harrier-oss-v1-270m-ONNX` @ `d59c919d…` | `onnx-community/harrier-oss-v1-0.6b-ONNX` @ `e4daffa0…` |
| `model.config.model_type` | `bert` | `modernbert` | `gemma3_text` | `qwen3` |
| `Object.keys(model.sessions)` | `["model"]` | `["model"]` | `["model"]` | `["model"]` |
| session `inputNames` | `input_ids`, `attention_mask`, `token_type_ids` | `input_ids`, `attention_mask` | `input_ids`, `attention_mask` | `input_ids`, `attention_mask` |
| session `outputNames` | `last_hidden_state` | `last_hidden_state` | **`sentence_embedding`** | **`sentence_embedding`** |
| `encode('a', {add_special_tokens:false})` | `[1037]` | `[64]` | `[236746]` | `[64]` |
| `encode('a', {add_special_tokens:true})` | `[101, 1037, 102]` | `[179934, 64, 179938]` | `[2, 236746, 1]` | `[64, 151643]` |
| derived template (full minus raw run) | prefix `[101]`, suffix `[102]` | prefix `[179934]`, suffix `[179938]` | prefix `[2]`, suffix `[1]` | prefix `[]`, suffix `[151643]` |
| `padding_side` | `right` | `right` | `right` | `right` |
| `pad_token_id` | `0` | `179935` | `0` | `151643` (equals the template suffix) |
| output dims, batch 1 × 3 (or 1 × 2) tokens | `last_hidden_state [1, 3, 384]` | `last_hidden_state [1, 3, 384]` | `sentence_embedding [1, 640]` | `sentence_embedding [1, 1024]` |
| output dims, batch 2 × 6 | `[2, 6, 384]` | `[2, 6, 384]` | `[2, 640]` | `[2, 1024]` |
| `encode(<~3000-token text>).length`, raw / full | 5700 / 5702 | 3301 / 3303 | 3002 / 3004 | 3601 / 3602 |
| ONNX file loaded | `onnx/model_quantized.onnx` (17,409,774 B) | `onnx/model_quantized.onnx` (97,858,099 B) | `onnx/model_quantized.onnx` + `model_quantized.onnx_data` (343,702,016 B) | `onnx/model_quantized.onnx` + `model_quantized.onnx_data` (706,117,632 B) |

(The long-text row used the same 53-character Ukrainian/English sentence repeated 300 times, so
lengths differ per tokenizer; it only demonstrates that `encode` does not truncate.)

Template ids match the read-only survey in every case, and match Task 7.2's `EXPECTED` table
(`bge-micro-v2` `[101]`/`[102]`, `granite-97m` `[179934]`/`[179938]`, `harrier-270m` `[2]`/`[1]`,
`harrier-0.6b` `[]`/`[151643]`, all `right`).

### `encode` call shape

* `tokenizer.encode(text, { add_special_tokens: false | true })` is accepted by all four tokenizers.
* It returns a plain `number[]` (`Array.isArray` true, `[object Array]`), not a typed array and
  not an object. Task 1.4's `TokenizerHandle.encode(...): number[]` is right.
* `tokenizer.encode(text)` with no options equals `add_special_tokens: true` (checked on all four).
* v4's typings: `encode(text: string, { text_pair, add_special_tokens, return_token_type_ids }?)`,
  `padding_side: string`, `pad_token_id: number` (declared non-optional). Task 1.4's
  `pad_token_id?: number` is a compatible superset for those members (the plan's
  `as unknown as` casts stay appropriate: the full `PreTrainedTokenizer` type is much wider).

### Session selection

Every export has exactly one session, keyed `model`. `Object.values(model.sessions)[0]` (Task
1.4) is the right session for all four; its `inputNames` / `outputNames` are the ones recorded
above.

### `from_pretrained` options

`AutoModel.from_pretrained(repo, { revision, dtype: 'q8', device: 'cpu' })` is accepted as-is
for all four. `dtype: 'q8'` resolves to `onnx/model_quantized.onnx` for every profile
(harrier's two files are split into a small graph file plus an external `*_data` weights file, which
loaded transparently).

### `token_type_ids` (bge-micro-v2)

bge-micro-v2's graph declares `token_type_ids` as a third input. The plan's loader passes only
`input_ids` + `attention_mask`, and **the forward call succeeds without `token_type_ids`**:
transformers.js fills it. Comparing `last_hidden_state` from the call without it against a call
with an explicit all-zeros `token_type_ids` gave a **max absolute difference of 0**, so the
auto-filled value is zeros (single-segment input). No plan change needed; this confirms design
D5 step 7.

### Pooled-output behaviour (harrier)

Since both harrier exports have only `sentence_embedding`, I checked what the in-graph pooling
does, using a short text `a` (5 chars) and a longer one `b`, batched with right padding:

| check (cosine of the short text's vector vs the same text embedded alone) | harrier-270m | harrier-0.6b |
|---|---|---|
| L2 norm of the alone vector | 0.99999996 | 1.00000005 |
| batched, right-padded, correct mask | 0.9999999999998 | 0.9999999999999 |
| batched, right-padded with a **different** pad id (7), correct mask | 0.9999999999998 | 0.9999999999999 |
| batched, right-padded, **all-ones** mask | 0.475 | 0.686 |
| batched, **left**-padded, correct mask | 0.309 | 0.022 |

Reading: the output is already L2-normalised (norm ≈ 1); it is invariant to padding when the mask
is right and the padding is on the right, and it genuinely reads the mask (all-ones mask changes
it); the pad id is irrelevant (so harrier-0.6b's pad id equalling its suffix id is harmless with a
mask). It is **not** left-padding-safe: the graph's last-token selection assumes right padding.
Both harrier tokenizers declare `padding_side: right`, and Task 5.3 pads on the declared side, so
the plan is consistent. The same measurements for the token-state exports:

| check (cosine of row 0 vs embedded alone) | granite-97m (CLS state) | bge-micro-v2 (CLS state) |
|---|---|---|
| right-padded, correct mask | 1.0000000000 | 0.99880 |
| right-padded, different pad id | 1.0000000000 | 0.99914 |

bge-micro-v2's 0.9988 is q8 dynamic-quantisation noise (the activation scales depend on batch
contents); it is the baseline for what "the same vector" means under this runtime for that model.

### bge-micro-v2 parity with v2

* v2's `onnx/model_quantized.onnx` and v4's are **the same file**: SHA-256
  `ed65e36025aa94cb74207dab863c85452919ec0ab7df3512092932aa22c9a33a`, 17,409,774 bytes. (v2's
  default `quantized: true` loads `onnx/model_quantized.onnx`; v4's `dtype: 'q8'` loads the same
  path.)
* **Token ids are identical** v2 vs v4 on three strings (ASCII, Cyrillic + English, punctuation /
  emoji / newline / tab): 17 / 21 / 19 ids, all equal.
* Vectors: v2 pipeline (`pooling: 'mean', normalize: true`) vs v4 (`q8`, own mean pooling, L2
  normalise) on one 70-character sentence: **cosine 0.99836, max abs component difference 0.0093**.
  Same bytes and same tokens, so the gap is the runtime (onnxruntime-node 1.14.0 under v2 vs 1.30.0
  under v4 — dynamic-quantisation kernels differ), not the model or the tokenizer. It is the same
  order as the batch-padding noise above (0.9988). Practical reading for the parity check in
  Task 3.2: existing bge-micro corpora are "valid" in the sense of the same model, revision and
  pooling, but a re-embedded vector will not match a stored one to better than roughly
  cosine 0.998. A test asserting bit-level or ~1e-6 equality with v2 vectors would fail; a
  cosine ≥ 0.99 threshold would hold on this evidence (one sentence only — widen the sample
  before relying on a tighter bound).

## stdout

The probe ran with stdout and stderr redirected separately. **stdout was 0 bytes** for all
probes (the four-profile load probe, the second behavioural probe, and the token-parity probe),
with `env.logLevel = LogLevel.ERROR` set. Downloads, session creation and four disposals wrote
nothing to stdout.

Two stderr observations, neither a stdout problem:

* When `@xenova/transformers` (v2, onnxruntime-node 1.14, sharp 0.32) and v4 (onnxruntime-node
  1.30, sharp 0.35) both run *inference* in one process, the process printed an
  `objc: Class GNotificationCenterDelegate is implemented in both …libvips…` warning (two libvips
  builds) and exited 134 after printing all results. Loading only the v2 *tokenizer* beside v4
  exited 0. This only exists while both packages are installed; Task 1.5 removes v2.
* The ONNX runtime emitted no warnings at `ERROR` level.

## `onnxruntime-node` install script

`@huggingface/transformers@4.3.1` pins `onnxruntime-node` to exactly `1.30.0` (nested under
`node_modules/@huggingface/transformers/node_modules/`, since the repo's root `node_modules`
still holds v2's `onnxruntime-node` 1.14.0) and `sharp ^0.35.4`.

`onnxruntime-node@1.30.0`'s `postinstall` is `node ./script/install`. Its `script/install.js` /
`script/install-utils.js` (`parseInstallFlag`) honour, in order:

1. env `ONNXRUNTIME_NODE_INSTALL` (or `npm_config_onnxruntime_node_install`), else
2. argv `--onnxruntime-node-install[=<value>]`.

Values: `skip` -> skip all optional downloads (`process.exit(0)`); `true`/`1`/`ON` -> force;
anything else is a manifest name (e.g. `cuda12`) validated against the platform's manifest list.
Deprecated aliases `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` / `--onnxruntime-node-install-cuda=skip`
also work. **`ONNXRUNTIME_NODE_INSTALL=skip` is the right variable**, so the plan's commands and
the CI `env:` block are correct as written.

What the script does per platform (`script/install-metadata.js` `requirements`): only
`linux/x64` has a non-empty list (`['cuda12']`) — on linux x64 without the flag it downloads
`libonnxruntime_providers_cuda.so` (and companions) from NuGet into `bin/napi-v6/linux/x64/`.
`darwin/arm64`, `darwin/x64`, `win32/*` and `linux/arm64` have `[]`: nothing is downloaded, the
script is a no-op regardless of the variable. Bundled in the package: `bin/napi-v6/{darwin/arm64
85 MB, linux/arm64 24 MB, linux/x64 44 MB, win32/arm64 69 MB, win32/x64 64 MB}`; `linux/x64` ships
`libonnxruntime.so.1` and `onnxruntime_binding.node` bundled and gets only the CUDA provider on
top. I could not observe the linux download from this macOS machine.

Caveat on what I actually ran: the install here was `npm install --no-save
@huggingface/transformers@4.3.1` **without** the variable (the sandbox rejected the
`VAR=value npm …` form), which is a no-op difference on darwin/arm64 per the script above.

## Install size

Measured with `du -sh` on the worktree's `node_modules` (the worktree's v2 packages stayed
installed throughout, so the delta is an upper bound on PR 1's net growth):

| | before | after | delta |
|---|---|---|---|
| `node_modules` | 399 MB | 876 MB | +477 MB |
| `node_modules/@huggingface` | (absent) | 448 MB | +448 MB |
| nested `…/@huggingface/transformers/node_modules/onnxruntime-node` | — | 287 MB | |
| nested `…/onnxruntime-web` | — | 140 MB | |
| root `node_modules/onnxruntime-node` (v2's 1.14) | 92 MB | 92 MB | 0 |
| root `node_modules/sharp` (v2's 0.32.6) | 24 MB | 24 MB | 0 |
| `node_modules/@img` (sharp 0.35 darwin-arm64 libvips etc.) | (absent) | 27 MB | +27 MB |
| `node_modules/@xenova` (to be removed in Task 1.5) | 45 MB | 45 MB | |

`npm install` reported "added 27 packages, changed 5 packages … in 5s" (warm npm cache).
Model download into `~/.cache/neuro-vault/models`: **1.2 GB** total (largest: harrier-0.6b weights
706 MB, harrier-270m 344 MB), about 9 minutes wall time on a cold cache.

Net effect once Task 1.5 uninstalls `@xenova/transformers` (45 MB + v2's onnxruntime-node 92 MB +
sharp 0.32 24 MB + their dependencies): roughly +300 MB for the dependency, dominated by
`onnxruntime-web` (140 MB) that transformers.js 4.x installs but this server never loads, plus
`onnxruntime-node`'s five platform binaries (287 MB nested).

## Plan corrections

None. Checked against the findings:

* Task 1.4 — `encode` signature and `number[]` return, `padding_side`, `pad_token_id`,
  `Object.values(model.sessions)[0]`, `REQUIRED_INPUTS = ['input_ids','attention_mask']` (bge's
  extra `token_type_ids` is auto-filled, not required of the caller), `TOKEN_STATE_OUTPUTS` then
  `sentence_embedding` fallback (exactly matches: bge/granite -> token states, harrier -> pooled),
  `dtype: 'q8'`, `device: 'cpu'`, `revision` option: all consistent.
* Task 1.5 — the over-long-input path uses `encode(..., { add_special_tokens: true })` then
  `.slice(0, maxTokens)`; this is valid because `encode` does not truncate (so v2's behaviour of
  capping `model_max_length` to 512, which the pipeline applied, is reproduced by the slice).
* Task 5.3 — padding with `pad_token_id ?? 0` on the declared side (`right` everywhere) is
  consistent; the fake-model tests do not depend on harrier exposing token states.
* Task 7.2 — `EXPECTED` templates and `side: 'right'` match the measured values exactly.

Not a plan error but worth a reviewer's eye later: the in-graph pooling of the harrier exports is
only validated here by padding-invariance (cosine ≈ 1 to 1e-13) and by sensitivity to the mask,
not by comparison against own last-token pooling over token states (none are exported). The
plan's design (D5 step 7) already routes harrier through `kind: 'pooled'` and relies on a
batch-invariance test; granite's `cls` pooling choice rests on the model card, which this spike
did not re-verify (the ONNX repos carry no `1_Pooling/config.json`).
