# Embedding Model Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `bge-micro-v2` embedding model with a closed registry of verified model profiles (`harrier-270m` default, `granite-97m`, `harrier-0.6b`) selected by `--model`, with provider-owned template-aware tokenisation, batched indexing, a manifest that records what produced the vectors, per-profile recalibrated similarity thresholds, and an eval model axis.

**Architecture:** A `ModelProfile` record in `src/modules/semantic/model-profiles.ts` becomes the single source of everything model-specific. The local `EmbeddingService` loads the profile's tokenizer and ONNX model through `@huggingface/transformers` 4.3.1 behind a small loader seam, encodes and pools itself, and reports an `EmbeddingIdentity`; the corpus library receives that identity as data and never reads model constants. Four PRs, each independently mergeable, with a review stop after each.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 20.9, `@huggingface/transformers` 4.3.1 (`onnxruntime-node` 1.30), yargs, vitest, eslint (type-aware).

**Spec:** `openspec/changes/embedding-model-profiles/design.md` (decisions D1–D15) and `openspec/changes/embedding-model-profiles/specs/*/spec.md`. Task numbers below match `tasks.md`.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` pass at every commit; `npm run build` passes before every PR. `npm run typecheck` (`tsc --noEmit`) is authoritative.
- `@huggingface/transformers` is pinned to exactly `4.3.1` (no caret). Profiles are verified against this version.
- Pinned revisions, verbatim: `TaylorAI/bge-micro-v2` @ `3edf6d7de0faa426b09780416fe61009f26ae589`; `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` @ `536a9f241cb3f02a9c5995a1e708c784bd274859`; `onnx-community/harrier-oss-v1-270m-ONNX` @ `d59c919d0159aea2c19ed7d04288fcdd048d0f9c`; `onnx-community/harrier-oss-v1-0.6b-ONNX` @ `e4daffa011e666dcd2ff2a3c6c05084090ac314d`.
- harrier query prefix, verbatim: `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ` (a real newline before `Query`). Documents carry no prefix for every profile.
- `package.json` `engines.node` = `>=20.9.0` from PR 1 on.
- `src/lib/obsidian/corpus/` never imports from `src/modules/`.
- Nothing in `src/` writes to stdout except the CLI's own `--help`/`--version`/`index` output; library warnings go through an injected `warn` defaulting to `console.error`.
- Tool tests reach tools through `registerTool(...)` and `test/_gate.ts` helpers, never `.handler` directly.
- No private vault paths or note titles in any committed file. Verification results are committed as aggregates only.
- Commits: Conventional Commits, each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PRs via `gh pr create` to `main`; PRs 1–3 say `Refs #98`, PR 4 says `Closes #98`. Never push to `main`.
- **One PR at a time.** Start each PR from a fresh worktree off `origin/main` after the previous PR merged (PR 1's branch is `feat/embedding-model-profiles`, which already carries the committed change folder). Before dispatching a PR's first task, re-read that PR's tasks against `main` — a review of the previous PR may have renamed something these snippets use; fix the snippets first.
- **Verification vault.** Every run against real data uses a copy of the owner's vault so no run fights a live MCP server over the corpus:
  ```bash
  SCRATCH=<this session's scratchpad directory>
  VAULT_COPY="$SCRATCH/vault-copy/Obsidian"
  mkdir -p "$SCRATCH/vault-copy" && rsync -a --delete /Users/amostovenko/Obsidian/ "$VAULT_COPY/"
  ```
  The copy keeps the vault's `.git` (so `vault_sha` stays meaningful), its golden set and — for PR 1 — its existing bge-micro corpus.
- Throwaway probe scripts that need `node_modules` live at the worktree root under a name you own (`probe-*.mjs`) and are deleted by exact name afterwards. Never write to, or delete, the repo's `.scratch/` directory.

## Review Focus

1. **`--model` passed twice** (`--model granite-97m --model bge-micro-v2`): yargs turns it into an array. Expect a clear "may be given only once" error, not a crash or a silent pick. → test in Task 2.4.
2. **A relative `XDG_CACHE_HOME`**: the XDG spec says to ignore it. Expect the model cache to fall back to `~/.cache/neuro-vault/models`, not to a directory relative to whatever cwd the MCP client launched the server from. → test in Task 1.4.
3. **Content that itself contains the template-suffix id at the truncation boundary** (a note with a literal `<eos>` / `<|endoftext|>`): expect the row to still be exactly `maxTokens` long and to end with the real template suffix, and last-token pooling to pick that final real position. → test in Task 5.2.
4. **Two vaults indexing at once** (two concurrent `embedDocuments` calls whose buckets interleave in the index lane): expect each call to get back exactly its own vectors, in its own input order. → test in Task 6.1.
5. **A blank text inside a document batch**: expect `embedDocuments` to reject naming the input index, before any model call — never to embed the bare template and return a plausible-looking vector. → test in Task 5.3.

---

# PR 1 — transformers.js 4.x, profile registry, `--model` (`Refs #98`)

### Task 1.1: Spike — confirm the transformers.js 4.3.1 surface per profile

Throwaway. Nothing under `src/` or `test/` changes. Output: `openspec/changes/embedding-model-profiles/spike-1.1.md` (committed; contains no vault data).

**Files:**
- Create (then delete): `probe-transformers-v4.mjs` at the worktree root
- Create: `openspec/changes/embedding-model-profiles/spike-1.1.md`

- [ ] **Step 1: Install the library without saving it**

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install --no-save @huggingface/transformers@4.3.1
```

Note the time and the size of `node_modules` before/after (`du -sh node_modules`) for the PR description. If `ONNXRUNTIME_NODE_INSTALL=skip` is not honoured by `onnxruntime-node@1.30.0`'s `script/install.js`, read that script and record the variable it does honour.

- [ ] **Step 2: Write the probe**

```js
// probe-transformers-v4.mjs — throwaway; delete after recording findings.
import os from 'node:os';
import path from 'node:path';
import { AutoModel, AutoTokenizer, LogLevel, Tensor, env } from '@huggingface/transformers';

env.cacheDir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'neuro-vault', 'models');
env.logLevel = LogLevel.ERROR;

const PROFILES = [
  ['TaylorAI/bge-micro-v2', '3edf6d7de0faa426b09780416fe61009f26ae589'],
  ['onnx-community/granite-embedding-97m-multilingual-r2-ONNX', '536a9f241cb3f02a9c5995a1e708c784bd274859'],
  ['onnx-community/harrier-oss-v1-270m-ONNX', 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c'],
  ['onnx-community/harrier-oss-v1-0.6b-ONNX', 'e4daffa011e666dcd2ff2a3c6c05084090ac314d'],
];

const int64 = (rows) =>
  new Tensor('int64', BigInt64Array.from(rows.flat().map(BigInt)), [rows.length, rows[0].length]);

for (const [repo, revision] of PROFILES) {
  const tokenizer = await AutoTokenizer.from_pretrained(repo, { revision });
  const raw = tokenizer.encode('a', { add_special_tokens: false });
  const full = tokenizer.encode('a', { add_special_tokens: true });
  const model = await AutoModel.from_pretrained(repo, { revision, dtype: 'q8', device: 'cpu' });
  const sessions = Object.fromEntries(
    Object.entries(model.sessions).map(([name, s]) => [name, { inputs: s.inputNames, outputs: s.outputNames }]),
  );
  const out = await model({ input_ids: int64([full]), attention_mask: int64([full.map(() => 1)]) });
  console.error(
    JSON.stringify({
      repo,
      raw,
      full,
      padding_side: tokenizer.padding_side,
      pad_token_id: tokenizer.pad_token_id,
      sessions,
      output_dims: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.dims])),
    }),
  );
  await model.dispose();
}
```

- [ ] **Step 3: Run it with stdout and stderr separated**

```bash
node probe-transformers-v4.mjs > "$SCRATCH/probe-stdout.txt" 2> "$SCRATCH/probe-stderr.txt"; echo "exit=$?"
wc -c "$SCRATCH/probe-stdout.txt"
```

Expected: exit 0; `probe-stdout.txt` is **0 bytes** (anything there would corrupt the MCP stdio transport — if it is non-empty, record what wrote it). Downloads total ≈ 1.2 GB on a cold cache.

- [ ] **Step 4: Record the findings**

Write `spike-1.1.md` with one section per profile: first-session input names, output names (does the export have `last_hidden_state` / `token_embeddings`, or only `sentence_embedding`?), `padding_side`, `pad_token_id`, the derived template (`full` minus the `raw` run), and the output dims. Expected from the read-only survey: harrier-270m `[2] … [1]`, right; harrier-0.6b `… [151643]`, right, pad 151643; granite `[179934] … [179938]`, right; bge-micro `[101] … [102]`. Add the install-size delta and whether stdout stayed empty.

- [ ] **Step 5: Correct the plan if reality differs**

If any finding contradicts a snippet in Tasks 1.4, 1.5, 5.3 or 7.2 (input/output names, padding side, template ids, option names), edit those snippets in `plan.md` now and say so in `spike-1.1.md`.

- [ ] **Step 6: Clean up and commit**

```bash
rm probe-transformers-v4.mjs
git checkout -- package.json package-lock.json 2>/dev/null || true
git add openspec/changes/embedding-model-profiles/spike-1.1.md openspec/changes/embedding-model-profiles/plan.md
git commit -m "docs(openspec): record the transformers.js 4.3.1 spike for embedding-model-profiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.2: The model profile registry

**Files:**
- Create: `src/modules/semantic/model-profiles.ts`
- Modify: `src/lib/obsidian/corpus/types.ts` (add `EmbeddingIdentity`)
- Test: `test/semantic/model-profiles.test.ts`

**Interfaces:**
- Produces: `type Pooling = 'mean' | 'cls' | 'last_token'`; `interface ModelProfile { key; repo; revision; dtype: 'q8'; dims; pooling; queryPrefix; documentPrefix; maxTokens }`; `LOCAL_PROVIDER = 'transformers.js'`; `MODEL_PROFILES`; `DEFAULT_MODEL_KEY`; `MODEL_KEYS: readonly string[]`; `resolveModelProfile(key: string): ModelProfile`; `identityOf(profile): EmbeddingIdentity`. In `corpus/types.ts`: `interface EmbeddingIdentity { provider; model_key; model_id; revision; dtype; dims; pooling; max_tokens }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/semantic/model-profiles.test.ts
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_KEY,
  LOCAL_PROVIDER,
  MODEL_KEYS,
  identityOf,
  resolveModelProfile,
} from '../../src/modules/semantic/model-profiles.js';

describe('model profile registry', () => {
  it('holds exactly the verified profiles, bge-micro-v2 by default', () => {
    expect([...MODEL_KEYS].sort()).toEqual(['bge-micro-v2', 'granite-97m']);
    expect(DEFAULT_MODEL_KEY).toBe('bge-micro-v2');
  });

  it('pins every profile to an exact 40-hex revision, int8', () => {
    for (const key of MODEL_KEYS) {
      const profile = resolveModelProfile(key);
      expect(profile.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(profile.dtype).toBe('q8');
    }
  });

  it('rejects an unknown key, listing the allowed ones', () => {
    expect(() => resolveModelProfile('bge-m3')).toThrow(
      'unknown model "bge-m3" — choose one of: bge-micro-v2, granite-97m',
    );
  });

  it('does not accept a repository id as a key', () => {
    expect(() => resolveModelProfile('TaylorAI/bge-micro-v2')).toThrow(/unknown model/);
  });

  it('does not resolve inherited object keys', () => {
    expect(() => resolveModelProfile('toString')).toThrow(/unknown model/);
    expect(() => resolveModelProfile('__proto__')).toThrow(/unknown model/);
  });

  it('describes granite-97m as the lite CLS profile', () => {
    expect(resolveModelProfile('granite-97m')).toMatchObject({
      repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
      revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
      dims: 384,
      pooling: 'cls',
      queryPrefix: '',
      documentPrefix: '',
      maxTokens: 512,
    });
  });

  it("reproduces today's corpus identity for bge-micro-v2", () => {
    expect(identityOf(resolveModelProfile('bge-micro-v2'))).toEqual({
      provider: LOCAL_PROVIDER,
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
      dtype: 'q8',
      dims: 384,
      pooling: 'mean',
      max_tokens: 512,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/model-profiles.test.ts`
Expected: FAIL — `Cannot find module '../../src/modules/semantic/model-profiles.js'`.

- [ ] **Step 3: Add `EmbeddingIdentity` to the corpus types**

Append to `src/lib/obsidian/corpus/types.ts`, after `CorpusManifest`:

```ts
/**
 * What produced a corpus's vectors, as the embedding provider reports it
 * (design D4). The corpus records this; it never derives it from constants
 * of its own, so a remote provider can describe itself the same way.
 */
export interface EmbeddingIdentity {
  provider: string;
  model_key: string;
  model_id: string;
  revision: string;
  dtype: string;
  dims: number;
  pooling: string;
  max_tokens: number;
}
```

- [ ] **Step 4: Write the registry**

```ts
// src/modules/semantic/model-profiles.ts
import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

/** How a model's token states become one vector. */
export type Pooling = 'mean' | 'cls' | 'last_token';

/**
 * Everything model-specific, in one record (design D2). A profile joins the
 * registry only after it has been measured on the retrieval eval and verified
 * against the pinned transformers.js version, so the registry is closed on
 * purpose: no input ever names a repository directly.
 */
export interface ModelProfile {
  /** Registry key — what `--model` takes and the manifest records as `model_key`. */
  readonly key: string;
  /** Hugging Face repository the tokenizer and weights load from. */
  readonly repo: string;
  /** The exact repository commit the profile was verified against; never a branch. */
  readonly revision: string;
  readonly dtype: 'q8';
  readonly dims: number;
  readonly pooling: Pooling;
  /** Prepended to every query by the provider; callers never add it. */
  readonly queryPrefix: string;
  /** Prepended to every document by the provider. */
  readonly documentPrefix: string;
  /** Input window in tokens of this profile's tokenizer, special tokens included. */
  readonly maxTokens: number;
}

/** The provider name every identity of this package's local provider carries. */
export const LOCAL_PROVIDER = 'transformers.js';

const BGE_MICRO_V2: ModelProfile = {
  key: 'bge-micro-v2',
  repo: 'TaylorAI/bge-micro-v2',
  revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
  dtype: 'q8',
  dims: 384,
  pooling: 'mean',
  queryPrefix: '',
  documentPrefix: '',
  maxTokens: 512,
};

const GRANITE_97M: ModelProfile = {
  key: 'granite-97m',
  repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
  revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
  dtype: 'q8',
  dims: 384,
  pooling: 'cls',
  queryPrefix: '',
  documentPrefix: '',
  maxTokens: 512,
};

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  [BGE_MICRO_V2.key]: BGE_MICRO_V2,
  [GRANITE_97M.key]: GRANITE_97M,
});

export const DEFAULT_MODEL_KEY = BGE_MICRO_V2.key;

export const MODEL_KEYS: readonly string[] = Object.freeze(Object.keys(MODEL_PROFILES));

export function resolveModelProfile(key: string): ModelProfile {
  if (!Object.hasOwn(MODEL_PROFILES, key)) {
    throw new Error(`unknown model "${key}" — choose one of: ${MODEL_KEYS.join(', ')}`);
  }
  return MODEL_PROFILES[key];
}

/** The identity the local provider reports for vectors produced under `profile`. */
export function identityOf(profile: ModelProfile): EmbeddingIdentity {
  return {
    provider: LOCAL_PROVIDER,
    model_key: profile.key,
    model_id: profile.repo,
    revision: profile.revision,
    dtype: profile.dtype,
    dims: profile.dims,
    pooling: profile.pooling,
    max_tokens: profile.maxTokens,
  };
}
```

- [ ] **Step 5: Run the test and the gates**

Run: `npx vitest run test/semantic/model-profiles.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/semantic/model-profiles.ts src/lib/obsidian/corpus/types.ts test/semantic/model-profiles.test.ts
git commit -m "feat(semantic): add the closed model profile registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.3: Mask-aware pooling

**Files:**
- Create: `src/modules/semantic/pooling.ts`
- Test: `test/semantic/pooling.test.ts`

**Interfaces:**
- Consumes: `Pooling` from `model-profiles.ts` (Task 1.2).
- Produces: `interface ModelOutput { kind: 'token_states' | 'pooled'; data: ArrayLike<number>; dims: number[] }`; `poolAndNormalize(output: ModelOutput, mask: number[][], method: Pooling): number[][]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/semantic/pooling.test.ts
import { describe, expect, it } from 'vitest';

import { poolAndNormalize, type ModelOutput } from '../../src/modules/semantic/pooling.js';

/** Token states where position j of row b holds [b*10 + j + 1, 1] — every position distinguishable. */
function states(batch: number, seq: number): ModelOutput {
  const data: number[] = [];
  for (let b = 0; b < batch; b++) for (let j = 0; j < seq; j++) data.push(b * 10 + j + 1, 1);
  return { kind: 'token_states', data, dims: [batch, seq, 2] };
}

/** Same arithmetic as the implementation's normalisation, so float results compare exactly. */
const unit = (v: number[]) => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
};

describe('poolAndNormalize', () => {
  it('cls takes the first real token under right padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[1, 1, 0]], 'cls');
    expect(row0).toEqual(unit([1, 1]));
  });

  it('cls takes the first real token under left padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[0, 1, 1]], 'cls');
    expect(row0).toEqual(unit([2, 1]));
  });

  it('last_token takes the last real token under right padding, never a pad', () => {
    const vectors = poolAndNormalize(states(2, 3), [[1, 1, 0], [1, 1, 1]], 'last_token');
    expect(vectors[0]).toEqual(unit([2, 1]));
    expect(vectors[1]).toEqual(unit([13, 1]));
  });

  it('last_token takes the final column under left padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[0, 1, 1]], 'last_token');
    expect(row0).toEqual(unit([3, 1]));
  });

  it('mean averages real positions only', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[1, 1, 0]], 'mean');
    expect(row0).toEqual(unit([1.5, 1]));
  });

  it('normalises an already-pooled output without re-pooling it', () => {
    const pooled: ModelOutput = { kind: 'pooled', data: [3, 4, 0, 5], dims: [2, 2] };
    expect(poolAndNormalize(pooled, [[1], [1, 1]], 'last_token')).toEqual([
      [0.6, 0.8],
      [0, 1],
    ]);
  });

  it('returns unit-length rows', () => {
    for (const v of poolAndNormalize(states(2, 4), [[1, 1, 1, 0], [1, 1, 1, 1]], 'mean')) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    }
  });

  it('rejects a non-finite value', () => {
    const bad: ModelOutput = { kind: 'pooled', data: [Number.NaN, 1], dims: [1, 2] };
    expect(() => poolAndNormalize(bad, [[1]], 'cls')).toThrow(/non-finite/);
  });

  it('rejects a row count that disagrees with the mask', () => {
    expect(() => poolAndNormalize(states(1, 2), [[1, 1], [1, 1]], 'cls')).toThrow(/1 rows for 2 inputs/);
  });

  it('rejects a row with no real tokens', () => {
    expect(() => poolAndNormalize(states(1, 2), [[0, 0]], 'cls')).toThrow(/no real tokens/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/pooling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/modules/semantic/pooling.ts
import type { Pooling } from './model-profiles.js';

/** A model's output for one batch, as plain data — no transformers.js types cross this seam. */
export interface ModelOutput {
  /** `token_states`: dims `[batch, seq, hidden]`. `pooled`: dims `[batch, hidden]`, pooled inside the graph. */
  kind: 'token_states' | 'pooled';
  data: ArrayLike<number>;
  dims: number[];
}

function copy(data: ArrayLike<number>, start: number, length: number): number[] {
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) out[i] = Number(data[start + i]);
  return out;
}

function normalize(values: number[]): number[] {
  let sumSquares = 0;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) throw new Error(`model output holds a non-finite value at dimension ${i}`);
    sumSquares += v * v;
  });
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) throw new Error('model output is a zero vector');
  return values.map((v) => v / norm);
}

/**
 * One unit-length vector per input row. Positions come from the attention
 * mask, never from token ids: a tokenizer may pad with the very id its
 * template appends (harrier-0.6b pads with `<|endoftext|>`), so only the mask
 * can tell the last real token from a pad.
 */
export function poolAndNormalize(output: ModelOutput, mask: number[][], method: Pooling): number[][] {
  const batch = output.dims[0] ?? 0;
  if (batch !== mask.length) {
    throw new Error(`model returned ${batch} rows for ${mask.length} inputs`);
  }

  if (output.kind === 'pooled') {
    const hidden = output.dims[1] ?? 0;
    return mask.map((_, b) => normalize(copy(output.data, b * hidden, hidden)));
  }

  const seq = output.dims[1] ?? 0;
  const hidden = output.dims[2] ?? 0;
  return mask.map((rowMask, b) => {
    const real: number[] = [];
    rowMask.forEach((m, j) => {
      if (m === 1) real.push(j);
    });
    if (real.length === 0) throw new Error(`input ${b} has no real tokens`);
    const at = (position: number): number[] => copy(output.data, (b * seq + position) * hidden, hidden);

    if (method === 'cls') return normalize(at(real[0]));
    if (method === 'last_token') return normalize(at(real[real.length - 1]));
    const sum = new Array<number>(hidden).fill(0);
    for (const position of real) {
      at(position).forEach((v, i) => {
        sum[i] += v;
      });
    }
    return normalize(sum.map((v) => v / real.length));
  });
}
```

- [ ] **Step 4: Run the test and the gates**

Run: `npx vitest run test/semantic/pooling.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/pooling.ts test/semantic/pooling.test.ts
git commit -m "feat(semantic): add mask-aware mean, CLS and last-token pooling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.4: The local model loader and the new dependency

**Files:**
- Modify: `package.json` (add `"@huggingface/transformers": "4.3.1"`; `engines.node` → `">=20.9.0"`), `package-lock.json`
- Create: `src/modules/semantic/local-model-loader.ts`
- Test: `test/semantic/local-model-loader.test.ts`

**Interfaces:**
- Consumes: `ModelProfile` (1.2), `ModelOutput` (1.3).
- Produces: `interface TokenizerHandle { encode(text, { add_special_tokens }): number[]; readonly padding_side: string; readonly pad_token_id?: number }`; `interface LocalModel { tokenizer: TokenizerHandle; run(ids: number[][], mask: number[][]): Promise<ModelOutput> }`; `type LocalModelLoader = (profile: ModelProfile) => Promise<LocalModel>`; `interface TransformersModule`; `defaultModelCacheDir(env?, home?): string`; `createLocalModelLoader(deps?: { importTransformers?; cacheDir? }): LocalModelLoader`.

- [ ] **Step 1: Add the dependency**

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install --save-exact @huggingface/transformers@4.3.1
```

(Use the variable name spike 1.1 confirmed.) Then set `"engines": { "node": ">=20.9.0" }` in `package.json` (`sharp`, a dependency of transformers.js 4.x, requires it). Leave `@xenova/transformers` in place — Task 1.5 removes it with its last importer.

- [ ] **Step 2: Write the failing test**

```ts
// test/semantic/local-model-loader.test.ts
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createLocalModelLoader,
  defaultModelCacheDir,
  type TransformersModule,
} from '../../src/modules/semantic/local-model-loader.js';
import { resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';

const granite = resolveModelProfile('granite-97m');

class FakeTensor {
  constructor(
    public type: string,
    public data: BigInt64Array,
    public dims: number[],
  ) {}
}

function fakeTransformers(
  opts: {
    inputNames?: string[];
    outputNames?: string[];
    outputs?: Record<string, { data: number[]; dims: number[] }>;
  } = {},
) {
  const forward: Array<Record<string, FakeTensor>> = [];
  const model = Object.assign(
    async (inputs: Record<string, FakeTensor>) => {
      forward.push(inputs);
      return opts.outputs ?? { last_hidden_state: { data: [1, 2], dims: [1, 1, 2] } };
    },
    {
      sessions: {
        model: {
          inputNames: opts.inputNames ?? ['input_ids', 'attention_mask'],
          outputNames: opts.outputNames ?? ['last_hidden_state'],
        },
      },
    },
  );
  const tokenizer = { encode: () => [1], padding_side: 'right', pad_token_id: 0 };
  const tf = {
    env: { cacheDir: null as string | null, logLevel: undefined as unknown },
    LogLevel: { ERROR: 'error-level' },
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModel: { from_pretrained: vi.fn(async () => model) },
    Tensor: FakeTensor,
  };
  return { tf, forward, module: tf as unknown as TransformersModule };
}

describe('defaultModelCacheDir', () => {
  it('uses an absolute XDG_CACHE_HOME', () => {
    expect(defaultModelCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(
      path.join('/xdg', 'neuro-vault', 'models'),
    );
  });

  it('ignores a relative XDG_CACHE_HOME, as the XDG spec requires', () => {
    expect(defaultModelCacheDir({ XDG_CACHE_HOME: 'rel/cache' }, '/home/u')).toBe(
      path.join('/home/u', '.cache', 'neuro-vault', 'models'),
    );
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    expect(defaultModelCacheDir({}, '/home/u')).toBe(path.join('/home/u', '.cache', 'neuro-vault', 'models'));
  });
});

describe('createLocalModelLoader', () => {
  it('sets the global cache dir and log level before loading', async () => {
    const { tf, module } = fakeTransformers();
    await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/models' })(granite);
    expect(tf.env.cacheDir).toBe('/models');
    expect(tf.env.logLevel).toBe('error-level');
  });

  it('loads tokenizer and model at the pinned revision, int8, on CPU', async () => {
    const { tf, module } = fakeTransformers();
    await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite);
    expect(tf.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(granite.repo, { revision: granite.revision });
    expect(tf.AutoModel.from_pretrained).toHaveBeenCalledWith(granite.repo, {
      revision: granite.revision,
      dtype: 'q8',
      device: 'cpu',
    });
  });

  it('fails naming the profile when the export lacks a required input', async () => {
    const { module } = fakeTransformers({ inputNames: ['input_ids'] });
    await expect(
      createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite),
    ).rejects.toThrow('model "granite-97m": export lacks the "attention_mask" input (has: input_ids)');
  });

  it('fails naming the profile when the export has no usable output', async () => {
    const { module } = fakeTransformers({ outputNames: ['logits'] });
    await expect(
      createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite),
    ).rejects.toThrow('model "granite-97m": export has no usable output (has: logits)');
  });

  it('runs a forward pass on int64 tensors and returns token states', async () => {
    const { forward, module } = fakeTransformers();
    const model = await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite);
    const output = await model.run([[5, 6]], [[1, 1]]);
    expect(output).toEqual({ kind: 'token_states', data: [1, 2], dims: [1, 1, 2] });
    expect(forward[0].input_ids.type).toBe('int64');
    expect([...forward[0].input_ids.data]).toEqual([5n, 6n]);
    expect(forward[0].attention_mask.dims).toEqual([1, 2]);
  });

  it('prefers token states over a pooled output when both exist', async () => {
    const { module } = fakeTransformers({
      outputNames: ['sentence_embedding', 'last_hidden_state'],
      outputs: {
        sentence_embedding: { data: [9, 9], dims: [1, 2] },
        last_hidden_state: { data: [1, 2], dims: [1, 1, 2] },
      },
    });
    const model = await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite);
    expect((await model.run([[1]], [[1]])).kind).toBe('token_states');
  });

  it('falls back to the pooled output when the export has no token states', async () => {
    const { module } = fakeTransformers({
      outputNames: ['sentence_embedding'],
      outputs: { sentence_embedding: { data: [3, 4], dims: [1, 2] } },
    });
    const model = await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite);
    expect(await model.run([[1]], [[1]])).toEqual({ kind: 'pooled', data: [3, 4], dims: [1, 2] });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/semantic/local-model-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/modules/semantic/local-model-loader.ts
import os from 'node:os';
import path from 'node:path';

import type { ModelProfile } from './model-profiles.js';
import type { ModelOutput } from './pooling.js';

/** The tokenizer surface the provider uses — a structural slice of transformers.js's. */
export interface TokenizerHandle {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  readonly padding_side: string;
  readonly pad_token_id?: number;
}

/** A loaded profile: its tokenizer, and a forward pass over already-padded id rows. */
export interface LocalModel {
  tokenizer: TokenizerHandle;
  run(ids: number[][], mask: number[][]): Promise<ModelOutput>;
}

export type LocalModelLoader = (profile: ModelProfile) => Promise<LocalModel>;

interface OutputTensor {
  data: ArrayLike<number>;
  dims: number[];
}

interface RawModel {
  (inputs: Record<string, unknown>): Promise<Record<string, OutputTensor | undefined>>;
  sessions: Record<string, { inputNames: string[]; outputNames: string[] }>;
}

/** The slice of `@huggingface/transformers` the loader touches — the seam tests replace. */
export interface TransformersModule {
  env: { cacheDir: string | null; logLevel: unknown };
  LogLevel: { ERROR: unknown };
  AutoTokenizer: {
    from_pretrained(repo: string, options: { revision: string }): Promise<TokenizerHandle>;
  };
  AutoModel: {
    from_pretrained(
      repo: string,
      options: { revision: string; dtype: string; device: string },
    ): Promise<RawModel>;
  };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
}

const TOKEN_STATE_OUTPUTS = ['last_hidden_state', 'token_embeddings'];
const POOLED_OUTPUT = 'sentence_embedding';
const REQUIRED_INPUTS = ['input_ids', 'attention_mask'];

/**
 * `$XDG_CACHE_HOME/neuro-vault/models`, else `~/.cache/neuro-vault/models`.
 * A relative `XDG_CACHE_HOME` is ignored, as the XDG spec requires — it would
 * resolve against whatever directory the MCP client launched us from.
 */
export function defaultModelCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
  return path.join(base, 'neuro-vault', 'models');
}

function pickOutput(profile: ModelProfile, outputNames: string[]): { name: string; kind: ModelOutput['kind'] } {
  const tokenStates = TOKEN_STATE_OUTPUTS.find((name) => outputNames.includes(name));
  if (tokenStates !== undefined) return { name: tokenStates, kind: 'token_states' };
  if (outputNames.includes(POOLED_OUTPUT)) return { name: POOLED_OUTPUT, kind: 'pooled' };
  throw new Error(`model "${profile.key}": export has no usable output (has: ${outputNames.join(', ')})`);
}

function int64(tf: TransformersModule, rows: number[][]): unknown {
  const width = rows[0]?.length ?? 0;
  const data = new BigInt64Array(rows.length * width);
  rows.forEach((row, b) => {
    row.forEach((value, j) => {
      data[b * width + j] = BigInt(value);
    });
  });
  return new tf.Tensor('int64', data, [rows.length, width]);
}

async function importTransformersModule(): Promise<TransformersModule> {
  // Imported lazily: a process with semantics off never loads onnxruntime.
  return (await import('@huggingface/transformers')) as unknown as TransformersModule;
}

export function createLocalModelLoader(
  deps: { importTransformers?: () => Promise<TransformersModule>; cacheDir?: string } = {},
): LocalModelLoader {
  const importTransformers = deps.importTransformers ?? importTransformersModule;
  let configured = false;

  return async (profile) => {
    const tf = await importTransformers();
    if (!configured) {
      // Global on purpose (design D15): transformers.js's tokenizer file probe
      // reads only `env`, ignoring per-call cache options. The log level keeps
      // library chatter off stdout, which the MCP transport owns.
      tf.env.cacheDir = deps.cacheDir ?? defaultModelCacheDir();
      tf.env.logLevel = tf.LogLevel.ERROR;
      configured = true;
    }

    const tokenizer = await tf.AutoTokenizer.from_pretrained(profile.repo, { revision: profile.revision });
    const model = await tf.AutoModel.from_pretrained(profile.repo, {
      revision: profile.revision,
      dtype: profile.dtype,
      device: 'cpu',
    });

    // Fail at load, naming the profile, rather than embed garbage later.
    const session = Object.values(model.sessions)[0];
    if (session === undefined) throw new Error(`model "${profile.key}": no inference session was loaded`);
    for (const input of REQUIRED_INPUTS) {
      if (!session.inputNames.includes(input)) {
        throw new Error(
          `model "${profile.key}": export lacks the "${input}" input (has: ${session.inputNames.join(', ')})`,
        );
      }
    }
    const output = pickOutput(profile, session.outputNames);

    return {
      tokenizer,
      run: async (ids, mask) => {
        const result = await model({ input_ids: int64(tf, ids), attention_mask: int64(tf, mask) });
        const tensor = result[output.name];
        if (tensor === undefined) {
          throw new Error(`model "${profile.key}": forward pass returned no "${output.name}"`);
        }
        return { kind: output.kind, data: tensor.data, dims: tensor.dims };
      },
    };
  };
}
```

- [ ] **Step 5: Run the test and the gates**

Run: `npx vitest run test/semantic/local-model-loader.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/semantic/local-model-loader.ts test/semantic/local-model-loader.test.ts
git commit -m "feat(semantic): load profiles through @huggingface/transformers 4.3.1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.5: `EmbeddingService` on the loader; drop `@xenova/transformers`

**Files:**
- Modify: `src/modules/semantic/embedding-service.ts` (rewrite), `src/server.ts:123`, `src/cli-index.ts:29-32`, `src/modules/semantic/index.ts:28-31`, `eval/run.ts:66-71`, `package.json`, `package-lock.json`
- Test: `test/semantic/embedding-service.test.ts` (rewrite)

**Interfaces:**
- Consumes: `ModelProfile`, `identityOf`, `resolveModelProfile`, `DEFAULT_MODEL_KEY` (1.2); `poolAndNormalize` (1.3); `LocalModel`, `LocalModelLoader`, `createLocalModelLoader` (1.4).
- Produces: `interface EmbeddingServiceOptions { profile: ModelProfile; loader?: LocalModelLoader }`; `class EmbeddingService implements EmbeddingProvider { readonly identity: EmbeddingIdentity; initialize(); embed(text) }`.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// test/semantic/embedding-service.test.ts
import { describe, expect, it, vi } from 'vitest';

import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';
import type { LocalModel } from '../../src/modules/semantic/local-model-loader.js';
import { identityOf, resolveModelProfile, type ModelProfile } from '../../src/modules/semantic/model-profiles.js';

const bge = resolveModelProfile('bge-micro-v2');
const granite = resolveModelProfile('granite-97m');

/** A model whose token state at each position is [id, 1]; the tokenizer wraps chars in [101 … 102]. */
function fakeModel(encodeImpl?: (text: string) => number[]) {
  const runs: Array<{ ids: number[][]; mask: number[][] }> = [];
  const encode = vi.fn((text: string, options: { add_special_tokens: boolean }) => {
    const body = encodeImpl ? encodeImpl(text) : Array.from(text, (c) => c.charCodeAt(0));
    return options.add_special_tokens ? [101, ...body, 102] : body;
  });
  const model: LocalModel = {
    tokenizer: { encode, padding_side: 'right', pad_token_id: 0 },
    run: async (ids, mask) => {
      runs.push({ ids, mask });
      const data: number[] = [];
      for (const row of ids) for (const id of row) data.push(id, 1);
      return { kind: 'token_states', data, dims: [ids.length, ids[0].length, 2] };
    },
  };
  return { model, runs, encode };
}

/** Same arithmetic as the implementation's normalisation, so float results compare exactly. */
const unit = (v: number[]) => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
};

function serviceFor(profile: ModelProfile, model: LocalModel) {
  const loader = vi.fn(async () => model);
  return { service: new EmbeddingService({ profile, loader }), loader };
}

describe('EmbeddingService', () => {
  it('reports the identity of its profile', () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(service.identity).toEqual(identityOf(granite));
  });

  it('loads the model once, shared by concurrent embeds', async () => {
    const { service, loader } = serviceFor(granite, fakeModel().model);
    await Promise.all([service.embed('a'), service.embed('b'), service.initialize()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(granite);
  });

  it('rejects blank text before loading the model', async () => {
    const { service, loader } = serviceFor(granite, fakeModel().model);
    await expect(service.embed('   ')).rejects.toThrow(/blank/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it('pools the first token for a CLS profile', async () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(await service.embed('ab')).toEqual(unit([101, 1]));
  });

  it('pools the mean for a mean profile', async () => {
    const { service } = serviceFor(bge, fakeModel(() => [3]).model);
    expect(await service.embed('x')).toEqual(unit([(101 + 3 + 102) / 3, 1]));
  });

  it('cuts an over-long input to the profile window and still returns a vector', async () => {
    const { model, runs } = fakeModel(() => Array.from({ length: 600 }, (_, i) => i + 1000));
    const { service } = serviceFor(bge, model);
    const vector = await service.embed('long');
    expect(runs[0].ids[0]).toHaveLength(bge.maxTokens);
    expect(vector).toHaveLength(2);
  });

  it('retries a failed load on the next call', async () => {
    const { model } = fakeModel();
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(model);
    const service = new EmbeddingService({ profile: granite, loader });
    await expect(service.embed('a')).rejects.toThrow('offline');
    await expect(service.embed('a')).resolves.toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/embedding-service.test.ts`
Expected: FAIL — `EmbeddingService` has no `identity` / does not accept `profile`.

- [ ] **Step 3: Rewrite the service**

```ts
// src/modules/semantic/embedding-service.ts
import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

import { createLocalModelLoader, type LocalModel, type LocalModelLoader } from './local-model-loader.js';
import { identityOf, type ModelProfile } from './model-profiles.js';
import { poolAndNormalize } from './pooling.js';
import type { EmbeddingProvider } from './types.js';

export interface EmbeddingServiceOptions {
  profile: ModelProfile;
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

/** The local, in-process embedding provider for one model profile. */
export class EmbeddingService implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;

  private readonly profile: ModelProfile;

  private readonly loader: LocalModelLoader;

  private model?: LocalModel;

  private initialization: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions) {
    this.profile = options.profile;
    this.loader = options.loader ?? createLocalModelLoader();
    this.identity = identityOf(options.profile);
  }

  async initialize(): Promise<void> {
    await this.getModel();
  }

  async embed(text: string): Promise<number[]> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error('Embedding text must not be blank');
    }

    const model = await this.getModel();
    // The encoding v2's pipeline used: special tokens first, then the cut to
    // the window. It drops the trailing special token of an over-long input,
    // which mean and CLS pooling tolerate — and it keeps vectors comparable
    // with corpora that v2 built (design D5, "Staging").
    const ids = model.tokenizer
      .encode(normalizedText, { add_special_tokens: true })
      .slice(0, this.profile.maxTokens);
    const mask = [ids.map(() => 1)];
    const [vector] = poolAndNormalize(await model.run([ids], mask), mask, this.profile.pooling);
    if (vector === undefined) throw new Error('Embedding model returned no vector');
    return vector;
  }

  private async getModel(): Promise<LocalModel> {
    if (this.model) return this.model;

    if (!this.initialization) {
      this.initialization = this.loader(this.profile)
        .then((model) => {
          this.model = model;
        })
        .catch((error: unknown) => {
          // A failed load must not be cached: the next call retries.
          this.initialization = null;
          throw error;
        });
    }

    await this.initialization;
    if (!this.model) throw new Error('Embedding model failed to initialize');
    return this.model;
  }
}
```

- [ ] **Step 4: Update the four call sites**

`src/server.ts` (line 123):

```ts
import { resolveModelProfile } from './modules/semantic/model-profiles.js';
// ...
const embedder = createQueuedEmbedder(
  new EmbeddingService({ profile: resolveModelProfile(config.semantic.modelKey) }),
);
```

`src/cli-index.ts` (`defaultEmbed`):

```ts
import { DEFAULT_MODEL_KEY, resolveModelProfile } from './modules/semantic/model-profiles.js';
// ...
function defaultEmbed(): EmbedFn {
  const service = new EmbeddingService({ profile: resolveModelProfile(DEFAULT_MODEL_KEY) });
  return (text) => service.embed(text);
}
```

`src/modules/semantic/index.ts` (default factory; the `modelId` parameter is now ignored and goes away in Task 2.4):

```ts
import { resolveModelProfile } from './model-profiles.js';
// ...
const embeddingServiceFactory =
  deps.embeddingServiceFactory ??
  (() => new EmbeddingService({ profile: resolveModelProfile(config.modelKey) }));
```

`eval/run.ts` (default embed inside `runEval`; `model_id` default too):

```ts
import { DEFAULT_MODEL_KEY, resolveModelProfile } from '../src/modules/semantic/model-profiles.js';
// ...
  const profile = resolveModelProfile(DEFAULT_MODEL_KEY);
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService({ profile });
      return (text: string) => service.embed(text);
    })();
// ...
    model_id: deps.modelId ?? profile.repo,
```

and drop the now-unused `MODEL_ID` import from `eval/run.ts`.

- [ ] **Step 5: Remove the old package**

```bash
npm uninstall @xenova/transformers
grep -rn "xenova" src test eval package.json && echo "STILL REFERENCED" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 6: Run the suite and the gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. If `test/lib/obsidian/corpus/types.test.ts` or others still import `MAX_TOKENS`/`MODEL_ID` only for the deleted cap test, leave them — those constants leave in Task 2.1.

- [ ] **Step 7: Commit**

```bash
git add -A src/modules/semantic/embedding-service.ts src/server.ts src/cli-index.ts src/modules/semantic/index.ts eval/run.ts package.json package-lock.json test/semantic/embedding-service.test.ts
git commit -m "feat(semantic): embed through tokenizer + model directly on transformers.js 4

Replaces the feature-extraction pipeline with an explicit tokenizer and
AutoModel call and mask-aware pooling, keeping v2's truncation semantics so
existing bge-micro-v2 corpora stay valid. Removes @xenova/transformers.

Refs #98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.1: The corpus receives its identity as data

**Files:**
- Create: `src/lib/obsidian/corpus/identity.ts`, `test/_identity.ts`, `test/lib/obsidian/corpus/identity.test.ts`
- Modify: `src/lib/obsidian/corpus/types.ts` (remove `MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS`, `MAX_TOKENS`; make `EMBED_CHAR_BUDGET` a literal), `src/lib/obsidian/corpus/reconcile.ts`, `src/lib/obsidian/corpus/shard-store.ts`, `src/modules/semantic/backend/corpus-backend.ts`, `src/modules/semantic/backend/index.ts`, `src/server.ts`, `src/cli-index.ts`, `eval/backends.ts`, `eval/run.ts`, and every test the typecheck flags (`test/semantic/backend/corpus-backend.test.ts`, `test/lib/obsidian/corpus/{reconcile,shard-store,vector-codec,types,embed-text}.test.ts`, `test/eval/{run,backends}.test.ts`, `test/cli-index.test.ts`)

**Interfaces:**
- Consumes: `EmbeddingIdentity` (1.2), `EmbeddingService.identity` (1.5).
- Produces: `type CorpusIdentity = Omit<CorpusManifest, 'created'>`; `corpusIdentityOf(embedding: EmbeddingIdentity): CorpusIdentity`; `ReconcileDeps.identity: CorpusIdentity`; `CorpusStoreDeps.dims: number` (required); `CorpusBackendDeps.identity: CorpusIdentity`; `OwnCorpusBackendFactoryDeps.identity: CorpusIdentity`; `IndexCommandDeps.createEmbedder?: () => IndexEmbedder` with `interface IndexEmbedder { identity: EmbeddingIdentity; embed: EmbedFn }`; `eval/backends.ts` `loadSnapshot(vaultRoot: string, dims: number)`. Test helper `test/_identity.ts`: `TEST_DIMS`, `TEST_EMBEDDING_IDENTITY`, `TEST_IDENTITY`.

- [ ] **Step 1: Write the failing identity test**

```ts
// test/lib/obsidian/corpus/identity.test.ts
import { describe, expect, it } from 'vitest';

import { corpusIdentityOf } from '../../../../src/lib/obsidian/corpus/identity.js';

describe('corpusIdentityOf', () => {
  it('records the producing model under this build’s extraction version and strategy', () => {
    expect(
      corpusIdentityOf({
        provider: 'transformers.js',
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
        dtype: 'q8',
        dims: 384,
        pooling: 'mean',
        max_tokens: 512,
      }),
    ).toEqual({
      embed_version: 1,
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      dims: 384,
      strategy: 'sc-parity-v1',
    });
  });
});
```

Run: `npx vitest run test/lib/obsidian/corpus/identity.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement the identity module**

```ts
// src/lib/obsidian/corpus/identity.ts
import { EMBED_VERSION, SC_PARITY_STRATEGY, type CorpusManifest, type EmbeddingIdentity } from './types.js';

/** What a manifest records and a stored corpus is checked against. */
export type CorpusIdentity = Omit<CorpusManifest, 'created'>;

/**
 * The corpus identity of vectors produced by `embedding` under this build's
 * text extraction. Until the manifest records the full producer (design D8),
 * it keeps exactly the five fields existing manifests carry, so no corpus is
 * invalidated by this refactor.
 */
export function corpusIdentityOf(embedding: EmbeddingIdentity): CorpusIdentity {
  return {
    embed_version: EMBED_VERSION,
    model_key: embedding.model_key,
    model_id: embedding.model_id,
    dims: embedding.dims,
    strategy: SC_PARITY_STRATEGY,
  };
}
```

Run the test — Expected: PASS.

- [ ] **Step 3: Add the shared test identity**

```ts
// test/_identity.ts
import { corpusIdentityOf, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import type { EmbeddingIdentity } from '../src/lib/obsidian/corpus/types.js';

/** Vector width every corpus test writes and reads. */
export const TEST_DIMS = 384;

export const TEST_EMBEDDING_IDENTITY: EmbeddingIdentity = {
  provider: 'test',
  model_key: 'bge-micro-v2',
  model_id: 'TaylorAI/bge-micro-v2',
  revision: 'test-revision',
  dtype: 'q8',
  dims: TEST_DIMS,
  pooling: 'mean',
  max_tokens: 512,
};

export const TEST_IDENTITY: CorpusIdentity = corpusIdentityOf(TEST_EMBEDDING_IDENTITY);
```

- [ ] **Step 4: Remove the model constants and require the identity**

In `src/lib/obsidian/corpus/types.ts`: delete `MAX_TOKENS`, `MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS` and their comments; replace the `EMBED_CHAR_BUDGET` line with

```ts
/** Note embed text is cut here — the Smart Connections parity formula, 512 tokens × 3.7. */
export const EMBED_CHAR_BUDGET = 1894;
```

In `src/lib/obsidian/corpus/shard-store.ts`: make `dims` required — change `dims?: number;` to `dims: number;` in `CorpusStoreDeps`, the constructor signature to `constructor(vaultRoot: string, deps: CorpusStoreDeps)`, `this.dims = deps.dims;`, and drop the `MODEL_DIMS` import. `ensureManifest(expected: CorpusIdentity)` (import the type from `./identity.js`).

In `src/lib/obsidian/corpus/reconcile.ts`: add to `ReconcileDeps`

```ts
  /** The identity the corpus must carry — the provider's, under this build's extraction. */
  identity: CorpusIdentity;
```

and replace the literal `ensureManifest({...})` block with `await store.ensureManifest(deps.identity);`, dropping the constant imports it used.

In `src/modules/semantic/backend/corpus-backend.ts`: delete `EXPECTED_IDENTITY` and its imports; add to `CorpusBackendDeps`

```ts
  /** The identity a stored manifest must match to be served. */
  identity: CorpusIdentity;
```

and use `deps.identity` in `selectStartupSnapshot`.

In `src/modules/semantic/backend/index.ts`: add `identity: CorpusIdentity;` to `OwnCorpusBackendFactoryDeps`, build the store with `new CorpusStore(vaultRoot, { warn, dims: deps.identity.dims })`, pass `identity: deps.identity` into `reconcileCorpus({ ...fsDeps, embed, store, warn, identity: deps.identity }, opts)` and into `createBackend({ ..., identity: deps.identity })`.

In `src/server.ts`:

```ts
import { corpusIdentityOf } from './lib/obsidian/corpus/identity.js';
// ...
  const service = new EmbeddingService({ profile: resolveModelProfile(config.semantic.modelKey) });
  const embedder = createQueuedEmbedder(service);
  const identity = corpusIdentityOf(service.identity);
// ...
    buildDefaultVaultEntryDeps(embedder, identity, deps.vaultEntryDeps),
```

with `buildDefaultVaultEntryDeps(embedder: QueuedEmbedder, identity: CorpusIdentity, overrides = {})` passing `createOwnCorpusBackendFactory({ embedder, identity })`.

In `src/cli-index.ts`:

```ts
import { corpusIdentityOf } from './lib/obsidian/corpus/identity.js';
import type { EmbedFn, EmbeddingIdentity } from './lib/obsidian/corpus/types.js';

/** One embedder for the whole run: what it is, and how to call it. */
export interface IndexEmbedder {
  identity: EmbeddingIdentity;
  embed: EmbedFn;
}

export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embedder shared by every vault in the run. */
  createEmbedder?: () => IndexEmbedder;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbedder(): IndexEmbedder {
  const service = new EmbeddingService({ profile: resolveModelProfile(DEFAULT_MODEL_KEY) });
  return { identity: service.identity, embed: (text) => service.embed(text) };
}
```

and in `reconcileOne(vault, embedder, reconcile, stdout)`: `const identity = corpusIdentityOf(embedder.identity); const store = new CorpusStore(vault.path, { dims: identity.dims });` and pass `embed: embedder.embed, store, identity` to `reconcile`. In `runIndexCommand`: `const embedder = (deps.createEmbedder ?? defaultEmbedder)();`.

In `eval/backends.ts`: `export async function loadSnapshot(vaultRoot: string, dims: number)` building `new CorpusStore(vaultRoot, { dims })`. In `eval/run.ts`: `const sources = await loadSnapshot(vaultRoot, profile.dims);` (move `const profile = …` above it).

- [ ] **Step 5: Fix every test the typecheck reports**

Run: `npm run typecheck`. For each error:
- `MODEL_DIMS` import from `corpus/types.js` → `import { TEST_DIMS } from '<relative>/_identity.js'` and rename uses to `TEST_DIMS`.
- `new CorpusStore(root)` → `new CorpusStore(root, { dims: TEST_DIMS })`; with existing deps, add `dims: TEST_DIMS` to the object.
- `createCorpusBackend({...})` → add `identity: TEST_IDENTITY`.
- `reconcileCorpus({...})` deps (the `harness()` in `reconcile.test.ts`) → add `identity: TEST_IDENTITY`.
- `loadSnapshot(vaultRoot)` → `loadSnapshot(vaultRoot, TEST_DIMS)`.
- `test/cli-index.test.ts` `makeDeps`: replace `createEmbed: () => async () => [0.1, 0.2]` with `createEmbedder: () => ({ identity: TEST_EMBEDDING_IDENTITY, embed: async () => [0.1, 0.2] })`.
- `test/lib/obsidian/corpus/types.test.ts`: drop the `MAX_TOKENS` assertion; keep `EMBED_CHAR_BUDGET === 1894`.

Re-run `npm run typecheck` until clean.

- [ ] **Step 6: Add the dimension guard test**

Append to `test/lib/obsidian/corpus/shard-store.test.ts`:

```ts
  it('a store built for 640 dims refuses a 384-dim vector', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-store-dims-'));
    const store = new CorpusStore(root, { dims: 640 });
    await expect(
      store.writeShard({
        path: 'A.md',
        content_hash: 'h',
        mtime: 1,
        size: 1,
        embedding: Buffer.alloc(384 * 4).toString('base64'),
        blocks: [],
      }),
    ).rejects.toThrow(/expected 640 dims/);
  });
```

(add `mkdtemp`/`tmpdir`/`path` imports if the file lacks them).

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "MODEL_KEY\|MODEL_ID\|MODEL_DIMS\|MAX_TOKENS" src eval | grep -v "DEFAULT_MODEL_KEY\|MODEL_KEYS"`
Expected: PASS, clean, and the grep prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src eval test
git commit -m "refactor(corpus): take the corpus identity from the embedding provider

The manifest identity, the shard dimension check and the backend's
compatibility check now all come from the active provider's identity
instead of model constants in the corpus library.

Refs #98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.2: Reconcile reports the identity it replaces

**Files:**
- Modify: `src/lib/obsidian/corpus/identity.ts`, `src/lib/obsidian/corpus/shard-store.ts` (`ensureManifest`), `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/identity.test.ts`, `test/lib/obsidian/corpus/reconcile.test.ts`, `test/lib/obsidian/corpus/shard-store.test.ts`

**Interfaces:**
- Produces: `formatIdentity(identity: Pick<CorpusManifest, 'model_key' | 'embed_version'> | null): string`; `CorpusStore.ensureManifest(expected): Promise<{ rebuilt: boolean; previous: CorpusManifest | null }>`; `ReconcileOptions.onRebuild?: (rebuild: { stored: CorpusManifest | null; active: CorpusIdentity }) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/obsidian/corpus/identity.test.ts`:

```ts
import { formatIdentity } from '../../../../src/lib/obsidian/corpus/identity.js';

describe('formatIdentity', () => {
  it('names the model and the embedding version', () => {
    expect(formatIdentity({ model_key: 'bge-micro-v2', embed_version: 1 })).toBe('bge-micro-v2 (embed_version 1)');
  });

  it('describes a corpus whose manifest could not be read', () => {
    expect(formatIdentity(null)).toBe('an unreadable or missing manifest');
  });
});
```

Append to `test/lib/obsidian/corpus/reconcile.test.ts` (inside `describe('reconcileCorpus')`):

```ts
  it('reports the stored identity it replaces, once, before any note', async () => {
    const { run, store } = await harness({ 'A.md': body('A') });
    await run();
    await store.writeManifest({ ...TEST_IDENTITY, model_key: 'other', created: '2026-01-01T00:00:00.000Z' });
    const events: string[] = [];
    await run({
      onRebuild: ({ stored, active }) => events.push(`${stored?.model_key} -> ${active.model_key}`),
      onProgress: () => events.push('progress'),
    });
    expect(events[0]).toBe('other -> bge-micro-v2');
    expect(events.filter((e) => e.includes('->'))).toHaveLength(1);
  });

  it('does not report a rebuild for a matching or a fresh corpus', async () => {
    const { run } = await harness({ 'A.md': body('A') });
    const onRebuild = vi.fn();
    await run({ onRebuild });
    await run({ onRebuild });
    expect(onRebuild).not.toHaveBeenCalled();
  });

  it('a throwing onRebuild is contained', async () => {
    const { run, store, warn } = await harness({ 'A.md': body('A') });
    await run();
    await store.writeManifest({ ...TEST_IDENTITY, model_key: 'other', created: 'x' });
    const summary = await run({
      onRebuild: () => {
        throw new Error('boom');
      },
    });
    expect(summary.embedded).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onRebuild callback threw'));
  });
```

(import `TEST_IDENTITY` from `../../../_identity.js`.) Run: `npx vitest run test/lib/obsidian/corpus` — Expected: FAIL.

- [ ] **Step 2: Implement**

`identity.ts` — append:

```ts
/** `<model_key> (embed_version <n>)` — how a rebuild names a corpus identity. */
export function formatIdentity(
  identity: Pick<CorpusManifest, 'model_key' | 'embed_version'> | null,
): string {
  if (identity === null) return 'an unreadable or missing manifest';
  return `${identity.model_key} (embed_version ${identity.embed_version})`;
}
```

`shard-store.ts` — `ensureManifest` returns the manifest it found:

```ts
  async ensureManifest(
    expected: CorpusIdentity,
  ): Promise<{ rebuilt: boolean; previous: CorpusManifest | null }> {
    const stored = await this.readManifest();
    const hasShards = await this.hasAnyShards();
    const compatible = isManifestCompatible(stored, expected, hasShards);
    if (compatible && stored !== null) return { rebuilt: false, previous: stored };
    if (!compatible && hasShards) await this.clearShards();
    await this.writeManifest({ ...expected, created: new Date().toISOString() });
    return { rebuilt: !compatible, previous: stored };
  }
```

`reconcile.ts` — add to `ReconcileOptions`:

```ts
  /**
   * Called once, before any note is processed, when the stored corpus was
   * built with another identity and has just been discarded (design D8).
   */
  onRebuild?: (rebuild: { stored: CorpusManifest | null; active: CorpusIdentity }) => void;
```

and replace `await store.ensureManifest(deps.identity);` with

```ts
  const { rebuilt, previous } = await store.ensureManifest(deps.identity);
  if (rebuilt) {
    // Guarded like onProgress: a throwing callback must not abort the run.
    try {
      opts.onRebuild?.({ stored: previous, active: deps.identity });
    } catch (err) {
      warn(`neuro-vault corpus: onRebuild callback threw: ${String(err)}`);
    }
  }
```

- [ ] **Step 3: Run the tests and the gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS (existing `ensureManifest` tests that compared the return value to `{ rebuilt }` need `toMatchObject({ rebuilt: … })`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/obsidian/corpus test/lib/obsidian/corpus
git commit -m "feat(corpus): report the identity a rebuild replaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.3: The server announces a corpus it is about to rebuild

**Files:**
- Modify: `src/modules/semantic/backend/corpus-backend.ts` (`selectStartupSnapshot`)
- Test: `test/semantic/backend/corpus-backend.test.ts`

**Interfaces:**
- Consumes: `formatIdentity` (2.2), `CorpusBackendDeps.identity` (2.1).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('createCorpusBackend')` (the file's `fakeStore({ compatible: false })` returns a manifest with `model_key: 'other'`, `embed_version: 99`):

```ts
  it('announces an incompatible corpus on stderr, naming both identities', async () => {
    const warn = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'Notes',
      enabled: true,
      identity: TEST_IDENTITY,
      store: fakeStore({ compatible: false, shards: 2 }),
      loadSnapshot: async () => EMPTY,
      reconcile: async () => summary({ embedded: 1, reused: 0 }),
      warn,
    });
    await backend.whenSettled();
    expect(warn).toHaveBeenCalledWith(
      'neuro-vault corpus: vault "Notes" was indexed with other (embed_version 99); active model is bge-micro-v2 (embed_version 1) — discarding the corpus and re-indexing in the background',
    );
  });

  it('does not announce a compatible corpus or an empty one', async () => {
    for (const store of [fakeStore({ compatible: true, shards: 2 }), fakeStore({ compatible: false, shards: 0 })]) {
      const warn = vi.fn();
      const backend = createCorpusBackend({
        vaultRoot: '/v',
        vaultName: 'Notes',
        enabled: true,
        identity: TEST_IDENTITY,
        store,
        loadSnapshot: async () => snapshotWith(['a.md']),
        reconcile: async () => summary(),
        warn,
      });
      await backend.whenSettled();
      expect(warn.mock.calls.flat().join('\n')).not.toContain('was indexed with');
    }
  });
```

Run: `npx vitest run test/semantic/backend/corpus-backend.test.ts` — Expected: FAIL (no announcement).

- [ ] **Step 2: Implement**

In `selectStartupSnapshot`:

```ts
    const hasShards = shards.size > 0;
    if (!hasShards) return null;
    if (!isManifestCompatible(manifest, deps.identity, hasShards)) {
      // Never silent (design D8): say what is being thrown away and why. The
      // background pass that follows discards and rebuilds it.
      warn(
        `neuro-vault corpus: vault "${deps.vaultName}" was indexed with ${formatIdentity(manifest)}; ` +
          `active model is ${formatIdentity(deps.identity)} — discarding the corpus and re-indexing in the background`,
      );
      return null;
    }
```

- [ ] **Step 3: Run the tests and the gates**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/backend/corpus-backend.ts test/semantic/backend/corpus-backend.test.ts
git commit -m "feat(semantic): announce a corpus rebuild at server startup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.4: `--model` on the server and on `index`

**Files:**
- Modify: `src/config.ts`, `src/types.ts`, `src/server.ts`, `src/cli-index.ts`, `src/modules/semantic/index.ts`, and the tests the typecheck flags (`test/config.test.ts`, `test/cli-index.test.ts`, `test/server-modules.test.ts`, `test/server-instructions.test.ts`, any `createSemanticModule` caller)
- Test: `test/config.test.ts`, `test/cli-index.test.ts`

**Interfaces:**
- Consumes: `MODEL_KEYS`, `DEFAULT_MODEL_KEY`, `resolveModelProfile`, `ModelProfile` (1.2); `formatIdentity` (2.2).
- Produces: `ServerConfig.semantic = { enabled: boolean; model: ModelProfile }`; `IndexCliOptions = { vaults; model: ModelProfile }`; `ISemanticModuleConfig = { profile: ModelProfile }`; `ISemanticModuleDeps.embeddingServiceFactory?: (profile: ModelProfile) => EmbeddingProvider`; `IndexCommandDeps.createEmbedder?: (profile: ModelProfile) => IndexEmbedder`.

- [ ] **Step 1: Write the failing config tests**

Append to `test/config.test.ts` inside `describe('parseConfig')`:

```ts
  describe('--model', () => {
    it('defaults to the registry default', async () => {
      const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.model.key).toBe(DEFAULT_MODEL_KEY);
    });

    it('selects a profile by key', async () => {
      const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'granite-97m']);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.model).toBe(resolveModelProfile('granite-97m'));
    });

    it('rejects an unknown key, listing the allowed keys', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'all-MiniLM-L6-v2']),
        ).rejects.toThrow(new RegExp(MODEL_KEYS.map((k) => `"${k}"`).join('.*'), 's'));
      } finally {
        errorLog.mockRestore();
      }
    });

    it('rejects --model given twice', async () => {
      await expect(
        parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'granite-97m', '--model', 'bge-micro-v2']),
      ).rejects.toThrow('--model may be given only once');
    });

    it('accepts --model alongside --no-semantic', async () => {
      const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-semantic', '--model', 'granite-97m']);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.enabled).toBe(false);
    });

    it('documents the choices and the default in --help', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await parseConfig(['node', 'cli.js', '--help']);
        const help = String(log.mock.calls[0][0]);
        expect(help).toContain('--model');
        for (const key of MODEL_KEYS) expect(help).toContain(key);
        expect(help).toContain(`default: "${DEFAULT_MODEL_KEY}"`);
      } finally {
        log.mockRestore();
      }
    });

    it('index accepts the same keys and default', async () => {
      const parsed = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath, '--model', 'granite-97m']);
      if (parsed.kind !== 'index') throw new Error('expected index');
      expect(parsed.options.model.key).toBe('granite-97m');
      const plain = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath]);
      if (plain.kind !== 'index') throw new Error('expected index');
      expect(plain.options.model.key).toBe(DEFAULT_MODEL_KEY);
    });

    it('index rejects an unknown key the same way', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath, '--model', 'bge-m3']),
        ).rejects.toThrow(/Choices/);
      } finally {
        errorLog.mockRestore();
      }
    });
  });
```

(import `DEFAULT_MODEL_KEY, MODEL_KEYS, resolveModelProfile` from `../src/modules/semantic/model-profiles.js`.) Run: `npx vitest run test/config.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write the failing index tests**

Append to `test/cli-index.test.ts` (update `makeDeps` to `createEmbedder: () => ({ identity: TEST_EMBEDDING_IDENTITY, embed: async () => [0.1, 0.2] })` and every `runIndexCommand({ vaults })` call to `runIndexCommand({ vaults, model: profile })` with `const profile = resolveModelProfile(DEFAULT_MODEL_KEY);`):

```ts
  it('builds its one embedder from the selected profile', async () => {
    const createEmbedder = vi.fn(() => ({ identity: TEST_EMBEDDING_IDENTITY, embed: async () => [0.1] }));
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), createEmbedder };
    const granite = resolveModelProfile('granite-97m');
    await runIndexCommand({ vaults: [vaultA, vaultB], model: granite }, deps);
    expect(createEmbedder).toHaveBeenCalledTimes(1);
    expect(createEmbedder).toHaveBeenCalledWith(granite);
  });

  it('announces a rebuild before the vault’s progress', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onRebuild?.({
        stored: { ...TEST_IDENTITY, model_key: 'harrier-270m', embed_version: 2, created: 'x' },
        active: TEST_IDENTITY,
      });
      opts?.onProgress?.({ indexed: 1, total: 1 });
      return okSummary({ total: 1, embedded: 1 });
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    expect(deps.stdout.chunks[0]).toBe(
      'rebuilding VaultA: corpus was indexed with harrier-270m (embed_version 2); active model is bge-micro-v2 (embed_version 1)\n',
    );
  });

  it('prints no rebuild line when the corpus matches', async () => {
    const deps = makeDeps(vi.fn(async () => okSummary()));
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    expect(deps.stdout.chunks.join('')).not.toContain('rebuilding');
  });
```

Run: `npx vitest run test/cli-index.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the option**

`src/types.ts`:

```ts
import type { ModelProfile } from './modules/semantic/model-profiles.js';
// ...
export interface ServerConfig {
  vaults: IVaultConfig[]; // length >= 1, names unique
  semantic: {
    enabled: boolean;
    /** The one embedding profile this process serves (design D3). */
    model: ModelProfile;
  };
}
```

`src/config.ts` — replace the `MODEL_ID`/`MODEL_KEY` import and `DEFAULT_MODEL_ID`:

```ts
import {
  DEFAULT_MODEL_KEY,
  MODEL_KEYS,
  resolveModelProfile,
  type ModelProfile,
} from './modules/semantic/model-profiles.js';

export interface IndexCliOptions {
  vaults: IVaultConfig[];
  model: ModelProfile;
}

const MODEL_OPTION = {
  type: 'string',
  choices: MODEL_KEYS,
  default: DEFAULT_MODEL_KEY,
  describe:
    'Embedding model profile, one per process. A vault indexed with another model is rebuilt, so give the server and `index` the same value.',
} as const;

function readModel(raw: unknown): ModelProfile {
  // yargs turns a repeated flag into an array; picking one silently would hide a mistake.
  if (Array.isArray(raw)) throw new Error('--model may be given only once');
  return resolveModelProfile(String(raw));
}
```

attach `.option('model', MODEL_OPTION)` to both the `$0` builder (after `semantic`) and the `index` builder (after `vault`), and build the results:

```ts
  const model = readModel(args.model);

  if (args._[0] === 'index') {
    return { kind: 'index', options: { vaults, model } };
  }
  return {
    kind: 'run',
    config: {
      vaults,
      semantic: {
        enabled: (args.semantic as boolean | undefined) ?? true,
        model,
      },
    },
  };
```

`src/server.ts`: `const service = new EmbeddingService({ profile: config.semantic.model });` and `createSemanticModule(registry, { profile: config.semantic.model }, { embeddingServiceFactory: () => embedder.asProvider(), ...deps.semantic })`; drop the `resolveModelProfile` import.

`src/modules/semantic/index.ts`:

```ts
import type { ModelProfile } from './model-profiles.js';

export interface ISemanticModuleConfig {
  profile: ModelProfile;
}

export interface ISemanticModuleDeps {
  embeddingServiceFactory?: (profile: ModelProfile) => EmbeddingProvider;
  searchEngine?: SearchEngine;
}
// ...
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ?? ((profile: ModelProfile) => new EmbeddingService({ profile }));
  const embeddingService = embeddingServiceFactory(config.profile);
  const semanticDeps: ISemanticToolDeps = {
    registry,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.profile.key,
  };
```

`src/cli-index.ts`:

```ts
export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embedder shared by every vault in the run, built from the selected profile. */
  createEmbedder?: (profile: ModelProfile) => IndexEmbedder;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbedder(profile: ModelProfile): IndexEmbedder {
  const service = new EmbeddingService({ profile });
  return { identity: service.identity, embed: (text) => service.embed(text) };
}
```

`runIndexCommand`: `const embedder = (deps.createEmbedder ?? defaultEmbedder)(options.model);`. In `reconcileOne`, pass

```ts
    {
      onProgress: createProgressRenderer(stdout, vault.name),
      onRebuild: ({ stored, active }) => {
        stdout.write(
          `rebuilding ${vault.name}: corpus was indexed with ${formatIdentity(stored)}; active model is ${formatIdentity(active)}\n`,
        );
      },
    },
```

- [ ] **Step 4: Fix the remaining call sites**

Run `npm run typecheck` and fix each report: `ServerConfig` literals in tests become `semantic: { enabled: …, model: resolveModelProfile(DEFAULT_MODEL_KEY) }`; `createSemanticModule(registry, { modelKey, modelId }, …)` becomes `createSemanticModule(registry, { profile: resolveModelProfile(DEFAULT_MODEL_KEY) }, …)`; an `embeddingServiceFactory: (modelId) => …` fake becomes `() => …`.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "feat(cli): select the embedding model profile with --model

The server and the index subcommand share one --model option with the
registry's keys as choices. index announces a rebuild before it starts.

Refs #98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.1: PR 1 docs

**Files:**
- Modify: `docs/architecture/cli-startup.md`, `docs/architecture/embedding-pipeline.md`, `docs/guide/configuration.md`, `docs/guide/installation.md`, `README.md`

- [ ] **Step 1: `docs/architecture/cli-startup.md`** — add `--model` to the option list (line 9) and a sentence after the vault-validation steps (lines 41–43): "`--model` is declared once and attached to both the server command and `index`; yargs `choices` rejects an unknown key with the allowed list before any vault is opened, and `parseConfig` resolves the key to its `ModelProfile` so nothing downstream handles an unknown key. A repeated `--model` is rejected." Add a short "Both invocations" note that `index` shares `--vault` and `--model`.
- [ ] **Step 2: `docs/architecture/embedding-pipeline.md`** — rewrite "What it is" and "Why it exists": the service is built from a `ModelProfile` (link `model-profiles.ts`), loads tokenizer + `AutoModel` through `local-model-loader.ts` (`@huggingface/transformers` 4.3.1, pinned revision, `dtype: 'q8'`, global cache dir `$XDG_CACHE_HOME/neuro-vault/models` or `~/.cache/neuro-vault/models`, log level error), encodes with special tokens then cuts to `maxTokens` (the v2 semantics, kept for corpus compatibility), pools by mask (`pooling.ts`), and reports `identity` — which the corpus records. Replace the "Output normalization" section with the pooling contract (positions from the mask). Replace "The service does not pick the model" with "`--model` picks the profile; the service never has a default". Keep "Lazy initialization" (unchanged behaviour).
- [ ] **Step 3: `docs/guide/configuration.md`** — add a row to the CLI arguments table: `--model <key>` | `bge-micro-v2` | Embedding model profile, one per process: `bge-micro-v2` or `granite-97m` (lite, multilingual). Applies to `index` too — use the same value for both, or the server rebuilds the corpus `index` built. Update line 77's warm-up command to show `--model`.
- [ ] **Step 4: `docs/guide/installation.md`** — replace line 103's model sentence: models download on first use into `~/.cache/neuro-vault/models` (or `$XDG_CACHE_HOME/neuro-vault/models`), shared across upgrades; Node ≥ 20.9; on CPU-only Linux set `ONNXRUNTIME_NODE_INSTALL=skip` (or the variable spike 1.1 recorded) to skip the CUDA download during install. Show `index --model` in the warm-up block (lines 107–115).
- [ ] **Step 5: `README.md`** — in the index section (lines 212–218) add `--model` and the "same value for server and index" sentence; fix "~40 MB" to "bge-micro-v2 ≈ 17 MB, granite-97m ≈ 98 MB".
- [ ] **Step 6: Commit**

```bash
git add docs README.md
git commit -m "docs: document --model, the profile registry and the model cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.2: Verify PR 1 on the vault copy and open it

- [ ] **Step 1: Gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS. Record the test count.

- [ ] **Step 2: Parity — v4 queries against the v2-built corpus**

```bash
mkdir -p "$SCRATCH/vault-copy" && rsync -a --delete /Users/amostovenko/Obsidian/ "$VAULT_COPY/"
npm run eval -- --vault "$VAULT_COPY" --pipeline semantic
```

Expected: `overall … mrr=0.398 ± 0.005` (the 2026-10-12 baseline). A larger gap means v4 embeds queries differently from v2 (dtype, tokenizer, pooling) — stop and investigate with `superpowers:systematic-debugging` before going on.

- [ ] **Step 3: Server start does not rebuild a matching corpus; stdout stays JSON-RPC**

```bash
REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"embeddings"}}}'
(printf '%s\n' "$REQ"; sleep 30) | node dist/cli.js --vault "$VAULT_COPY" > "$SCRATCH/pr1-stdout.jsonl" 2> "$SCRATCH/pr1-stderr.txt"
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) JSON.parse(l); console.log("stdout is JSON-RPC only")' "$SCRATCH/pr1-stdout.jsonl"
grep -c "was indexed with" "$SCRATCH/pr1-stderr.txt" || true
```

Expected: "stdout is JSON-RPC only"; the grep count is `0`.

- [ ] **Step 4: granite-97m end to end**

```bash
node dist/cli.js index --vault "$VAULT_COPY" --model granite-97m | tee "$SCRATCH/pr1-granite-index.txt"
(printf '%s\n' "$REQ"; sleep 30) | node dist/cli.js --vault "$VAULT_COPY" --model granite-97m > "$SCRATCH/pr1-granite.jsonl" 2> "$SCRATCH/pr1-granite-stderr.txt"
grep -c '"semantic' "$SCRATCH/pr1-granite.jsonl"
```

Expected: the index output starts with `rebuilding Obsidian: corpus was indexed with bge-micro-v2 (embed_version 1); active model is granite-97m (embed_version 1)` and ends with a summary with `failed=0`; the search response contains semantic provenance (count ≥ 1); stderr has no rebuild line (the corpus already matches).

- [ ] **Step 5: Unknown model**

```bash
node dist/cli.js --vault "$VAULT_COPY" --model nope; echo "exit=$?"
```

Expected: non-zero exit; the message lists `bge-micro-v2` and `granite-97m`.

- [ ] **Step 6: Open PR 1**

Commit the change folder if anything in it changed, push, and open the PR with `gh pr create --base main --title "feat: embedding model profiles — transformers.js 4, registry, --model (1/4)"`. The body (use `mattpocock-skills:pr` for shape) states: what landed (Tasks 1.2–2.4), the parity result, the granite run, the install-size delta from the spike, that no existing corpus is invalidated, `Refs #98`, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Bind it with the ccd_pr tools.

- [ ] **Step 7: STOP** — wait for the user's review and merge before Task 4.1.

---

# PR 2 — template-aware tokenisation, batching, harrier profiles (`Refs #98`)

Fresh worktree off `origin/main` (PR 1 merged), branch `feat/embedding-model-profiles-pr2`. Re-read Tasks 4.1–7.4 against `main` first.

**Reconciled against `main` @ `a049634` (PR 1 as merged).** PR 1's review changed code these snippets lean on; the tasks below already carry the fixes:

- **(a) `TokenizerHandle` lost `padding_side` / `pad_token_id`.** Task 5.3 Step 0 restores both (optional, read-only) together with the loader-test fake; 5.3's `padId` / `padSide` and 7.2's `tokenizer.padding_side` depend on them.
- **(b) `EmbeddingService`'s constructor refuses a non-empty `queryPrefix` / `documentPrefix`.** Task 4.1 keeps the refusal (`embedQuery` does not apply prefixes yet); Task 5.3 — where `embedRows` starts applying them — deletes it, its test, and the "not applied until" wording in `ModelProfile`'s doc comments. Without that, Task 7.1's harrier profiles would throw at construction.
- **(c) The loader refuses `model.config.max_position_embeddings < profile.maxTokens`.** Both harrier configs at their pinned revisions declare `max_position_embeddings: 32768` (checked in the model cache), so `maxTokens: 512` loads. Nothing to change in 7.1 / 7.2.
- **(d) The server's rebuild announcement lives in `createCorpusBackend`'s reconcile call (`onRebuild` in the options it passes to `deps.reconcile`).** Task 6.2's `backend/index.ts` change must keep forwarding `opts` to `reconcileCorpus` unchanged, and `test/semantic/backend/factory.test.ts` (fakes `asIndexEmbedFn`) moves to `asDocumentEmbedFn`.
- **(e) `eval/backends.ts` `loadSnapshot(vaultRoot, identity)` refuses another model's corpus.** PR 2 does not touch `eval/backends.ts`; Task 4.1 only renames `service.embed` → `service.embedQuery` in `eval/run.ts` and the provider literal in `eval/pipelines.ts`. `eval/pipelines.ts` has its **own** query-side `EmbedFn` type — it is not the corpus port and stays; Task 6.2's grep is scoped to `src test` for that reason.
- **Deferred PR 1 minors that land here:** pooling — `rowMask.length === dims[1]` check (reachable once rows are padded), mean under left padding at `b > 0`, zero-vector rejection (Task 5.3 Step 0); loader — dispose the model when export validation fails, tests for "no inference session", "forward pass returned no …" and the `token_embeddings` alias (Task 5.3 Step 0).
- **Environment:** the worktree guard blocks the bare word `eval` in commands. Run the harness as `npx tsx ./eval/run.ts`, and in greps write the directory as `./ev[a]l`.

### Task 4.1: Split query and document embedding in the provider contract

**Files:**
- Modify: `src/modules/semantic/types.ts` (incl. `ToolHandlerDependencies.embeddingProvider`), `src/types.ts` (re-export `QueryEmbedder` beside `EmbeddingProvider`), `src/modules/semantic/embedding-service.ts`, `src/modules/semantic/embed-queue.ts`, `src/modules/semantic/retrieval-policy.ts:150`, `src/modules/semantic/retrieval-pipeline.ts`, `src/modules/semantic/tools/{index,search-notes,get-similar-notes,find-duplicates}.ts` (dep types), `src/modules/semantic/index.ts`, `src/cli-index.ts`, `eval/pipelines.ts`, `eval/run.ts` (not `eval/backends.ts`)
- Test: every file holding an `EmbeddingProvider` fake — `test/lib/explicit-vault-prose.test.ts`, `test/lib/fan-out-prose.test.ts`, `test/semantic/retrieval-pipeline.test.ts`, `test/semantic/retrieval-policy.test.ts`, `test/semantic/tools/_calibration-fixture.ts`, `test/semantic/tools/_helpers.ts`, `test/semantic/tools/_hybrid-helpers.ts`, `test/semantic/tools/{get-similar-notes,index,search-notes-description,search-notes-filter,search-notes-hybrid,search-notes}.test.ts`, `test/server-modules.test.ts`, `test/semantic/embed-queue.test.ts`, `test/semantic/embedding-service.test.ts`, `test/eval/*.test.ts`

**Interfaces:**
- Produces: `interface QueryEmbedder { initialize(): Promise<void>; embedQuery(text: string): Promise<number[]> }`; `interface EmbeddingProvider extends QueryEmbedder { readonly identity: EmbeddingIdentity; readonly maxBatchSize: number; embedDocuments(texts: string[]): Promise<number[][]> }`. The retrieval path and every tool dep take `QueryEmbedder`. `EmbeddingService.maxBatchSize = 8`. `QueuedEmbedder.asProvider(): QueryEmbedder`; `embedIndex`/`asIndexEmbedFn` stay single-text until Task 6.1.

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/embedding-service.test.ts`:

```ts
  it('splits query and document embedding, with at most maxBatchSize documents per call', async () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(service.maxBatchSize).toBe(8);
    expect(await service.embedQuery('ab')).toEqual(unit([101, 1]));
    expect(await service.embedDocuments(['ab', 'cd'])).toHaveLength(2);
    await expect(service.embedDocuments(Array.from({ length: 9 }, () => 'x'))).rejects.toThrow(
      'embedDocuments takes at most 8 texts, got 9',
    );
  });
```

and rename every `service.embed(` in that file to `service.embedQuery(`. In `test/semantic/embed-queue.test.ts` (import `TEST_EMBEDDING_IDENTITY` from `../_identity.js`), make `controllableProvider().provider` a full `EmbeddingProvider`:

```ts
    provider: {
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async (text: string) => {
        order.push(text);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [1];
      },
      embedDocuments: async (texts: string[]) => {
        order.push(...texts);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return texts.map(() => [1]);
      },
    },
```

and add:

```ts
  it('routes the query lane to embedQuery and the index lane to embedDocuments', async () => {
    const calls: string[] = [];
    const embedder = createQueuedEmbedder({
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async (t) => (calls.push(`q:${t}`), [1]),
      embedDocuments: async (ts) => (calls.push(`d:${ts.join(',')}`), ts.map(() => [2])),
    });
    expect(await embedder.embedQuery('a')).toEqual([1]);
    expect(await embedder.embedIndex('b')).toEqual([2]);
    expect(calls).toEqual(['q:a', 'd:b']);
  });
```

Run: `npx vitest run test/semantic/embedding-service.test.ts test/semantic/embed-queue.test.ts` — Expected: FAIL.

- [ ] **Step 2: Change the contract**

`src/modules/semantic/types.ts` — replace `EmbeddingProvider`:

```ts
import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

/** What the retrieval path needs from an embedder: queries only. */
export interface QueryEmbedder {
  initialize(): Promise<void>;
  /** Embeds a search query; the provider applies its profile's query prefix. */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * A full embedding provider (design D4): the local transformers.js one today,
 * possibly a remote API later. Queries and documents are separate calls so the
 * query prefix stays a provider concern no caller can forget.
 */
export interface EmbeddingProvider extends QueryEmbedder {
  /** What produces this provider's vectors; the corpus manifest records it. */
  readonly identity: EmbeddingIdentity;
  /** The most texts one `embedDocuments` call accepts. */
  readonly maxBatchSize: number;
  /** Embeds document texts (no query prefix), vectors in input order. */
  embedDocuments(texts: string[]): Promise<number[][]>;
}
```

`src/modules/semantic/embedding-service.ts` — rename `embed` to a private `embedOne(text: string)` (keep the constructor's prefix refusal: `embedOne` still applies no prefix; Task 5.3 removes it), and add:

```ts
  readonly maxBatchSize = 8;

  embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length > this.maxBatchSize) {
      throw new Error(`embedDocuments takes at most ${this.maxBatchSize} texts, got ${texts.length}`);
    }
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await this.embedOne(text));
    return vectors;
  }
```

`src/modules/semantic/embed-queue.ts` — `run(entry)` keeps its lane but calls the right method: store `lane: 'query' | 'index'` on each `QueueEntry` and use `entry.lane === 'query' ? provider.embedQuery(entry.text) : provider.embedDocuments([entry.text]).then(([v]) => v)`; `asProvider(): QueryEmbedder` returns `{ initialize, embedQuery }`; the `embedQuery` method name on `QueuedEmbedder` is unchanged.

`src/modules/semantic/retrieval-policy.ts:150` — `await embeddingProvider.embedQuery(query)`; `RetrievalInput.embeddingProvider: QueryEmbedder`. Same type in `RetrievalPipelineDeps`, `SearchNotesDeps`, `ISemanticToolDeps`, and every tool dep that names `EmbeddingProvider`; `ISemanticModuleDeps.embeddingServiceFactory?: (profile: ModelProfile) => QueryEmbedder`.

`src/cli-index.ts` — `defaultEmbedder` embeds documents now: `embed: (text) => service.embedDocuments([text]).then(([vector]) => vector)`.

`eval/run.ts` — `return (text: string) => service.embedQuery(text);`. `eval/pipelines.ts` — `embeddingProvider: { initialize: () => Promise.resolve(), embedQuery: embed }`.

- [ ] **Step 3: Rename the fakes**

Run `npm run typecheck`. Every error of the form "Property 'embedQuery' is missing … but required in type 'QueryEmbedder'" points at a fake: rename its `embed` property to `embedQuery` (and any `.embed(` call on it to `.embedQuery(`). Do **not** rename `ReconcileDeps.embed` or `IndexEmbedder.embed` — those are document ports and change in Task 6.2. Repeat until clean.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "embeddingProvider.embed(\|\.embed(query" src ./ev[a]l`
Expected: PASS, clean, grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add -A src ./ev[a]l test
git commit -m "refactor(semantic): split query and document embedding in the provider contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.1: Derive the special-token template from the tokenizer

**Files:**
- Create: `src/modules/semantic/tokenization.ts`
- Test: `test/semantic/tokenization.test.ts`

**Interfaces:**
- Produces: `interface Encoder { encode(text: string, options: { add_special_tokens: boolean }): number[] }`; `interface SpecialTokenTemplate { prefix: number[]; suffix: number[] }`; `deriveTemplate(encoder: Encoder): SpecialTokenTemplate`.

- [ ] **Step 1: Write the failing test**

```ts
// test/semantic/tokenization.test.ts
import { describe, expect, it } from 'vitest';

import { deriveTemplate, type Encoder } from '../../src/modules/semantic/tokenization.js';

/** A tokenizer whose post-processor wraps content in `prefix … suffix`; raw ids are char codes. */
function templated(prefix: number[], suffix: number[]): Encoder {
  return {
    encode: (text, { add_special_tokens }) => {
      const raw = Array.from(text, (c) => c.charCodeAt(0));
      return add_special_tokens ? [...prefix, ...raw, ...suffix] : raw;
    },
  };
}

describe('deriveTemplate', () => {
  it.each([
    ['bos/eos (harrier-270m shape)', [2], [1]],
    ['suffix only (harrier-0.6b shape)', [], [151643]],
    ['start/return (granite-97m shape)', [179934], [179938]],
    ['no special tokens', [], []],
  ])('%s', (_name, prefix, suffix) => {
    expect(deriveTemplate(templated(prefix, suffix))).toEqual({ prefix, suffix });
  });

  it('refuses a tokenizer whose special-token output does not contain the raw run', () => {
    const broken: Encoder = { encode: (_t, { add_special_tokens }) => (add_special_tokens ? [7, 8] : [97]) };
    expect(() => deriveTemplate(broken)).toThrow('cannot derive the special-token template: [7, 8] does not contain [97]');
  });
});
```

Run: `npx vitest run test/semantic/tokenization.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
// src/modules/semantic/tokenization.ts

/** The tokenizer surface tokenisation needs. */
export interface Encoder {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
}

/** The special-token ids a tokenizer's post-processor places before and after content. */
export interface SpecialTokenTemplate {
  prefix: number[];
  suffix: number[];
}

const SENTINEL = 'a';

function indexOfRun(haystack: number[], needle: number[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((id, j) => haystack[i + j] === id)) return i;
  }
  return -1;
}

/**
 * Reads the template off the tokenizer instead of trusting a declared token:
 * harrier-0.6b's `eos_token_id` (151645) is not what its post-processor
 * appends (151643), so only the encoding itself is authoritative (design D5).
 */
export function deriveTemplate(encoder: Encoder): SpecialTokenTemplate {
  const raw = encoder.encode(SENTINEL, { add_special_tokens: false });
  const full = encoder.encode(SENTINEL, { add_special_tokens: true });
  const at = raw.length === 0 ? -1 : indexOfRun(full, raw);
  if (at === -1) {
    throw new Error(
      `cannot derive the special-token template: [${full.join(', ')}] does not contain [${raw.join(', ')}]`,
    );
  }
  return { prefix: full.slice(0, at), suffix: full.slice(at + raw.length) };
}
```

- [ ] **Step 3: Run the test and the gates**

Run: `npx vitest run test/semantic/tokenization.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/tokenization.ts test/semantic/tokenization.test.ts
git commit -m "feat(semantic): derive the special-token template from the tokenizer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.2: Template-aware rows and padding

**Files:**
- Modify: `src/modules/semantic/tokenization.ts`
- Test: `test/semantic/tokenization.test.ts`

**Interfaces:**
- Consumes: `Encoder`, `SpecialTokenTemplate` (5.1).
- Produces: `CHARS_PER_TOKEN_WORK_BOUND = 32`; `encodeRow(input: { prefix: string; content: string; template: SpecialTokenTemplate; maxTokens: number; encoder: Encoder }): number[]`; `padBatch(rows: number[][], padId: number, side: 'left' | 'right'): { ids: number[][]; mask: number[][] }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/tokenization.test.ts`:

```ts
import { CHARS_PER_TOKEN_WORK_BOUND, encodeRow, padBatch } from '../../src/modules/semantic/tokenization.js';

const bosEos = { prefix: [2], suffix: [1] };

describe('encodeRow', () => {
  const encoder = templated([2], [1]);

  it('wraps short content in the template unchanged', () => {
    expect(encodeRow({ prefix: '', content: 'ab', template: bosEos, maxTokens: 8, encoder })).toEqual([2, 97, 98, 1]);
  });

  it('keeps the end-of-sequence token when it truncates (the EOS regression)', () => {
    const row = encodeRow({ prefix: '', content: 'abcdefghijklmnop', template: bosEos, maxTokens: 8, encoder });
    expect(row).toHaveLength(8);
    expect(row).toEqual([2, 97, 98, 99, 100, 101, 102, 1]);
    // "special tokens, then truncate" would have produced [2, 97, …, 103] — no 1 at the end.
  });

  it('cuts the content, never the query prefix', () => {
    const row = encodeRow({ prefix: 'Q:', content: 'abcdefghij', template: bosEos, maxTokens: 6, encoder });
    expect(row).toEqual([2, 81, 58, 97, 98, 1]);
  });

  it('ends with the real suffix even when content contains the suffix id at the cut', () => {
    const tricky: Encoder = {
      encode: (text, { add_special_tokens }) => {
        const raw = text === 'a' ? [97] : [5, 5, 5, 5, 5, 1, 5, 5, 5];
        return add_special_tokens ? [2, ...raw, 1] : raw;
      },
    };
    const row = encodeRow({ prefix: '', content: 'note', template: bosEos, maxTokens: 8, encoder: tricky });
    expect(row).toEqual([2, 5, 5, 5, 5, 5, 1, 1]);
    expect(padBatch([row], 0, 'right').mask[0]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('bounds tokenizer work on a huge input before tokenising', () => {
    let seen = 0;
    const counting: Encoder = {
      encode: (text, opts) => {
        seen = Math.max(seen, text.length);
        return templated([2], [1]).encode(text, opts);
      },
    };
    encodeRow({ prefix: '', content: 'x'.repeat(5_000_000), template: bosEos, maxTokens: 512, encoder: counting });
    expect(seen).toBe(512 * CHARS_PER_TOKEN_WORK_BOUND);
  });

  it('refuses a window that leaves no room for content', () => {
    expect(() => encodeRow({ prefix: '', content: 'a', template: bosEos, maxTokens: 2, encoder })).toThrow(
      /no room for content/,
    );
  });
});

describe('padBatch', () => {
  it('pads on the right with the pad id and masks the pads', () => {
    expect(padBatch([[2, 9, 1], [2, 1]], 0, 'right')).toEqual({
      ids: [[2, 9, 1], [2, 1, 0]],
      mask: [[1, 1, 1], [1, 1, 0]],
    });
  });

  it('pads on the left when the tokenizer declares it', () => {
    expect(padBatch([[2, 9, 1], [2, 1]], 0, 'left')).toEqual({
      ids: [[2, 9, 1], [0, 2, 1]],
      mask: [[1, 1, 1], [0, 1, 1]],
    });
  });

  it('marks a suffix that equals the pad id as real (harrier-0.6b)', () => {
    expect(padBatch([[7, 151643], [151643]], 151643, 'right').mask).toEqual([[1, 1], [1, 0]]);
  });
});
```

Run: `npx vitest run test/semantic/tokenization.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement** (append to `tokenization.ts`)

```ts
/**
 * Characters of content handed to the tokenizer per token of window: a bound
 * on tokenizer work for multi-megabyte notes, not a budget. Real text runs
 * 1.6–2.9 characters per token, so it cannot bind before the token limit.
 */
export const CHARS_PER_TOKEN_WORK_BOUND = 32;

/**
 * One model input row: template prefix, then `prefix + content` encoded
 * without special tokens and cut to fit, then the template suffix. Encoding
 * prefix and content together tokenises their boundary the way the model was
 * trained; since the prefix comes first, a cut only ever removes content.
 */
export function encodeRow(input: {
  prefix: string;
  content: string;
  template: SpecialTokenTemplate;
  maxTokens: number;
  encoder: Encoder;
}): number[] {
  const { template, maxTokens, encoder } = input;
  const budget = maxTokens - template.prefix.length - template.suffix.length;
  if (budget < 1) throw new Error(`a ${maxTokens}-token window leaves no room for content`);
  const text = input.prefix + input.content.slice(0, maxTokens * CHARS_PER_TOKEN_WORK_BOUND);
  const ids = encoder.encode(text, { add_special_tokens: false }).slice(0, budget);
  return [...template.prefix, ...ids, ...template.suffix];
}

/** Pads rows to the longest with `padId` on `side`; the mask marks real tokens with 1. */
export function padBatch(
  rows: number[][],
  padId: number,
  side: 'left' | 'right',
): { ids: number[][]; mask: number[][] } {
  if (rows.length === 0) throw new Error('cannot pad an empty batch');
  const width = Math.max(...rows.map((row) => row.length));
  const ids: number[][] = [];
  const mask: number[][] = [];
  for (const row of rows) {
    const pads = new Array<number>(width - row.length).fill(padId);
    const zeros = new Array<number>(width - row.length).fill(0);
    const ones = new Array<number>(row.length).fill(1);
    ids.push(side === 'left' ? [...pads, ...row] : [...row, ...pads]);
    mask.push(side === 'left' ? [...zeros, ...ones] : [...ones, ...zeros]);
  }
  return { ids, mask };
}
```

- [ ] **Step 3: Run the test and the gates**

Run: `npx vitest run test/semantic/tokenization.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/tokenization.ts test/semantic/tokenization.test.ts
git commit -m "feat(semantic): template-aware truncation and declared-side padding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.3: `EmbeddingService` embeds template-aware batches

**Files:**
- Modify: `src/modules/semantic/embedding-service.ts`, `src/modules/semantic/local-model-loader.ts`, `src/modules/semantic/pooling.ts`, `src/modules/semantic/model-profiles.ts` (doc comments only)
- Test: `test/semantic/embedding-service.test.ts`, `test/semantic/local-model-loader.test.ts`, `test/semantic/pooling.test.ts`

**Interfaces:**
- Consumes: `deriveTemplate`, `encodeRow`, `padBatch` (5.1–5.2); `poolAndNormalize` (1.3); `LocalModel` (1.4).
- Produces: same public surface as Task 4.1; `embedDocuments` now runs one forward pass per call. `TokenizerHandle` regains `readonly padding_side?: string; readonly pad_token_id?: number | null`.

- [ ] **Step 0: Loader and pooling — restore pad metadata, land PR 1's deferred hardening**

PR 1's review dropped the tokenizer's pad metadata from `TokenizerHandle` (nothing read it yet); this task reads it. `src/modules/semantic/local-model-loader.ts`:

```ts
/** The tokenizer surface the provider uses — a structural slice of transformers.js's. */
export interface TokenizerHandle {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  /** The side the tokenizer pads on; transformers.js defaults to right when its config is silent. */
  readonly padding_side?: string;
  /** May equal a template id (harrier-0.6b pads with its suffix) — pooling reads the mask, never ids. */
  readonly pad_token_id?: number | null;
}
```

`RawModel` gains `dispose?(): Promise<unknown>;`. Wrap the session / input / output / window checks so a failed validation releases the ONNX session before rethrowing (`await model.dispose?.().catch(() => undefined); throw error;`) — a rejected export must not keep hundreds of MB of weights alive until GC.

`src/modules/semantic/pooling.ts` — in the token-state branch, per row, before reading positions:

```ts
    if (rowMask.length !== seq) {
      throw new Error(`input ${b} has ${rowMask.length} mask positions for ${seq} token states`);
    }
```

Tests. `test/semantic/local-model-loader.test.ts`: the fake's tokenizer becomes `{ encode: () => [1], padding_side: 'right', pad_token_id: 0 }`; the fake model gets `dispose: vi.fn(async () => {})` (returned from `fakeTransformers`), and an option to replace `sessions` (for `{}`). Add:
- `passes the tokenizer's padding side and pad id through` — `(await load(granite)).tokenizer` has `padding_side: 'right'`, `pad_token_id: 0`;
- `fails naming the profile when no inference session was loaded` — `sessions: {}` → `'model "granite-97m": no inference session was loaded'`;
- `disposes the model when export validation fails` — `outputNames: ['logits']` rejects and `dispose` was called once; a successful load does not call it;
- `fails naming the profile when the forward pass returns no output` — `outputNames: ['last_hidden_state']`, `outputs: {}` → `run` rejects with `'model "granite-97m": forward pass returned no "last_hidden_state"'`;
- `accepts token_embeddings as token states` — `outputNames: ['token_embeddings']`, `outputs: { token_embeddings: { data: [1, 2], dims: [1, 1, 2] } }` → `kind: 'token_states'`.

`test/semantic/pooling.test.ts`: add
- `mean ignores left pads on a later row` — `poolAndNormalize(states(2, 3), [[1, 1, 1], [0, 1, 1]], 'mean')[1]` equals `unit([12.5, 1])`;
- `rejects a zero vector` — `{ kind: 'pooled', data: [0, 0], dims: [1, 2] }` → `/zero vector/`;
- `rejects a mask row whose length disagrees with the sequence` — `poolAndNormalize(states(1, 3), [[1, 1]], 'cls')` → `/2 mask positions for 3 token states/`.

Run: `npx vitest run test/semantic/local-model-loader.test.ts test/semantic/pooling.test.ts` — Expected: FAIL first, PASS after the change. This step may be its own commit (`fix(semantic): dispose a rejected export; check mask width in pooling`).

- [ ] **Step 1: Write the failing tests**

Delete the `refuses a profile with a prefix it cannot apply yet` test: from this task on the service applies prefixes (the constructor's refusal goes in Step 2).

Add to `test/semantic/embedding-service.test.ts` (a self-contained fixture, separate from Task 1.5's `fakeModel`):

```ts
const lastTokenProfile: ModelProfile = {
  key: 'test-last-token',
  repo: 'test/repo',
  revision: '0'.repeat(40),
  dtype: 'q8',
  dims: 2,
  pooling: 'last_token',
  queryPrefix: 'Q: ',
  documentPrefix: '',
  maxTokens: 8,
};

/** bos=2 / eos=1 tokenizer padding with 0 on `side`; token state at each position is [id, 1]. */
function templatedModel(side: 'left' | 'right' = 'right') {
  const runs: Array<{ ids: number[][]; mask: number[][] }> = [];
  const encode = vi.fn((text: string, { add_special_tokens }: { add_special_tokens: boolean }) => {
    const raw = Array.from(text, (c) => c.charCodeAt(0));
    return add_special_tokens ? [2, ...raw, 1] : raw;
  });
  const model: LocalModel = {
    tokenizer: { encode, padding_side: side, pad_token_id: 0 },
    run: async (ids, mask) => {
      runs.push({ ids, mask });
      const data: number[] = [];
      for (const row of ids) for (const id of row) data.push(id, 1);
      return { kind: 'token_states', data, dims: [ids.length, ids[0].length, 2] };
    },
  };
  return { model, runs, encode };
}

describe('EmbeddingService — template-aware batches', () => {
  it('keeps the end-of-sequence token of an over-long document', async () => {
    const { model, runs } = templatedModel();
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    const [vector] = await service.embedDocuments(['abcdefghijklmnop']);
    expect(runs[0].ids[0]).toEqual([2, 97, 98, 99, 100, 101, 102, 1]);
    expect(vector).toEqual(unit([1, 1]));
  });

  it("gives a text the same vector alone and in a batch with longer texts", async () => {
    const { model } = templatedModel('right');
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    const [alone] = await service.embedDocuments(['ab']);
    const [batched] = await service.embedDocuments(['ab', 'abcdef']);
    expect(batched).toEqual(alone);
  });

  it('pads on the side the tokenizer declares', async () => {
    const { model, runs } = templatedModel('left');
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    await service.embedDocuments(['ab', 'abcd']);
    expect(runs[0].ids[0]).toEqual([0, 0, 2, 97, 98, 1]);
  });

  it('applies the query prefix to queries only', async () => {
    const { model, encode } = templatedModel();
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    await service.embedQuery('x');
    await service.embedDocuments(['x']);
    const raw = encode.mock.calls.filter(([, o]) => !o.add_special_tokens).map(([t]) => t);
    expect(raw).toContain('Q: x');
    expect(raw).toContain('x');
  });

  it('rejects a blank document, naming its index, before loading', async () => {
    const loader = vi.fn(async () => templatedModel().model);
    const service = new EmbeddingService({ profile: lastTokenProfile, loader });
    await expect(service.embedDocuments(['ok', '   '])).rejects.toThrow('document 1 is blank');
    expect(loader).not.toHaveBeenCalled();
  });

  it('returns no vectors for no documents without loading', async () => {
    const loader = vi.fn(async () => templatedModel().model);
    const service = new EmbeddingService({ profile: lastTokenProfile, loader });
    expect(await service.embedDocuments([])).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });
});
```

Update Task 1.5's `cuts an over-long input to the profile window` test (now via `embedQuery`): the row is still `maxTokens` long but **ends in `102`** — assert `expect(ids.at(-1)).toBe(102)` and `expect(ids.at(-2)).toBe(1509)` (510 body ids, 1000…1509), and replace its "v2 semantics" comment: the template is re-attached after the cut. Run: `npx vitest run test/semantic/embedding-service.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

Replace the encoding part of `embedding-service.ts` (keep `identity`, `maxBatchSize`, constructor, `initialize`, the retry logic):

```ts
import { deriveTemplate, encodeRow, padBatch, type SpecialTokenTemplate } from './tokenization.js';

interface Loaded {
  model: LocalModel;
  template: SpecialTokenTemplate;
  padId: number;
  padSide: 'left' | 'right';
}
// ...
  private loaded?: Loaded;

  async embedQuery(text: string): Promise<number[]> {
    const content = text.trim();
    if (!content) throw new Error('Embedding text must not be blank');
    const [vector] = await this.embedRows([content], this.profile.queryPrefix);
    if (vector === undefined) throw new Error('Embedding model returned no vector');
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length > this.maxBatchSize) {
      throw new Error(`embedDocuments takes at most ${this.maxBatchSize} texts, got ${texts.length}`);
    }
    if (texts.length === 0) return [];
    const contents = texts.map((text, index) => {
      const content = text.trim();
      if (!content) throw new Error(`document ${index} is blank`);
      return content;
    });
    // `return await`, not a bare return: the method must stay async so the
    // validation throws above reject instead of throwing synchronously.
    return await this.embedRows(contents, this.profile.documentPrefix);
  }

  /** Template-aware rows, padded on the tokenizer's side, pooled by mask (design D5). */
  private async embedRows(contents: string[], prefix: string): Promise<number[][]> {
    const { model, template, padId, padSide } = await this.getLoaded();
    const rows = contents.map((content) =>
      encodeRow({ prefix, content, template, maxTokens: this.profile.maxTokens, encoder: model.tokenizer }),
    );
    const { ids, mask } = padBatch(rows, padId, padSide);
    return poolAndNormalize(await model.run(ids, mask), mask, this.profile.pooling);
  }
```

and `getLoaded()` replaces `getModel()` — same shared-initialisation/retry shape, but its `.then` builds the `Loaded` record:

```ts
        .then((model) => {
          this.loaded = {
            model,
            template: deriveTemplate(model.tokenizer),
            padId: model.tokenizer.pad_token_id ?? 0,
            padSide: model.tokenizer.padding_side === 'left' ? 'left' : 'right',
          };
        })
```

Delete `embedOne`. Delete the constructor's `query/document prefixes are not supported yet` refusal (and its comment) — `embedRows` applies both prefixes now, and Task 7.1's harrier profiles would otherwise throw at construction. In `model-profiles.ts`, drop the "Not applied until `embedQuery` lands … refuses a non-empty one until then" sentence from `queryPrefix`'s doc comment and the "Same staging" one from `documentPrefix`'s.

- [ ] **Step 3: Run the tests and the gates**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic test/semantic
git commit -m "feat(semantic): template-aware truncation and batched forward passes

The provider now truncates raw token ids and re-attaches the tokenizer's
special-token template, so an over-long input keeps its end-of-sequence
token — required for last-token pooling.

Refs #98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.1: The queue batches documents by length; queries keep priority

**Files:**
- Modify: `src/modules/semantic/embed-queue.ts`
- Test: `test/semantic/embed-queue.test.ts`

**Interfaces:**
- Produces: `bucketByLength(texts: readonly string[], maxBatchSize: number): number[][]`; `QueuedEmbedder { initialize(); embedQuery(text); embedDocuments(texts): Promise<number[][]>; asProvider(): QueryEmbedder; asDocumentEmbedFn(): (texts: string[]) => Promise<number[][]>; asIndexEmbedFn(): (text: string) => Promise<number[]> }` — `asIndexEmbedFn` survives only until Task 6.2 and is now `(text) => embedDocuments([text]).then(([v]) => v)`; `embedIndex` is removed.

- [ ] **Step 1: Write the failing tests**

Add to `test/semantic/embed-queue.test.ts`:

```ts
import { bucketByLength, createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';

describe('bucketByLength', () => {
  it('groups shortest-first, at most maxBatchSize per bucket', () => {
    const texts = Array.from({ length: 10 }, (_, i) => 'x'.repeat(10 + i));
    expect(bucketByLength(texts, 8).map((b) => b.length)).toEqual([8, 2]);
  });

  it('starts a new bucket when a text is more than twice the bucket’s shortest', () => {
    const texts = ['aaaa', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaa', 'aaaaaaaaaaaaaaaaaaaaa'];
    expect(bucketByLength(texts, 8)).toEqual([[0, 2], [1, 3]]);
  });

  it('puts a note’s long own text in a different bucket from its short blocks', () => {
    const note = 'n'.repeat(2000);
    const blocks = Array.from({ length: 6 }, () => 'b'.repeat(250));
    expect(bucketByLength([note, ...blocks], 8)).toEqual([[1, 2, 3, 4, 5, 6], [0]]);
  });

  it('returns no buckets for no texts', () => {
    expect(bucketByLength([], 8)).toEqual([]);
  });
});

/** A provider whose every call blocks until released by hand, in order. */
function gatedProvider() {
  const log: string[] = [];
  const gates: Array<() => void> = [];
  const wait = () => new Promise<void>((resolve) => gates.push(resolve));
  return {
    log,
    releaseNext: () => gates.shift()?.(),
    provider: {
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 2,
      initialize: async () => {},
      embedQuery: async (t: string) => (log.push(`q:${t}`), await wait(), [0]),
      embedDocuments: async (ts: string[]) => (
        log.push(`d:${ts.join(',')}`), await wait(), ts.map((t) => [t.length])
      ),
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('createQueuedEmbedder — batching', () => {
  it('returns vectors in input order across buckets', async () => {
    const { provider, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const result = embedder.embedDocuments(['ccc', 'a', 'bb']);
    for (let i = 0; i < 2; i++) {
      await flush();
      releaseNext();
    }
    expect(await result).toEqual([[3], [1], [2]]);
  });

  it('runs a query after the in-flight bucket and before queued ones', async () => {
    const { provider, log, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const docs = embedder.embedDocuments(['aa', 'aa', 'bbbbbbbbbb', 'bbbbbbbbbb']);
    await flush();
    const query = embedder.embedQuery('q');
    for (let i = 0; i < 3; i++) {
      await flush();
      releaseNext();
    }
    await Promise.all([docs, query]);
    expect(log).toEqual(['d:aa,aa', 'q:q', 'd:bbbbbbbbbb,bbbbbbbbbb']);
  });

  it('gives two concurrent callers their own vectors when their buckets interleave', async () => {
    const { provider, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const a = embedder.embedDocuments(['a1', 'a2', 'aaaaaaa3']);
    const b = embedder.embedDocuments(['b', 'bbbbbbbbbbbb']);
    for (let i = 0; i < 4; i++) {
      await flush();
      releaseNext();
    }
    expect(await a).toEqual([[2], [2], [8]]);
    expect(await b).toEqual([[1], [12]]);
  });

  it('a failed bucket rejects only its own call', async () => {
    let calls = 0;
    const embedder = createQueuedEmbedder({
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async () => [0],
      embedDocuments: async (ts) => {
        calls += 1;
        if (calls === 1) throw new Error('onnx exploded');
        return ts.map(() => [1]);
      },
    });
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow('onnx exploded');
    await expect(embedder.embedDocuments(['y'])).resolves.toEqual([[1]]);
  });
});
```

Delete the old tests that call `embedIndex`. Run: `npx vitest run test/semantic/embed-queue.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement** (replace `embed-queue.ts`)

```ts
import type { EmbeddingProvider, QueryEmbedder } from './types.js';

interface QueueEntry {
  /** Never rejects: the outcome is already routed to the caller's promise. */
  work: () => Promise<void>;
}

export interface QueuedEmbedder {
  initialize(): Promise<void>;
  /** Query lane — jumps ahead of every queued indexing batch. */
  embedQuery(text: string): Promise<number[]>;
  /** Indexing lane — one entry per length bucket, FIFO behind every pending query. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** `QueryEmbedder` view for the retrieval path. */
  asProvider(): QueryEmbedder;
  /** Document-embed view for `reconcileCorpus`. */
  asDocumentEmbedFn(): (texts: string[]) => Promise<number[][]>;
  /** Single-text view, kept until reconcile takes the batch port. */
  asIndexEmbedFn(): (text: string) => Promise<number[]>;
}

/**
 * Groups text indices shortest-first into buckets of at most `maxBatchSize`
 * whose longest text is at most twice the shortest (design D6). A note's own
 * text contains all its blocks, so it is nearly always its longest input;
 * batching it with them would pad every block to its length.
 */
export function bucketByLength(texts: readonly string[], maxBatchSize: number): number[][] {
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length || a - b);
  const buckets: number[][] = [];
  let current: number[] = [];
  for (const index of order) {
    const shortest = current[0];
    const full = current.length >= maxBatchSize;
    const tooLong = shortest !== undefined && texts[index].length > 2 * texts[shortest].length;
    if (current.length > 0 && (full || tooLong)) {
      buckets.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) buckets.push(current);
  return buckets;
}

/**
 * Serializes embedding work onto one provider, process-wide (design D7): one
 * forward pass at a time. Queries always drain first, so a search issued mid
 * cold-index waits for at most the one batch in flight.
 */
export function createQueuedEmbedder(provider: EmbeddingProvider): QueuedEmbedder {
  const queryLane: QueueEntry[] = [];
  const indexLane: QueueEntry[] = [];
  let running = false;

  function pump(): void {
    if (running) return;
    const entry = (queryLane.length > 0 ? queryLane : indexLane).shift();
    if (!entry) return;
    running = true;
    void entry.work().finally(() => {
      running = false;
      pump();
    });
  }

  function enqueue<T>(lane: QueueEntry[], work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      lane.push({ work: () => work().then(resolve, reject) });
      pump();
    });
  }

  function embedQuery(text: string): Promise<number[]> {
    return enqueue(queryLane, () => provider.embedQuery(text));
  }

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors = new Array<number[]>(texts.length);
    await Promise.all(
      bucketByLength(texts, provider.maxBatchSize).map(async (bucket) => {
        const batch = await enqueue(indexLane, () => provider.embedDocuments(bucket.map((i) => texts[i])));
        if (batch.length !== bucket.length) {
          throw new Error(`provider returned ${batch.length} vectors for ${bucket.length} texts`);
        }
        bucket.forEach((textIndex, k) => {
          vectors[textIndex] = batch[k];
        });
      }),
    );
    return vectors;
  }

  return {
    initialize: () => provider.initialize(),
    embedQuery,
    embedDocuments,
    asProvider: () => ({ initialize: () => provider.initialize(), embedQuery }),
    asDocumentEmbedFn: () => embedDocuments,
    asIndexEmbedFn: () => async (text) => {
      const [vector] = await embedDocuments([text]);
      return vector;
    },
  };
}
```

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/embed-queue.ts test/semantic/embed-queue.test.ts
git commit -m "feat(semantic): batch document embeds by length behind the query lane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.2: Reconcile embeds each note in one batched call

**Files:**
- Modify: `src/lib/obsidian/corpus/types.ts` (`EmbedFn` → `EmbedDocumentsFn`), `src/lib/obsidian/corpus/reconcile.ts`, `src/modules/semantic/embed-queue.ts` (remove `asIndexEmbedFn`), `src/modules/semantic/backend/index.ts`, `src/cli-index.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts`, `test/semantic/backend/corpus-backend.test.ts`, `test/semantic/backend/factory.test.ts` (its embedder fake `{ asIndexEmbedFn: … }` becomes `{ asDocumentEmbedFn: () => async (ts: string[]) => ts.map(() => [1]) }`), `test/cli-index.test.ts`, `test/semantic/embed-queue.test.ts`

**Interfaces:**
- Produces: `type EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>`; `ReconcileDeps.embedDocuments: EmbedDocumentsFn` (replaces `embed`); `IndexEmbedder = { identity: EmbeddingIdentity; embedDocuments: EmbedDocumentsFn }`.

- [ ] **Step 1: Write the failing tests**

In `test/lib/obsidian/corpus/reconcile.test.ts`, replace `fakeEmbed` with a batch fake (same per-text vector):

```ts
function vectorFor(text: string): number[] {
  const vector = new Array<number>(TEST_DIMS).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    vector[i % TEST_DIMS] = Math.fround((vector[i % TEST_DIMS] ?? 0) + text.charCodeAt(i) / 1000);
  }
  return vector;
}

/** Deterministic fake document embedder: each vector is a checkable function of its text. */
function fakeEmbedDocuments() {
  return vi.fn(async (texts: string[]) => texts.map(vectorFor));
}
```

rename `embed` → `embedDocuments` in `harness()` (keep returning it as `embed` so existing assertions read unchanged), import `buildEmbedInputs` from `../../../../src/lib/obsidian/corpus/embed-text.js`, and add:

```ts
  it('embeds a note’s text and its blocks in one call, in order', async () => {
    const note = `# Top\n${'a'.repeat(250)}\n\n## Inner\n${'b'.repeat(250)}\n`;
    const { run, embed } = await harness({ 'A.md': note });
    await run();
    expect(embed).toHaveBeenCalledTimes(1);
    const inputs = buildEmbedInputs('A.md', note);
    expect(embed.mock.calls[0][0]).toEqual([inputs.note, ...inputs.blocks.map((b) => b.embedText)]);
    expect(inputs.blocks.length).toBeGreaterThan(0);
  });

  it('a failed call fails only that note and keeps its previous shard', async () => {
    const { run, vault, store, embed } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    const before = await store.readShard('A.md');
    vault.edit('A.md', body('A2'));
    vault.edit('B.md', body('B2'));
    embed.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes('A2'))) throw new Error('batch failed');
      return texts.map(vectorFor);
    });
    const summary = await run();
    expect(summary).toMatchObject({ embedded: 1, failed: 1 });
    expect(await store.readShard('A.md')).toEqual(before);
  });
```

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts` — Expected: FAIL (type errors / one call per input).

- [ ] **Step 2: Implement**

`types.ts` — replace `EmbedFn`:

```ts
/** The indexer's only view of the embedding model: documents in, vectors out, in order (design D4). */
export type EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>;
```

`reconcile.ts` — `ReconcileDeps.embedDocuments: EmbedDocumentsFn;` (doc comment: one call per note) and `embedNote`:

```ts
async function embedNote(
  notePath: string,
  note: NoteContent,
  hash: string,
  embedDocuments: EmbedDocumentsFn,
  store: CorpusStore,
): Promise<void> {
  const inputs = buildEmbedInputs(notePath, note.content);
  // One call per note: the embedder batches within it, and a failure stays
  // this note's alone — its previous shard is left untouched.
  const texts = [...(inputs.note === null ? [] : [inputs.note]), ...inputs.blocks.map((b) => b.embedText)];
  const vectors = texts.length === 0 ? [] : await embedDocuments(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} inputs`);
  }
  let next = 0;
  const embedding = inputs.note === null ? null : encodeVector(vectors[next++]);
  const blocks: CorpusBlock[] = inputs.blocks.map((block) => ({
    key: block.key,
    heading: block.heading,
    lines: block.lines,
    embedding: encodeVector(vectors[next++]),
  }));
  await store.writeShard({ path: notePath, content_hash: hash, mtime: note.mtime, size: note.size, embedding, blocks });
}
```

`backend/index.ts` — `const embedDocuments = deps.embedder.asDocumentEmbedFn();` and `reconcileCorpus({ ...fsDeps, embedDocuments, store, warn, identity: deps.identity }, opts)`. Keep forwarding `opts` untouched: since PR 1's review, `createCorpusBackend` passes the server's stderr rebuild announcement as `opts.onRebuild` (and `onProgress`/`signal`) through this call — dropping `opts` silently loses the announcement. The existing `corpus-backend.test.ts` rebuild-line tests must stay green.

`cli-index.ts` — `IndexEmbedder.embedDocuments: EmbedDocumentsFn`; the default wraps the service in the queue so `index` gets the same bucketing as the server:

```ts
function defaultEmbedder(profile: ModelProfile): IndexEmbedder {
  const service = new EmbeddingService({ profile });
  return { identity: service.identity, embedDocuments: createQueuedEmbedder(service).asDocumentEmbedFn() };
}
```

`embed-queue.ts` — delete `asIndexEmbedFn` from the interface and the returned object.

- [ ] **Step 3: Fix the remaining tests**

Run `npm run typecheck`; in `corpus-backend.test.ts` replace `EmbedFn` fakes `async () => vec` with `async (texts: string[]) => texts.map(() => vec)` and the `embed:` key with `embedDocuments:`; in `cli-index.test.ts` `makeDeps` returns `{ identity: TEST_EMBEDDING_IDENTITY, embedDocuments: async (ts: string[]) => ts.map(() => [0.1, 0.2]) }` and the "one shared embed function" test compares `deps.embedDocuments` across vaults.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "EmbedFn\b\|asIndexEmbedFn\|embedIndex" src test`
Expected: PASS, clean, grep prints nothing. (Not `eval/`: `eval/pipelines.ts` declares its own query-side `EmbedFn`, which is not the corpus port and stays.)

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat(corpus): embed each note in one batched call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.1: The harrier profiles join the registry

**Files:**
- Modify: `src/modules/semantic/model-profiles.ts`
- Test: `test/semantic/model-profiles.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/semantic/model-profiles.test.ts`, change the key-set test to

```ts
    expect([...MODEL_KEYS].sort()).toEqual(['bge-micro-v2', 'granite-97m', 'harrier-0.6b', 'harrier-270m']);
    expect(DEFAULT_MODEL_KEY).toBe('bge-micro-v2');
```

update the unknown-key message to `choose one of: bge-micro-v2, granite-97m, harrier-270m, harrier-0.6b`, and add:

```ts
  const HARRIER_PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

  it('describes harrier-270m as a last-token profile with the instruction prefix', () => {
    expect(resolveModelProfile('harrier-270m')).toMatchObject({
      repo: 'onnx-community/harrier-oss-v1-270m-ONNX',
      revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
      dims: 640,
      pooling: 'last_token',
      queryPrefix: HARRIER_PREFIX,
      documentPrefix: '',
      maxTokens: 512,
    });
  });

  it('describes harrier-0.6b as the quality profile', () => {
    expect(resolveModelProfile('harrier-0.6b')).toMatchObject({
      repo: 'onnx-community/harrier-oss-v1-0.6b-ONNX',
      revision: 'e4daffa011e666dcd2ff2a3c6c05084090ac314d',
      dims: 1024,
      pooling: 'last_token',
      queryPrefix: HARRIER_PREFIX,
      documentPrefix: '',
      maxTokens: 512,
    });
  });
```

Run: `npx vitest run test/semantic/model-profiles.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
/** harrier's retrieval instruction (model card); documents take no prompt. */
const HARRIER_QUERY_PREFIX =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

const HARRIER_270M: ModelProfile = {
  key: 'harrier-270m',
  repo: 'onnx-community/harrier-oss-v1-270m-ONNX',
  revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
  dtype: 'q8',
  dims: 640,
  pooling: 'last_token',
  queryPrefix: HARRIER_QUERY_PREFIX,
  documentPrefix: '',
  maxTokens: 512,
};

const HARRIER_0_6B: ModelProfile = {
  key: 'harrier-0.6b',
  repo: 'onnx-community/harrier-oss-v1-0.6b-ONNX',
  revision: 'e4daffa011e666dcd2ff2a3c6c05084090ac314d',
  dtype: 'q8',
  dims: 1024,
  pooling: 'last_token',
  queryPrefix: HARRIER_QUERY_PREFIX,
  documentPrefix: '',
  maxTokens: 512,
};
```

and add both to `MODEL_PROFILES` after `GRANITE_97M` (insertion order is the order `MODEL_KEYS` and `--help` list them). The loader's window check (`max_position_embeddings < maxTokens` → refuse) passes: both pinned configs declare `max_position_embeddings: 32768`. The constructor no longer refuses prefixes (Task 5.3), so `new EmbeddingService({ profile: resolveModelProfile('harrier-270m') })` must construct — add that as a test in `test/semantic/embedding-service.test.ts`.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS (the config tests from Task 2.4 build their expectations from `MODEL_KEYS`, so they follow).

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/model-profiles.ts test/semantic/model-profiles.test.ts test/semantic/embedding-service.test.ts
git commit -m "feat(semantic): add the harrier-270m and harrier-0.6b profiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.2: Verify every profile's real tokenizer in CI

**Files:**
- Create: `test/integration/profile-tokenizers.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the env-gated test**

```ts
// test/integration/profile-tokenizers.test.ts
import { describe, expect, it } from 'vitest';

import { defaultModelCacheDir, type TokenizerHandle } from '../../src/modules/semantic/local-model-loader.js';
import { MODEL_KEYS, resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';
import { deriveTemplate, encodeRow } from '../../src/modules/semantic/tokenization.js';

// Downloads each profile's tokenizer (not its weights) at the pinned revision.
// Off by default; the `profile-tokenizers` CI job turns it on.
const enabled = process.env.NEURO_VAULT_HF_TESTS === '1';

const EXPECTED: Record<string, { prefix: number[]; suffix: number[]; side: string }> = {
  'bge-micro-v2': { prefix: [101], suffix: [102], side: 'right' },
  'granite-97m': { prefix: [179934], suffix: [179938], side: 'right' },
  'harrier-270m': { prefix: [2], suffix: [1], side: 'right' },
  'harrier-0.6b': { prefix: [], suffix: [151643], side: 'right' },
};

describe.skipIf(!enabled)('profile tokenizers at their pinned revisions', () => {
  it('covers every registered profile', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...MODEL_KEYS].sort());
  });

  for (const key of MODEL_KEYS) {
    it(`${key}: derived template, padding side, truncation keeps the suffix`, async () => {
      // Imported here so a skipped run never loads the library.
      const { AutoTokenizer, env } = await import('@huggingface/transformers');
      env.cacheDir = defaultModelCacheDir();
      const profile = resolveModelProfile(key);
      const tokenizer = (await AutoTokenizer.from_pretrained(profile.repo, {
        revision: profile.revision,
      })) as unknown as TokenizerHandle;

      const template = deriveTemplate(tokenizer);
      expect(template).toEqual({ prefix: EXPECTED[key].prefix, suffix: EXPECTED[key].suffix });
      expect(tokenizer.padding_side).toBe(EXPECTED[key].side);

      const row = encodeRow({
        prefix: '',
        content: 'векторний пошук and semantic retrieval over notes. '.repeat(300),
        template,
        maxTokens: profile.maxTokens,
        encoder: tokenizer,
      });
      expect(row).toHaveLength(profile.maxTokens);
      expect(row.slice(row.length - template.suffix.length)).toEqual(template.suffix);
    }, 180_000);
  }
});
```

Run locally once: `NEURO_VAULT_HF_TESTS=1 npx vitest run test/integration/profile-tokenizers.test.ts` — Expected: PASS for all four (fix `EXPECTED` from spike 1.1 if the bge ids differ). Run `npx vitest run test/integration` without the variable — Expected: skipped.

- [ ] **Step 2: Add the CI job** (append under `jobs:` in `.github/workflows/ci.yml`)

```yaml
  profile-tokenizers:
    name: Profile tokenizers (pinned revisions)
    runs-on: ubuntu-latest
    env:
      NEURO_VAULT_HF_TESTS: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
        env:
          ONNXRUNTIME_NODE_INSTALL: skip
      - uses: actions/cache@v4
        with:
          path: ~/.cache/neuro-vault/models
          key: profile-tokenizers-${{ hashFiles('src/modules/semantic/model-profiles.ts') }}
      - name: Verify each profile's tokenizer
        run: npx vitest run test/integration/profile-tokenizers.test.ts
```

(Use the install variable spike 1.1 confirmed.)

- [ ] **Step 3: Gates and commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add test/integration/profile-tokenizers.test.ts .github/workflows/ci.yml
git commit -m "ci: verify each profile's real tokenizer template at its pinned revision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.3: PR 2 docs

**Files:**
- Modify: `docs/architecture/embedding-pipeline.md`, `docs/architecture/semantic-backend.md`, `docs/architecture/own-corpus.md`, `docs/guide/configuration.md`

- [ ] **Step 1: `embedding-pipeline.md`** — add sections "Tokenisation" (the six steps of design D5: raw ids, template derived by sentinel diff, budget, re-attach, pad on the declared side, mask pooling; why: transformers.js truncates after the post-processor, which drops the EOS a last-token model pools from; the `max_tokens × 32` work bound), "Queries and documents" (`embedQuery` applies the profile prefix, `embedDocuments` takes ≤ `maxBatchSize`), and "Batching" (one forward pass per call; the queue's length buckets). Update the invariants: vectors are unit-length and pooled per profile; no prefix is ever added by a caller.
- [ ] **Step 2: `semantic-backend.md`** (lines 69–74) — the queue's index lane now holds one entry per length bucket (≤ 8 texts, longest ≤ 2× shortest); a query waits for at most the one batch in flight (≈ 0.5 s on harrier-270m at 8 × 512 tokens) instead of one embed.
- [ ] **Step 3: `own-corpus.md`** — line 9: the port is `EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>`, one call per note; a failed call fails only that note. Replace "The tokenizer cap" section (lines 64–66) with a pointer to `embedding-pipeline.md` § Tokenisation.
- [ ] **Step 4: `docs/guide/configuration.md`** — `--model` row lists all four keys; one line per profile: `bge-micro-v2` (current default, English-centred), `granite-97m` (lite multilingual, ~98 MB), `harrier-270m` (multilingual, ~344 MB), `harrier-0.6b` (highest quality, ~706 MB, ~4× slower to index).
- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: document template-aware tokenisation and batched indexing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.4: Verify PR 2 on the vault copy and open it

- [ ] **Step 1: Gates** — `npm test && npm run lint && npm run typecheck && npm run build` — all PASS; record the test count.

- [ ] **Step 2: Measure the bge-micro drift on capped inputs**

Refresh the copy (it must hold the live bge-micro corpus): `rsync -a --delete /Users/amostovenko/Obsidian/ "$VAULT_COPY/"`. Write `probe-drift.ts` at the worktree root:

```ts
// probe-drift.ts — throwaway: cosine between stored v2 vectors and new vectors for over-long notes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildEmbedInputs } from './src/lib/obsidian/corpus/embed-text.js';
import { CorpusStore } from './src/lib/obsidian/corpus/shard-store.js';
import { decodeVector } from './src/lib/obsidian/corpus/vector-codec.js';
import { EmbeddingService } from './src/modules/semantic/embedding-service.js';
import { resolveModelProfile } from './src/modules/semantic/model-profiles.js';

const vault = process.argv[2];
const service = new EmbeddingService({ profile: resolveModelProfile('bge-micro-v2') });
const shards = [...(await new CorpusStore(vault, { dims: 384 }).listShards()).values()];
const cosines: number[] = [];
for (const shard of shards) {
  if (shard.embedding === null) continue;
  const content = await readFile(path.join(vault, shard.path), 'utf8');
  const note = buildEmbedInputs(shard.path, content).note;
  if (note === null || note.length < 1800) continue; // only inputs near or over the 512-token cap
  const [fresh] = await service.embedDocuments([note]);
  const stored = decodeVector(shard.embedding);
  cosines.push(fresh.reduce((s, v, i) => s + v * stored[i], 0));
}
cosines.sort((a, b) => a - b);
console.log({ n: cosines.length, min: cosines[0], median: cosines[Math.floor(cosines.length / 2)] });
```

Run: `npx tsx probe-drift.ts "$VAULT_COPY"`, record `n`, `min`, `median` (expected: median ≥ 0.99), then `rm probe-drift.ts`.

- [ ] **Step 3: Cold-index timing, batched vs unbatched, harrier-270m**

Batched (the product path):

```bash
rm -rf "$VAULT_COPY/.neuro-vault/corpus"
/usr/bin/time -l node dist/cli.js index --vault "$VAULT_COPY" --model harrier-270m 2> "$SCRATCH/pr2-batched-time.txt" | tail -1
```

Unbatched: write `probe-unbatched.ts` at the worktree root that runs the same reconcile with a provider wrapper reporting `maxBatchSize: 1`:

```ts
// probe-unbatched.ts — throwaway: cold index with batch size 1 for comparison.
import { buildReconcileFsDeps } from './src/lib/obsidian/corpus/fs-deps.js';
import { corpusIdentityOf } from './src/lib/obsidian/corpus/identity.js';
import { reconcileCorpus } from './src/lib/obsidian/corpus/reconcile.js';
import { CorpusStore } from './src/lib/obsidian/corpus/shard-store.js';
import { FsVaultReader } from './src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from './src/lib/obsidian/vault-scope-config.js';
import { createQueuedEmbedder } from './src/modules/semantic/embed-queue.js';
import { EmbeddingService } from './src/modules/semantic/embedding-service.js';
import { resolveModelProfile } from './src/modules/semantic/model-profiles.js';

const vaultRoot = process.argv[2];
const service = new EmbeddingService({ profile: resolveModelProfile('harrier-270m') });
const unbatched = {
  identity: service.identity,
  maxBatchSize: 1,
  initialize: () => service.initialize(),
  embedQuery: (t: string) => service.embedQuery(t),
  embedDocuments: (ts: string[]) => service.embedDocuments(ts),
};
const identity = corpusIdentityOf(service.identity);
const reader = new FsVaultReader({ vaultRoot, scope: await loadVaultScope(vaultRoot) });
const started = Date.now();
const summary = await reconcileCorpus({
  ...buildReconcileFsDeps({ vaultRoot, reader }),
  embedDocuments: createQueuedEmbedder(unbatched).asDocumentEmbedFn(),
  store: new CorpusStore(vaultRoot, { dims: identity.dims }),
  identity,
});
console.log({ seconds: (Date.now() - started) / 1000, ...summary });
```

```bash
rm -rf "$VAULT_COPY/.neuro-vault/corpus"
npx tsx probe-unbatched.ts "$VAULT_COPY"
rm probe-unbatched.ts
```

Record both wall times and the batched run's max RSS. Expected: batched faster than unbatched, and within "minutes" (bake-off: 6–11 min for ~6k vectors). If batched is not faster, or exceeds ~15 min, record it and open a follow-up issue for cross-note batching (design D6) — do not change scope inside this PR.

Run the batched index **last** (or re-run it after the probe) so the copy ends with a product-built harrier-270m corpus for Step 4.

- [ ] **Step 4: The server with `--model harrier-270m` answers with semantic hits; stdout stays JSON-RPC**

Same `REQ` as Task 3.2 Step 3:

```bash
(printf '%s\n' "$REQ"; sleep 60) | node dist/cli.js --vault "$VAULT_COPY" --model harrier-270m > "$SCRATCH/pr2-harrier.jsonl" 2> "$SCRATCH/pr2-harrier-stderr.txt"
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) JSON.parse(l); console.log("stdout is JSON-RPC only")' "$SCRATCH/pr2-harrier.jsonl"
grep -c '"semantic' "$SCRATCH/pr2-harrier.jsonl"
grep -c "was indexed with" "$SCRATCH/pr2-harrier-stderr.txt" || true
```

Expected: "stdout is JSON-RPC only"; semantic provenance count ≥ 1; no rebuild line (the corpus already matches). Do **not** measure harrier's retrieval quality with the eval harness here: it still queries with the default profile and refuses a harrier corpus (`eval --model` is PR 3).

- [ ] **Step 5: Review Focus 3, 4, 5 are closed by tests** — confirm by name: 3 → Task 5.2 `ends with the real suffix even when content contains the suffix id at the cut`; 4 → Task 6.1 `gives two concurrent callers their own vectors when their buckets interleave`; 5 → Task 5.3 `rejects a blank document, naming its index, before loading`.

- [ ] **Step 6: Open PR 2**

`gh pr create --base main --title "feat: embedding model profiles — template-aware tokenisation, batching, harrier (2/4)"`. Body: what landed (Tasks 4.1–7.3); the EOS regression test named explicitly; the drift numbers and why there is no `embed_version` bump here (design D5 "Cost"); the timing table; the new CI job; `harrier-270m` and `harrier-0.6b` are opt-in, the default stays `bge-micro-v2`; no existing corpus is invalidated; `Refs #98`; footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Bind with the ccd_pr tools.

- [ ] **Step 7: STOP** — wait for review and merge before Task 8.1.

---

# PR 3 — eval model axis, thresholds as profile data (`Refs #98`)

Fresh worktree off `origin/main` (PR 2 merged), branch `feat/embedding-model-profiles-pr3`. Re-read Tasks 8.1–10.1 against `main` first.

**Reconciled against `main` @ `ce6b57b` (PR 2 as merged).** PR 2's review changed code around these snippets; the tasks below already carry the fixes:

- **(a) `LocalModel` carries `template`** — the loader derives it inside export validation; `EmbeddingService` no longer does. PR 3 constructs the service only as `new EmbeddingService({ profile })` (eval) and never touches the template. Nothing to change.
- **(b) The corpus port is `EmbedDocumentsFn` (one call per note); `asIndexEmbedFn` / `embedIndex` are gone.** No PR 3 snippet names them. `eval/pipelines.ts`'s `EmbedFn` is the harness's own query-side type, not the corpus port: it stays, and `runEval`'s `deps.embed?: EmbedFn` stays with it.
- **(c) The queue rejects blank text with the caller's index and skips a failed call's remaining buckets (3f2c909).** PR 3 does not touch the queue's behaviour. The deferred minor that lands here is `bucketByLength`'s comment (and design D6) claiming a note's text is "almost always" its longest input — false while `EMBED_CHAR_BUDGET` caps the note text but not its blocks (349 of 888 notes on the verification vault have a longer block). Fixed in its own commit before Task 8.1.
- **(d) `eval/backends.ts` `loadSnapshot(vaultRoot, identity)` already refuses another model's corpus (PR 1).** Task 9.2 does **not** add a second gate: the check stays in `loadSnapshot` — the one place the runner reads the corpus — and moves *ahead of* shard listing, so a corpus of another width is refused on its manifest instead of failing shard by shard. The signature stays `loadSnapshot(vaultRoot, expected)`; the `--model <key>` in the rebuild command is `expected.model_key` (one source, no separate `modelKey` argument), and `--vault` names the resolved vault root instead of a literal `<path>`.
- **(e) `eval/run.ts` embeds queries through `service.embedQuery`, so the harrier query prefix is applied by the provider.** Task 9.1 makes `runEval` build that service from `args.model` (today it resolves `DEFAULT_MODEL_KEY` itself) and pins it with a test: `--model` reaches the embedder and the gate, nothing else picks a profile.
- **(f) Thresholds.** Task 8.x moves `semanticThreshold`, `FALLBACK_THRESHOLD`, `DEFAULT_EXPANSION_FLOOR` (and the two tool defaults) into `ModelProfile.similarity` with today's values on **every** profile, harrier included. Calibration is PR 4.
- **Report identity.** `runEval`'s `deps.modelId` override goes away in Task 9.3; the report's `identity` is always `identityOf(args.model)`, `model_id` is `identity.model_id`.
- **Commits.** Task 8.2's `git add` also stages `src/modules/semantic/effort-profiles.ts` and `test/semantic/effort-profiles.test.ts` (it edits both).
- **Environment** (as in PR 2): the worktree guard blocks the bare word `eval` and compound commands touching the scratchpad path. Run the harness as `npx tsx ./eval/run.ts`, write the directory as `./ev[a]l` in greps, and do multi-step verification with a `.mjs`/`.mts` driver in the scratchpad launched by one simple command (top-level `await` only in `.mts`). Probes live in the scratchpad, never at the worktree root (`eslint .` / `prettier --check .` would pick them up).

### Task 8.1: Similarity defaults move into the profile; the retrieval policy reads them

**Files:**
- Modify: `src/modules/semantic/model-profiles.ts`, `src/modules/semantic/effort-profiles.ts`, `src/modules/semantic/retrieval-policy.ts`, `src/modules/semantic/retrieval-pipeline.ts`, `src/modules/semantic/tools/search-notes.ts` (deps + plumbing only), `src/modules/semantic/tools/index.ts`, `src/modules/semantic/index.ts`, `eval/pipelines.ts`, `eval/run.ts`, `test/_identity.ts`
- Test: `test/semantic/effort-profiles.test.ts`, `test/semantic/retrieval-policy.test.ts`, `test/semantic/model-profiles.test.ts`, plus every `executeRetrieval` / tool-deps fixture the typecheck flags (`test/semantic/calibration-curve.test.ts`, `test/semantic/tools/_helpers.ts`, `test/semantic/tools/_hybrid-helpers.ts`, `test/semantic/tools/_calibration-fixture.ts`, `test/semantic/retrieval-pipeline.test.ts`, `test/eval/*.test.ts`)

**Interfaces:**
- Produces: `interface SimilarityDefaults { quick; deep; fallback; expansionFloor; similarNotes; duplicates }` and `ModelProfile.similarity` in `model-profiles.ts`; `RetrievalInput.similarity: SimilarityDefaults` (required); `RetrievalPipelineDeps.similarity`; `SearchNotesDeps.similarity`; `ISemanticToolDeps.similarity`. The retrieval path stops reading `EFFORT_PROFILES.*.semanticThreshold`, `FALLBACK_THRESHOLD` and `DEFAULT_EXPANSION_FLOOR`; they stay exported until Task 8.2 moves the descriptions off them and deletes them (removing them here would break `search-notes.ts`'s descriptions mid-task). `test/_identity.ts` gains `TEST_SIMILARITY` (today's values).

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/model-profiles.test.ts`:

```ts
  it('carries similarity defaults on every profile, ordered quick ≥ deep > fallback', () => {
    for (const key of MODEL_KEYS) {
      const { quick, deep, fallback } = resolveModelProfile(key).similarity;
      expect(quick).toBeGreaterThanOrEqual(deep);
      expect(deep).toBeGreaterThan(fallback);
    }
  });
```

Append to `test/semantic/retrieval-policy.test.ts` (the two imports join the file's import block):

```ts
import type { SearchEngine, SmartSource } from '../../src/modules/semantic/types.js';
import type { SimilarityDefaults } from '../../src/modules/semantic/model-profiles.js';

const DISTINCT: SimilarityDefaults = {
  quick: 0.7,
  deep: 0.6,
  fallback: 0.55,
  expansionFloor: 0.9,
  similarNotes: 0.8,
  duplicates: 0.99,
};
const QUERY = [1, 0];
const SOURCES = new Map<string, SmartSource>([['a.md', { path: 'a.md', embedding: [0, 1], blocks: [] }]]);
const embedder = { initialize: async () => {}, embedQuery: async () => QUERY };

describe('executeRetrieval — profile similarity defaults', () => {
  it("filters at the profile's quick default, then retries at its fallback", async () => {
    const thresholds: number[] = [];
    const searchEngine = {
      findNeighbors: ({ threshold }: { threshold: number }) => (thresholds.push(threshold), []),
      findBlockNeighbors: () => [],
      findDuplicates: () => [],
    } as unknown as SearchEngine;
    await executeRetrieval({ queries: ['q'], mode: 'quick', sources: SOURCES, embeddingProvider: embedder, searchEngine, similarity: DISTINCT });
    expect(thresholds).toEqual([0.7, 0.55]);
  });

  it("uses the profile's deep default for seeds and block evidence, and its expansion floor", async () => {
    const calls: Array<[string, number]> = [];
    const searchEngine = {
      findNeighbors: ({ queryVector, threshold }: { queryVector: number[]; threshold: number }) => {
        calls.push([queryVector === QUERY ? 'seed' : 'expansion', threshold]);
        return queryVector === QUERY ? [{ path: 'a.md', similarity: 0.65 }] : [];
      },
      findBlockNeighbors: ({ threshold }: { threshold: number }) => (calls.push(['block', threshold]), []),
      findDuplicates: () => [],
    } as unknown as SearchEngine;
    await executeRetrieval({ queries: ['q'], mode: 'deep', sources: SOURCES, embeddingProvider: embedder, searchEngine, similarity: DISTINCT });
    expect(calls).toContainEqual(['seed', 0.6]);
    expect(calls).toContainEqual(['block', 0.6]);
    expect(calls).toContainEqual(['expansion', 0.9]);
  });

  it('an explicit threshold still wins and never falls back', async () => {
    const thresholds: number[] = [];
    const searchEngine = {
      findNeighbors: ({ threshold }: { threshold: number }) => (thresholds.push(threshold), []),
      findBlockNeighbors: () => [],
      findDuplicates: () => [],
    } as unknown as SearchEngine;
    await executeRetrieval({ queries: ['q'], mode: 'quick', threshold: 0.95, sources: SOURCES, embeddingProvider: embedder, searchEngine, similarity: DISTINCT });
    expect(thresholds).toEqual([0.95]);
  });
});
```

Run: `npx vitest run test/semantic/model-profiles.test.ts test/semantic/retrieval-policy.test.ts` — Expected: FAIL.

- [ ] **Step 2: Add the defaults to the profiles**

In `model-profiles.ts`:

```ts
/** Default similarity thresholds, on this profile's own similarity scale (design D10). */
export interface SimilarityDefaults {
  /** `search_notes` semantic floor at effort "quick". */
  readonly quick: number;
  /** `search_notes` semantic floor at effort "deep"; also the deep block-evidence floor. */
  readonly deep: number;
  /** One-shot retry floor when a default threshold finds nothing. */
  readonly fallback: number;
  /** Default seed↔note floor for the expansion leg. */
  readonly expansionFloor: number;
  /** `get_similar_notes` default threshold. */
  readonly similarNotes: number;
  /** `find_duplicates` default threshold. */
  readonly duplicates: number;
}

/**
 * The values calibrated on bge-micro-v2's similarity scale. Every profile
 * carries them until it is recalibrated against its own scale (design D11).
 */
const BGE_SCALE_SIMILARITY: SimilarityDefaults = Object.freeze({
  quick: 0.5,
  deep: 0.35,
  fallback: 0.3,
  expansionFloor: 0.35,
  similarNotes: 0.5,
  duplicates: 0.9,
});
```

add `readonly similarity: SimilarityDefaults;` to `ModelProfile` and `similarity: BGE_SCALE_SIMILARITY,` to all four profiles. In `test/_identity.ts`:

```ts
import type { SimilarityDefaults } from '../src/modules/semantic/model-profiles.js';

/** Today's bge-scale defaults, for fixtures that do not care about the scale. */
export const TEST_SIMILARITY: SimilarityDefaults = {
  quick: 0.5,
  deep: 0.35,
  fallback: 0.3,
  expansionFloor: 0.35,
  similarNotes: 0.5,
  duplicates: 0.9,
};
```

- [ ] **Step 3: Thread them through retrieval**

`effort-profiles.ts`: unchanged in this task.

`retrieval-policy.ts` (drop its `EFFORT_PROFILES`-threshold, `FALLBACK_THRESHOLD` and `DEFAULT_EXPANSION_FLOOR` reads):

```ts
import type { SimilarityDefaults } from './model-profiles.js';
// ModeConfig loses `threshold`; toModeConfig drops it.
export interface RetrievalInput {
  // ...existing fields...
  /** The active profile's defaults — every implicit threshold comes from here. */
  similarity: SimilarityDefaults;
}
// in executeRetrieval:
  const threshold = input.threshold ?? input.similarity[mode];
  const expansionFloor = input.expansionFloor ?? input.similarity.expansionFloor;
// fallback branch:
      if (neighbors.length === 0 && !explicitThreshold && threshold > input.similarity.fallback) {
        // ... threshold: input.similarity.fallback,
// deep block pass (was MODE_DEFAULTS.deep.threshold):
              threshold: input.similarity.deep,
```

`retrieval-pipeline.ts`: `RetrievalPipelineDeps.similarity: SimilarityDefaults`, passed as `similarity: deps.similarity` into `executeRetrieval`.

`tools/search-notes.ts`: `SearchNotesDeps.similarity: SimilarityDefaults`; add `'similarity'` to the `Pick` in `runSearchForEntry`'s deps and pass it into the pipeline deps; `entryDeps` includes it. (Descriptions change in Task 8.2.)

`tools/index.ts`: `ISemanticToolDeps.similarity: SimilarityDefaults`. `semantic/index.ts`: `similarity: config.profile.similarity` in `semanticDeps`.

`eval/pipelines.ts`: `rankQuery`/`rankFused` take `similarity: SimilarityDefaults` and pass it to `executeRetrieval`; `eval/run.ts` passes `profile.similarity`.

- [ ] **Step 4: Fix the fixtures**

Run `npm run typecheck`; add `similarity: TEST_SIMILARITY` to every `executeRetrieval({...})` call, pipeline-deps literal and tool-deps helper it reports (`makeSearchDeps` and friends take an optional `similarity` defaulting to `TEST_SIMILARITY`). Repeat until clean.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "FALLBACK_THRESHOLD\|DEFAULT_EXPANSION_FLOOR\|semanticThreshold" src/modules/semantic/retrieval-policy.ts src/modules/semantic/retrieval-pipeline.ts eval`
Expected: PASS (the calibration-curve snapshots are unchanged — so are the values), clean, and the grep prints nothing — only `effort-profiles.ts` and `search-notes.ts`'s descriptions still name them, until Task 8.2.

- [ ] **Step 6: Commit**

```bash
git add -A src eval test
git commit -m "refactor(semantic): read similarity defaults from the active model profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8.2: `search_notes` describes the active profile's defaults

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/effort-profiles.ts`
- Test: `test/semantic/tools/search-notes-description.test.ts`, `test/semantic/effort-profiles.test.ts`, `test/semantic/tools/search-notes.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/semantic/tools/search-notes-description.test.ts`, give `builtTool` a `similarity` parameter and drop the `DEFAULT_EXPANSION_FLOOR`/`FALLBACK_THRESHOLD` imports:

```ts
function builtTool(similarity: SimilarityDefaults = TEST_SIMILARITY) {
  return buildSearchNotesTool({
    registry: makeTestRegistry([]),
    embeddingProvider: { initialize: () => Promise.resolve(), embedQuery: () => Promise.resolve([1]) },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
    modelKey: 'k',
    similarity,
  });
}
```

In the source-pin test replace the four threshold tokens with `'${similarity.quick}'`, `'${similarity.deep}'`, `'${similarity.fallback}'`, `'${similarity.expansionFloor}'` (the pool/cap tokens stay), and replace the advertised-schema test with:

```ts
  it('advertises the active profile’s defaults in the input schema', () => {
    const distinct = { quick: 0.61, deep: 0.47, fallback: 0.42, expansionFloor: 0.73, similarNotes: 0.6, duplicates: 0.95 };
    const schema = JSON.stringify(z.toJSONSchema(builtTool(distinct).inputSchema));
    expect(schema).toContain('effort defaults (0.61 quick / 0.47 deep) with one retry at 0.42');
    expect(schema).toContain('Default 0.73');
    expect(schema).not.toContain('0.9+');
  });
```

In `test/semantic/effort-profiles.test.ts`, pin only the model-independent knobs (remove `semanticThreshold`, `FALLBACK_THRESHOLD`, `DEFAULT_EXPANSION_FLOOR`). Also add to `test/semantic/tools/search-notes.test.ts` a fallback-note case: with `similarity.fallback = 0.42` and an array query whose hits came from the fallback, the `query_stats` note reads `Semantic hits came from the 0.42 fallback retry, so they are weaker than a normal result.` Run the two files — Expected: FAIL.

- [ ] **Step 2: Implement**

In `buildSearchNotesTool`, read `const { similarity } = deps;` and replace the two `.describe(...)` strings:

```ts
        .describe(
          `Min semantic similarity 0-1 on the semantic leg's note scores. An explicit value is a hard filter with no fallback — zero hits are honest. Omitted: effort defaults (${similarity.quick} quick / ${similarity.deep} deep) with one retry at ${similarity.fallback}. Never affects the lexical or expansion leg.`,
        ),
```

```ts
        .describe(
          `Min seed↔note similarity 0-1 for the expansion leg (deep effort only), on a note-to-note scale that typically runs far higher than query scores. Default ${similarity.expansionFloor}, and \`threshold\` never affects it.`,
        ),
```

Give `queryStatsNote` a `fallbackThreshold: number` argument used in its fallback sentence (`Semantic hits came from the ${fallbackThreshold} fallback retry, …`), add it to `buildQueryStats`'s args, and pass `deps.similarity.fallback` at both `buildQueryStats` call sites. Then, in `effort-profiles.ts`, delete `semanticThreshold` from `EffortProfile` and both profiles and delete `FALLBACK_THRESHOLD` and `DEFAULT_EXPANSION_FLOOR`, updating the header comment (thresholds live on the model profile now); remove their remaining imports. `grep -rn "FALLBACK_THRESHOLD\|DEFAULT_EXPANSION_FLOOR\|semanticThreshold" src eval test` must print nothing.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/semantic/tools/search-notes.ts src/modules/semantic/effort-profiles.ts test/semantic/tools test/semantic/effort-profiles.test.ts
git commit -m "feat(search): describe the active profile's similarity defaults

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8.3: `get_similar_notes` and `find_duplicates` take their defaults from the profile

**Files:**
- Modify: `src/modules/semantic/tools/get-similar-notes.ts`, `src/modules/semantic/tools/find-duplicates.ts`
- Test: `test/semantic/tools/get-similar-notes.test.ts`, `test/semantic/tools/find-duplicates.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/semantic/tools/find-duplicates.test.ts`:

```ts
  it('applies the profile’s duplicates default when threshold is omitted', async () => {
    const thresholds: number[] = [];
    const registry = makeTestRegistry([
      { name: 'v', path: os.tmpdir(), backend: toBackend(makeFakeCorpusIndex(new Map())) },
    ]);
    const tool = buildFindDuplicatesTool({
      registry,
      searchEngine: {
        findNeighbors,
        findBlockNeighbors,
        findDuplicates: (args) => (thresholds.push(args.threshold), []),
      },
      modelKey: MODEL_KEY,
      similarity: { ...TEST_SIMILARITY, duplicates: 0.97 },
    });
    await callTool(registerTool(tool), {});
    expect(thresholds).toEqual([0.97]);
  });
```

`test/semantic/tools/get-similar-notes.test.ts` (uses the file's `makeTempVault`):

```ts
  it('applies the profile’s similarNotes default when threshold is omitted', async () => {
    const { vaultRoot, cleanup } = await makeTempVault({ 'a.md': '# A\n' });
    try {
      const thresholds: number[] = [];
      const sources = new Map<string, SmartSource>([['a.md', makeSyntheticSource('a.md')]]);
      const tool = buildGetSimilarNotesTool({
        registry: makeTestRegistry([{ name: 'v', path: vaultRoot, backend: toBackend(makeFakeCorpusIndex(sources)) }]),
        embeddingProvider: { initialize: vi.fn(), embedQuery: vi.fn() },
        searchEngine: {
          findNeighbors: (args) => (thresholds.push(args.threshold), []),
          findDuplicates,
          findBlockNeighbors,
        },
        modelKey: MODEL_KEY,
        similarity: { ...TEST_SIMILARITY, similarNotes: 0.77 },
      });
      await callTool(registerTool(tool), { path: 'a.md' });
      expect(thresholds).toContain(0.77);
      expect(thresholds).not.toContain(0.5);
    } finally {
      await cleanup();
    }
  });
```

(import `TEST_SIMILARITY` from `../../_identity.js`.) Run both files — Expected: FAIL (still 0.9 / 0.5).

- [ ] **Step 2: Implement**

Add `similarity: SimilarityDefaults` to `GetSimilarNotesDeps` and `FindDuplicatesDeps`; delete `DEFAULT_THRESHOLD = 0.5` and `DEFAULT_DUPLICATE_THRESHOLD = 0.9`; use `readThreshold(input.threshold, deps.similarity.similarNotes, 'threshold')` and `readThreshold(input.threshold, deps.similarity.duplicates, 'threshold')`. Fix the fixtures the typecheck flags with `similarity: TEST_SIMILARITY`.

- [ ] **Step 3: Run everything and commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add src/modules/semantic/tools test/semantic/tools
git commit -m "feat(semantic): take get_similar_notes and find_duplicates defaults from the profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.1: `--model`, `--stats`, `--baseline` in the eval argument parser

**Files:**
- Modify: `eval/run.ts` (`EvalArgs`, `USAGE`, `parseEvalArgs`)
- Test: `test/eval/run.test.ts`

**Interfaces:**
- Produces: `interface EvalArgs { vault: string; pipeline: PipelineId; model: ModelProfile; stats: boolean; baseline?: string }`.

- [ ] **Step 1: Write the failing tests** (replace the `parseEvalArgs` describe block)

```ts
describe('parseEvalArgs', () => {
  it('parses value flags and defaults model and stats', () => {
    expect(parseEvalArgs(['--vault', '/v', '--pipeline', 'fused'])).toEqual({
      vault: '/v',
      pipeline: 'fused',
      model: resolveModelProfile(DEFAULT_MODEL_KEY),
      stats: false,
    });
  });

  it('selects a model and turns statistics on', () => {
    const args = parseEvalArgs(['--vault', '/v', '--model', 'granite-97m', '--stats', '--baseline', '/r.json']);
    expect(args.model.key).toBe('granite-97m');
    expect(args.stats).toBe(true);
    expect(args.baseline).toBe('/r.json');
  });

  it.each([
    [['--pipeline', 'semantic'], /--vault/],
    [['--vault', '/v', '--pipeline', 'reranked'], /semantic.*fused/s],
    [['--vault', '/v', '--pipeline', 'semantic', '--bogus'], /--bogus/],
    [['--vault', '--pipeline'], /--vault/],
    [['--vault', '/v', '--model', 'text-embedding-3-small'], /bge-micro-v2.*granite-97m/s],
    [['--vault', '/v', '--baseline', '/r.json'], /--baseline requires --stats/],
    [['--vault', '/v', '--pipeline', 'fused', '--stats'], /--stats measures the semantic pipeline/],
  ])('rejects %j naming what is supported', (argv, pattern) => {
    expect(() => parseEvalArgs(argv)).toThrow(UsageError);
    expect(() => parseEvalArgs(argv)).toThrow(pattern);
  });

  it('rejects the retired backend axis', () => {
    expect(() => parseEvalArgs(['--vault', '/v', '--backend', 'sc'])).toThrow(/backend/i);
  });
});
```

Run: `npx vitest run test/eval/run.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
import { DEFAULT_MODEL_KEY, MODEL_KEYS, resolveModelProfile, type ModelProfile } from '../src/modules/semantic/model-profiles.js';

export interface EvalArgs {
  vault: string;
  pipeline: PipelineId;
  model: ModelProfile;
  stats: boolean;
  baseline?: string;
}

const USAGE =
  'usage: npm run eval -- --vault <path> [--pipeline <semantic|fused>] [--model <key>] [--stats [--baseline <report.json>]]';
const VALUE_FLAGS = ['--vault', '--pipeline', '--model', '--baseline'];

export function parseEvalArgs(argv: string[]): EvalArgs {
  const values = new Map<string, string>();
  let stats = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--stats') {
      stats = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) {
      throw new UsageError(`unknown argument "${flag}"\n${USAGE}`);
    }
    const value = argv[i + 1];
    // A value token that is itself a flag means the real value was omitted.
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} is missing its value\n${USAGE}`);
    }
    values.set(flag, value);
    i += 1;
  }
  const vault = values.get('--vault');
  if (vault === undefined) throw new UsageError(`--vault is required\n${USAGE}`);
  const pipeline = values.get('--pipeline') ?? 'semantic';
  if (pipeline !== 'semantic' && pipeline !== 'fused') {
    throw new UsageError(`unknown pipeline "${pipeline}" — supported: semantic, fused`);
  }
  const modelKey = values.get('--model') ?? DEFAULT_MODEL_KEY;
  if (!MODEL_KEYS.includes(modelKey)) {
    throw new UsageError(`unknown model "${modelKey}" — supported: ${MODEL_KEYS.join(', ')}`);
  }
  const baseline = values.get('--baseline');
  if (baseline !== undefined && !stats) throw new UsageError(`--baseline requires --stats\n${USAGE}`);
  if (stats && pipeline !== 'semantic') {
    throw new UsageError('--stats measures the semantic pipeline; drop --pipeline fused');
  }
  return {
    vault,
    pipeline,
    model: resolveModelProfile(modelKey),
    stats,
    ...(baseline !== undefined ? { baseline } : {}),
  };
}
```

Then make `runEval` use the parsed profile — it is the only profile the run sees (reconcile note (e)):

```ts
  const profile = args.model; // was resolveModelProfile(DEFAULT_MODEL_KEY)
  const sources = await loadSnapshot(vaultRoot, corpusIdentityOf(identityOf(profile)));
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService({ profile });
      return (text: string) => service.embedQuery(text);
    })();
```

and add an end-to-end test that the selected profile reaches the gate: a fixture corpus whose manifest is `bge-micro-v2`'s, run with `model: resolveModelProfile('granite-97m')`, rejects with `BackendError` naming `granite-97m` before the (rejecting) stub `embed` is called. (The embedder side is `new EmbeddingService({ profile })` → `embedQuery`, which applies the profile's query prefix; `test/semantic/embedding-service.test.ts` already pins that.)

- [ ] **Step 3: Run, then commit**

Run: `npx vitest run test/eval/run.test.ts && npm run typecheck && npm run lint` — Expected: PASS (end-to-end tests still construct `EvalArgs` by hand; add `model` and `stats: false` there).

```bash
git add eval/run.ts test/eval/run.test.ts
git commit -m "feat(eval): parse --model, --stats and --baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.2: Eval refuses a corpus built by another profile

**Files:**
- Modify: `eval/backends.ts`, `eval/run.ts`
- Test: `test/eval/backends.test.ts`

**Interfaces:**
- Consumes: `corpusIdentityOf`, `formatIdentity` (corpus identity module), `isManifestCompatible` (`shard-store.ts`), `identityOf` (`model-profiles.ts`).
- Produces: `loadSnapshot(vaultRoot: string, expected: CorpusIdentity): Promise<Map<string, SmartSource>>` — signature unchanged since PR 1; the gate is reworked in place, not duplicated in `run.ts` (reconcile note (d)).

- [ ] **Step 1: Write the failing tests**

In `test/eval/backends.test.ts`, replace the PR 1 test "fails a corpus indexed with another model, naming both identities" with the two below; the success test's `ensureManifest(TEST_IDENTITY)` setup already writes a matching manifest. In `test/eval/run.test.ts`, the end-to-end fixtures pass `model: resolveModelProfile('granite-97m')` explicitly and write the manifest `corpusIdentityOf(identityOf(granite))` (via `ensureManifest`) with 384-dim vectors — explicit, so they survive PR 4's switch of the default to a 640-dim profile:

```ts
  it('refuses a corpus built by another profile before listing shards, naming the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    // A 640-wide shard under a granite manifest: the manifest must be what refuses it.
    const wide = new CorpusStore(vaultRoot, { dims: 640 });
    await wide.writeManifest({ ...TEST_IDENTITY, model_key: 'granite-97m', dims: 640, created: 'x' });
    await wide.writeShard({ path: 'a.md', content_hash: 'h', mtime: 1, size: 1, embedding: encodeVector(new Array<number>(640).fill(0.01)), blocks: [] });
    await expect(loadSnapshot(vaultRoot, { ...TEST_IDENTITY, model_key: 'harrier-270m' })).rejects.toThrow(
      `was indexed with granite-97m (embed_version 1), not harrier-270m (embed_version 1) — rebuild it for this model with: neuro-vault-mcp index --vault ${vaultRoot} --model harrier-270m`,
    );
  });

  it('refuses shards whose manifest is missing', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const store = new CorpusStore(vaultRoot, { dims: TEST_DIMS });
    await store.writeShard({ path: 'a.md', content_hash: 'h', mtime: 1, size: 1, embedding: encodeVector(unitVec(0)), blocks: [] });
    await expect(loadSnapshot(vaultRoot, TEST_IDENTITY)).rejects.toThrow(
      `has no readable manifest — rebuild it with: neuro-vault-mcp index --vault ${vaultRoot} --model bge-micro-v2`,
    );
  });
```

The existing "fails an empty corpus" test additionally expects `--model bge-micro-v2` in the message.

Run — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// eval/backends.ts
import path from 'node:path';

import { formatIdentity, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import { CorpusStore, isManifestCompatible } from '../src/lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../src/lib/obsidian/corpus/snapshot.js';
import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';

export class BackendError extends Error {}

/**
 * The corpus the server owns, decoded — but only if it was built by the
 * profile this run embeds queries with. Eval never rebuilds (design D12).
 */
export async function loadSnapshot(
  vaultRoot: string,
  expected: CorpusIdentity,
): Promise<Map<string, SmartSource>> {
  const corpusDir = path.join(vaultRoot, '.neuro-vault/corpus');
  const rebuild = `neuro-vault-mcp index --vault ${vaultRoot} --model ${expected.model_key}`;
  const store = new CorpusStore(vaultRoot, { dims: expected.dims });
  // Before listing: shards of another width would each fail validation loudly.
  const manifest = await store.readManifest();
  if (manifest !== null && !isManifestCompatible(manifest, expected, true)) {
    throw new BackendError(
      `own corpus at ${corpusDir} was indexed with ${formatIdentity(manifest)}, not ${formatIdentity(expected)} — rebuild it for this model with: ${rebuild}`,
    );
  }
  const snapshot = await loadCorpusSnapshot(store);
  if (snapshot.sources.size === 0) {
    throw new BackendError(`own corpus at ${corpusDir} is missing or empty — build it with: ${rebuild}`);
  }
  if (manifest === null) {
    throw new BackendError(`own corpus at ${corpusDir} has no readable manifest — rebuild it with: ${rebuild}`);
  }
  return snapshot.sources;
}
```

`eval/run.ts` already calls `loadSnapshot(vaultRoot, corpusIdentityOf(identityOf(profile)))` with `profile = args.model` (Task 9.1) — no change there; `runEval` stays free of a second manifest check.

- [ ] **Step 3: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS. (The "Corpus absent" test now expects the message to contain `neuro-vault-mcp index`; it does.)

```bash
git add eval/backends.ts test/eval/backends.test.ts test/eval/run.test.ts
git commit -m "feat(eval): refuse a corpus built by another model profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.3: Reports record the profile and the scores rankings came from

**Files:**
- Modify: `eval/metrics.ts`, `eval/pipelines.ts`, `eval/report.ts`, `eval/run.ts`
- Test: `test/eval/metrics.test.ts`, `test/eval/pipelines.test.ts`, `test/eval/report.test.ts`, `test/eval/run.test.ts`

**Interfaces:**
- Produces: `interface RankedPath { path: string; score: number }`; `rankQuery(args: { pipeline; queryVector: number[]; sources; similarity; fusedContext? }): Promise<RankedPath[]>`; `scoreQuery(entry, ranked: RankedPath[], bestRelevantSimilarity: number | null): QueryScore` with new fields `top_scores: number[]`, `relevant_ranks: number[]`, `best_relevant_similarity: number | null`; `bestRelevantSimilarity(queryVector, relevant: string[], sources): number | null`; `EvalReport` gains `model_key: string`, `identity: EmbeddingIdentity`, `stats?: CalibrationStats`; report file `<stamp>-<model_key>-<pipeline>.json`.

- [ ] **Step 1: Write the failing tests**

`test/eval/metrics.test.ts`:

```ts
  it('records the score each path was ranked by and every relevant rank', () => {
    const entry = { id: 'q1', query: 'x', lang: 'en' as const, relevant: ['b.md', 'd.md'] };
    const score = scoreQuery(
      entry,
      [
        { path: 'a.md', score: 0.9 },
        { path: 'b.md', score: 0.8 },
        { path: 'c.md', score: 0.7 },
        { path: 'd.md', score: 0.6 },
      ],
      0.81,
    );
    expect(score.top).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(score.top_scores).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(score.relevant_ranks).toEqual([2, 4]);
    expect(score.best_relevant_similarity).toBe(0.81);
    expect(score.first_relevant_rank).toBe(2);
  });
```

`test/eval/pipelines.test.ts` — add:

```ts
  it('bestRelevantSimilarity reaches relevant notes outside the top list', () => {
    const sources = new Map([
      ['far.md', { path: 'far.md', embedding: [0.6, 0.8], blocks: [] }],
      ['near.md', { path: 'near.md', embedding: [1, 0], blocks: [] }],
    ]);
    expect(bestRelevantSimilarity([1, 0], ['far.md', 'gone.md'], sources)).toBeCloseTo(0.6);
    expect(bestRelevantSimilarity([1, 0], ['gone.md'], sources)).toBeNull();
  });
```

`test/eval/report.test.ts` — the file name: `expect(path.basename(file)).toBe('2026-10-13T12-00-00-harrier-270m-semantic.json')` for a report with `model_key: 'harrier-270m'`. Update existing `rankQuery`/`scoreQuery` call sites in tests to the new shapes. Run `npx vitest run test/eval` — Expected: FAIL.

- [ ] **Step 2: Implement**

`eval/metrics.ts`:

```ts
import type { RankedPath } from './pipelines.js';

export interface QueryScore {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  top: string[];
  /** The score each `top` path was ranked by: cosine for `semantic`, the fused RRF score for `fused`. */
  top_scores: number[];
  /** 1-based ranks of every relevant path inside `top`. */
  relevant_ranks: number[];
  /** Best cosine between the query and any relevant note, ranked or not; null when none has a note vector. */
  best_relevant_similarity: number | null;
  first_relevant_rank: number | null;
  precision_at_3: number;
  reciprocal_rank: number;
  hit_at_3: boolean;
}

export function scoreQuery(entry: GoldenEntry, ranked: RankedPath[], bestRelevantSimilarity: number | null): QueryScore {
  const relevant = new Set(entry.relevant);
  const top = ranked.map((r) => r.path);
  const relevant_ranks = top.flatMap((p, i) => (relevant.has(p) ? [i + 1] : []));
  const first_relevant_rank = relevant_ranks[0] ?? null;
  const hitsAt3 = relevant_ranks.filter((r) => r <= 3).length;
  return {
    id: entry.id,
    query: entry.query,
    lang: entry.lang,
    top,
    top_scores: ranked.map((r) => r.score),
    relevant_ranks,
    best_relevant_similarity: bestRelevantSimilarity,
    first_relevant_rank,
    precision_at_3: hitsAt3 / 3,
    reciprocal_rank: first_relevant_rank === null ? 0 : 1 / first_relevant_rank,
    hit_at_3: hitsAt3 > 0,
  };
}
```

`eval/pipelines.ts` — rankers take the query vector (embedded once by `runEval`) and return scores:

```ts
export interface RankedPath {
  path: string;
  score: number;
}

export function bestRelevantSimilarity(
  queryVector: number[],
  relevant: string[],
  sources: Map<string, SmartSource>,
): number | null {
  const candidates = relevant.flatMap((p) => {
    const source = sources.get(p);
    return source ? [source] : [];
  });
  const [best] = findNeighbors({ queryVector, sources: candidates, threshold: -1, limit: 1 });
  return best?.similarity ?? null;
}

function rankSemantic(queryVector: number[], sources: Map<string, SmartSource>): RankedPath[] {
  return findNeighbors({
    queryVector,
    sources: sources.values(),
    threshold: EVAL_CONFIG.semantic_threshold,
    limit: EVAL_TOP_K,
  }).map((r) => ({ path: r.path, score: r.similarity }));
}
```

`rankFused(queryVector, sources, similarity, context)` passes `embeddingProvider: { initialize: () => Promise.resolve(), embedQuery: () => Promise.resolve(queryVector) }` and returns `fuseRanks(...).slice(0, EVAL_TOP_K).map((c) => ({ path: c.path, score: c.score }))`. `rankQuery(args: { pipeline; queryVector; sources; similarity; fusedContext? })` dispatches.

`eval/report.ts` — `EvalReport` gains `model_key: string; identity: EmbeddingIdentity; stats?: CalibrationStats` (import the type from `./stats.js` in Task 9.5; until then declare `stats?: unknown`), and the file name becomes `` `${stamp}-${report.model_key}-${report.pipeline}.json` ``.

`eval/run.ts` — per entry: `const queryVector = await embed(entry.query);`, then `rankQuery({ pipeline, queryVector, sources, similarity: args.model.similarity, fusedContext })` and `scoreQuery(entry, ranked, bestRelevantSimilarity(queryVector, entry.relevant, sources))`; the report sets `model_key: args.model.key`, `identity`, `model_id: identity.model_id`, where `identity = identityOf(args.model)`; drop the `deps.modelId` override (no test uses it). Print `model=<key>` alongside `pipeline=` in `main`.

- [ ] **Step 3: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS, including `test/eval/production-fusion-pin.test.ts` (compare its `rankQuery` result via `.map((r) => r.path)`).

```bash
git add eval test/eval
git commit -m "feat(eval): record the model profile and ranking scores in reports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.4: The fused pipeline's expansion floor follows the profile

**Files:**
- Modify: `eval/pipelines.ts`, `eval/run.ts`
- Test: `test/eval/pipelines.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('evalConfig reports the profile’s expansion floor and zero query thresholds', () => {
    const config = evalConfig({ ...TEST_SIMILARITY, expansionFloor: 0.81 });
    expect(config.expansion_floor).toBe(0.81);
    expect(config.semantic_threshold).toBe(0);
  });
```

Run — Expected: FAIL (`evalConfig` missing).

- [ ] **Step 2: Implement**

Replace the `EVAL_CONFIG` constant with

```ts
/**
 * Every knob in effect, echoed into the report's `config`. Query-side
 * thresholds are 0 — eval counts positions. The expansion floor is the
 * profile's own default, so `fused` stays the production pipeline for that
 * profile (design D12).
 */
export function evalConfig(similarity: SimilarityDefaults) {
  return {
    top_k: EVAL_TOP_K,
    semantic_threshold: 0,
    semantic_pool: 8,
    expansion_limit: 3,
    expansion_floor: similarity.expansionFloor,
    lexical_note_cap: 10,
    lexical_per_note_cap: 3,
    expansion_weight: EXPANSION_WEIGHT,
    k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
  } as const;
}
```

use `evalConfig(similarity)` inside `rankSemantic`/`rankFused` (thread `similarity` to `rankSemantic` too), and `config: { ...evalConfig(args.model.similarity) }` in `runEval`.

- [ ] **Step 3: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add eval test/eval
git commit -m "feat(eval): take the fused expansion floor from the selected profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.5: Calibration statistics

**Files:**
- Create: `eval/stats.ts`, `test/eval/stats.test.ts`
- Modify: `eval/run.ts`, `eval/report.ts`

**Interfaces:**
- Produces: `quantiles(values): Quantiles`; `passRate(values, threshold): number`; `thresholdForPassRate(values, rate): number`; `collectPopulations({ queryVectors, sources, seedPool, expansionLimit, topK }): Populations`; `computeGuards(perQuery, similarity, deepPool): Guards`; `computeCalibrationStats({ populations, similarity, perQuery, deepPool, baseline? }): CalibrationStats`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/stats.test.ts
import { describe, expect, it } from 'vitest';

import type { QueryScore } from '../../eval/metrics.js';
import {
  collectPopulations,
  computeCalibrationStats,
  computeGuards,
  passRate,
  quantiles,
  thresholdForPassRate,
} from '../../eval/stats.js';
import { TEST_SIMILARITY } from '../_identity.js';

describe('quantiles', () => {
  it('summarises a population by nearest lower rank', () => {
    const q = quantiles([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1]);
    expect(q).toMatchObject({ n: 11, min: 0.1, p50: 0.6, max: 1.1 });
  });
});

describe('passRate / thresholdForPassRate', () => {
  const values = [0.2, 0.4, 0.6, 0.8, 1.0];

  it('passRate counts values at or above the threshold', () => {
    expect(passRate(values, 0.6)).toBe(0.6);
  });

  it('thresholdForPassRate inverts passRate', () => {
    expect(thresholdForPassRate(values, 0.6)).toBe(0.6);
    expect(passRate(values, thresholdForPassRate(values, 0.6))).toBe(0.6);
    expect(thresholdForPassRate(values, 1)).toBe(0.2);
  });

  it('a zero pass rate yields a threshold above every value', () => {
    expect(thresholdForPassRate(values, 0)).toBeGreaterThan(1.0);
  });
});

function score(over: Partial<QueryScore>): QueryScore {
  return {
    id: 'q', query: 'q', lang: 'ua', top: [], top_scores: [], relevant_ranks: [],
    best_relevant_similarity: null, first_relevant_rank: null, precision_at_3: 0,
    reciprocal_rank: 0, hit_at_3: false, ...over,
  };
}

describe('computeGuards', () => {
  it('counts first-relevant hits inside the deep pool that the deep default would drop', () => {
    const perQuery = [
      score({ first_relevant_rank: 2, relevant_ranks: [2], top_scores: [0.5, 0.3] }), // 0.3 < deep 0.35 → dropped
      score({ first_relevant_rank: 1, relevant_ranks: [1], top_scores: [0.9] }),
      score({ first_relevant_rank: 9, relevant_ranks: [9], top_scores: Array(9).fill(0.1) }), // outside pool 8
    ];
    expect(computeGuards(perQuery, TEST_SIMILARITY, 8).deep_filtered_first_relevant).toBe(1);
  });

  it('measures the hit@3 drop the quick default causes', () => {
    const perQuery = [
      score({ relevant_ranks: [1], top_scores: [0.45] }), // hit at 0, lost at quick 0.5
      score({ relevant_ranks: [2], top_scores: [0.9, 0.8] }), // kept
    ];
    expect(computeGuards(perQuery, TEST_SIMILARITY, 8).quick_hit_at_3_drop).toBe(1);
  });
});

describe('collectPopulations + computeCalibrationStats', () => {
  const sources = new Map([
    ['a.md', { path: 'a.md', embedding: [1, 0], blocks: [] }],
    ['b.md', { path: 'b.md', embedding: [0.8, 0.6], blocks: [] }],
    ['c.md', { path: 'c.md', embedding: [0, 1], blocks: [] }],
  ]);

  it('collects the four populations', () => {
    const p = collectPopulations({ queryVectors: [[1, 0]], sources, seedPool: 1, expansionLimit: 1, topK: 3 });
    expect(p.query_candidates).toHaveLength(3);
    expect(p.expansion_neighbours).toEqual([expect.closeTo(0.8)]);
    expect(p.note_max).toHaveLength(3);
    expect(p.note_top10).toHaveLength(6);
  });

  it('suggests, per default, the threshold reproducing a baseline pass rate', () => {
    const populations = collectPopulations({ queryVectors: [[1, 0]], sources, seedPool: 1, expansionLimit: 1, topK: 3 });
    const baseline = computeCalibrationStats({ populations, similarity: TEST_SIMILARITY, perQuery: [], deepPool: 8 });
    const again = computeCalibrationStats({ populations, similarity: TEST_SIMILARITY, perQuery: [], deepPool: 8, baseline });
    expect(again.suggested?.deep.threshold).toBeCloseTo(thresholdForPassRate(populations.query_candidates, baseline.pass_rates.deep.pass_rate));
  });
});
```

Run: `npx vitest run test/eval/stats.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// eval/stats.ts
import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';
import type { SimilarityDefaults } from '../src/modules/semantic/model-profiles.js';
import { findNeighbors } from '../src/modules/semantic/search-engine.js';
import type { QueryScore } from './metrics.js';

export interface Quantiles {
  n: number;
  min: number;
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
}

export interface Populations {
  /** Query↔note similarities of each golden query's top-k candidates. */
  query_candidates: number[];
  /** Seed↔neighbour similarities the expansion leg sees (unfloored). */
  expansion_neighbours: number[];
  /** Every note's top-10 neighbour similarities. */
  note_top10: number[];
  /** Every note's maximum similarity to any other note. */
  note_max: number[];
}

export interface Guards {
  /** First-relevant hits inside the deep pool that the deep default would filter out. Target: 0. */
  deep_filtered_first_relevant: number;
  /** Queries that lose their hit@3 when the quick default filters the ranking. Target: ≤ 1. */
  quick_hit_at_3_drop: number;
}

type DefaultKey = keyof SimilarityDefaults;

export interface CalibrationStats {
  populations: Record<keyof Populations, Quantiles>;
  pass_rates: Record<DefaultKey, { population: keyof Populations; threshold: number; pass_rate: number }>;
  guards: Guards;
  suggested?: Record<DefaultKey, { baseline_pass_rate: number; threshold: number }>;
}

/** Which population each default filters (design D11). */
const POPULATION_OF: Record<DefaultKey, keyof Populations> = {
  quick: 'query_candidates',
  deep: 'query_candidates',
  fallback: 'query_candidates',
  expansionFloor: 'expansion_neighbours',
  similarNotes: 'note_top10',
  duplicates: 'note_max',
};

export function quantiles(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.floor(q * (sorted.length - 1))];
  return {
    n: sorted.length,
    min: at(0),
    p05: at(0.05),
    p10: at(0.1),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    max: at(1),
  };
}

export function passRate(values: number[], threshold: number): number {
  if (values.length === 0) return 0;
  return values.filter((v) => v >= threshold).length / values.length;
}

/** The threshold at which `rate` of `values` pass — the inverse of {@link passRate}. */
export function thresholdForPassRate(values: number[], rate: number): number {
  if (values.length === 0) throw new Error('cannot calibrate against an empty population');
  const descending = [...values].sort((a, b) => b - a);
  const count = Math.round(rate * descending.length);
  if (count <= 0) return descending[0] + 1e-6;
  return descending[Math.min(count, descending.length) - 1];
}

export function collectPopulations(args: {
  queryVectors: number[][];
  sources: Map<string, SmartSource>;
  seedPool: number;
  expansionLimit: number;
  topK: number;
}): Populations {
  const { sources } = args;
  const query_candidates: number[] = [];
  const expansion_neighbours: number[] = [];
  for (const queryVector of args.queryVectors) {
    const ranked = findNeighbors({ queryVector, sources: sources.values(), threshold: -1, limit: args.topK });
    query_candidates.push(...ranked.map((r) => r.similarity));
    const seeds = ranked.slice(0, args.seedPool);
    const seedSet = new Set(seeds.map((s) => s.path));
    for (const seed of seeds) {
      const source = sources.get(seed.path);
      if (!source) continue;
      // Mirrors the production expansion leg, minus its floor.
      const neighbours = findNeighbors({
        queryVector: source.embedding,
        sources: sources.values(),
        threshold: -1,
        limit: args.expansionLimit + seedSet.size,
      })
        .filter((n) => !seedSet.has(n.path))
        .slice(0, args.expansionLimit);
      expansion_neighbours.push(...neighbours.map((n) => n.similarity));
    }
  }
  const note_top10: number[] = [];
  const note_max: number[] = [];
  for (const source of sources.values()) {
    const neighbours = findNeighbors({
      queryVector: source.embedding,
      sources: sources.values(),
      threshold: -1,
      limit: 10,
      excludePath: source.path,
    });
    note_top10.push(...neighbours.map((n) => n.similarity));
    if (neighbours[0]) note_max.push(neighbours[0].similarity);
  }
  return { query_candidates, expansion_neighbours, note_top10, note_max };
}

export function computeGuards(perQuery: QueryScore[], similarity: SimilarityDefaults, deepPool: number): Guards {
  let deepFiltered = 0;
  let hitsAtZero = 0;
  let hitsAtQuick = 0;
  for (const q of perQuery) {
    const first = q.first_relevant_rank;
    if (first !== null && first <= deepPool && q.top_scores[first - 1] < similarity.deep) deepFiltered += 1;
    const top3 = q.relevant_ranks.filter((r) => r <= 3);
    if (top3.length > 0) hitsAtZero += 1;
    if (top3.some((r) => q.top_scores[r - 1] >= similarity.quick)) hitsAtQuick += 1;
  }
  return { deep_filtered_first_relevant: deepFiltered, quick_hit_at_3_drop: hitsAtZero - hitsAtQuick };
}

export function computeCalibrationStats(args: {
  populations: Populations;
  similarity: SimilarityDefaults;
  perQuery: QueryScore[];
  deepPool: number;
  baseline?: CalibrationStats;
}): CalibrationStats {
  const keys = Object.keys(POPULATION_OF) as DefaultKey[];
  const pass_rates = Object.fromEntries(
    keys.map((key) => {
      const population = POPULATION_OF[key];
      const threshold = args.similarity[key];
      return [key, { population, threshold, pass_rate: passRate(args.populations[population], threshold) }];
    }),
  ) as CalibrationStats['pass_rates'];
  const stats: CalibrationStats = {
    populations: {
      query_candidates: quantiles(args.populations.query_candidates),
      expansion_neighbours: quantiles(args.populations.expansion_neighbours),
      note_top10: quantiles(args.populations.note_top10),
      note_max: quantiles(args.populations.note_max),
    },
    pass_rates,
    guards: computeGuards(args.perQuery, args.similarity, args.deepPool),
  };
  const { baseline } = args;
  if (baseline) {
    stats.suggested = Object.fromEntries(
      keys.map((key) => {
        const rate = baseline.pass_rates[key].pass_rate;
        return [key, { baseline_pass_rate: rate, threshold: thresholdForPassRate(args.populations[POPULATION_OF[key]], rate) }];
      }),
    ) as CalibrationStats['suggested'];
  }
  return stats;
}
```

- [ ] **Step 3: Wire it into the runner**

In `runEval`, collect `queryVectors` as queries are embedded; after scoring, when `args.stats`:

```ts
  let stats: CalibrationStats | undefined;
  if (args.stats) {
    const baseline = args.baseline === undefined ? undefined : await readBaseline(args.baseline);
    const populations = collectPopulations({ queryVectors, sources, seedPool: 8, expansionLimit: 3, topK: EVAL_TOP_K });
    stats = computeCalibrationStats({ populations, similarity: args.model.similarity, perQuery: per_query, deepPool: 8, baseline });
  }
```

with

```ts
async function readBaseline(file: string): Promise<CalibrationStats> {
  const report = JSON.parse(await readFile(file, 'utf8')) as { stats?: CalibrationStats };
  if (report.stats?.pass_rates === undefined) {
    throw new UsageError(`--baseline ${file} is not a --stats report`);
  }
  return report.stats;
}
```

and `...(stats ? { stats } : {})` in the report; `EvalReport.stats?: CalibrationStats`. In `main`, when `report.stats` exists, print one line per default: `deep: threshold=0.350 pass=0.913` and, if suggested, `→ suggested 0.412`, plus the two guard values. Add a `runEval` end-to-end test with `stats: true` asserting `report.stats.pass_rates.deep.threshold === TEST_SIMILARITY.deep` and that a report without `--stats` has no `stats` key.

- [ ] **Step 4: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add eval test/eval
git commit -m "feat(eval): calibration statistics, guards and baseline-matched thresholds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.6: `eval/README.md`

- [ ] **Step 1:** Update usage (`--model`, `--stats`, `--baseline`), add "Axis: model" (one profile per run; the corpus must have been built with it — the manifest gate and the exact `index --model` command it names; reproducing the bake-off = for each profile `neuro-vault-mcp index --vault <copy> --model <key>` then `npm run eval -- --vault <copy> --model <key>`, destructive to that vault's corpus by design, so use a copy), rewrite the expansion-floor paragraph (the floor is now the selected profile's default, recorded in `config.expansion_floor`; `--pipeline semantic` remains the clean cross-model read), document the new `per_query` fields and the file name, and add "Calibration" (what `--stats` measures, the four populations, the guards and their targets, `--baseline`, and the procedure of design D11).
- [ ] **Step 2: Commit**

```bash
git add eval/README.md
git commit -m "docs(eval): document the model axis and calibration statistics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10.1: Verify PR 3, capture the calibration baseline, open it

- [ ] **Step 1: Gates** — `npm test && npm run lint && npm run typecheck && npm run build` — all PASS.

- [ ] **Step 2: The gate refuses a mismatched corpus**

Each command below is one simple command (worktree guard); multi-step work goes through a driver in the scratchpad.

```bash
rsync -a --delete /Users/amostovenko/Obsidian/ <scratchpad>/vault-copy/Obsidian/
npx tsx ./eval/run.ts --vault <scratchpad>/vault-copy/Obsidian --model granite-97m
```

First confirm the copy's `.neuro-vault/corpus/manifest.json` is the live bge-micro manifest (`model_key: bge-micro-v2`, `embed_version: 1`). Expected: non-zero exit; the message names `bge-micro-v2 (embed_version 1)` and `neuro-vault-mcp index --vault <copy> --model granite-97m`.

- [ ] **Step 3: Capture the bge-micro baseline** (unrecoverable once PR 4 removes the profile)

```bash
npx tsx ./eval/run.ts --vault <scratchpad>/vault-copy/Obsidian --model bge-micro-v2 --pipeline semantic --stats
```

Expected: overall MRR 0.398 ± 0.005 (same as PR 1). The report lands in the worktree's gitignored `eval/results/<stamp>-bge-micro-v2-semantic.json`. A scratchpad driver (`extract-aggregates.mjs <report> <out>`) copies the full report to `<scratchpad>/baseline-bge-micro-v2.json` and writes `{ code_sha, vault_sha, model_key, identity, config, metrics, stats }` — aggregates only, no `per_query`, no paths — to `<scratchpad>/baseline-aggregates.json`. Create `openspec/changes/embedding-model-profiles/calibration.md` with a "Baseline — bge-micro-v2" section holding those aggregates in a fenced block plus a short reading of them. PR 4 passes the full report to `--baseline`, and neither the scratchpad nor the worktree outlives the work, so park it in the **main checkout's** gitignored results directory by absolute path (no `cd`; it holds private paths, so it never enters git): `<main checkout>/eval/results/baseline-bge-micro-v2.json`.

- [ ] **Step 4: Open PR 3**

Commit `calibration.md`; `gh pr create --base main --title "feat: embedding model profiles — eval model axis, thresholds as profile data (3/4)"`. Body: what landed (Tasks 8.1–9.6); that the thresholds moved into the profile with every value unchanged (bge behaviour identical); how `--model` and the manifest gate work, with the gate demo; the baseline aggregates; that the harrier profiles still carry the bge-scale values until PR 4 calibrates them; `Refs #98`, footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Bind with the ccd_pr tools.

- [ ] **Step 5: STOP** — wait for review and merge before Task 11.1.

---

# PR 4 — default switch, manifest v2, calibration, ADR, docs (`Closes #98`)

Fresh worktree off `origin/main` (PR 3 merged), branch `feat/embedding-model-profiles-pr4`. Re-read Tasks 11.1–14.4 against `main` first. Confirm `/Users/amostovenko/git/neuro-vault/eval/results/baseline-bge-micro-v2.json` exists and that `calibration.md` holds the baseline aggregates — without them Task 12.1 cannot run (the profile that produced them is removed in Task 11.3).

**Reconciled against `main` @ `2ffd2ee` (PR 3 as merged, with #142 and the PR 3 review fixes of 6d38e06).** The tasks below already carry these fixes:

- **(a) Thresholds already live in `ModelProfile.similarity`**, every profile on the shared `BGE_SCALE_SIMILARITY`. `test/semantic/model-profiles.test.ts` has a test, "pins every profile's similarity defaults", that fixes those bge values on every profile. Task 12.1 Step 3 **replaces** that test with the pin of the calibrated values; it does not add a second pin beside it. The `quick ≥ deep > fallback` ordering test stays as it is.
- **(b) #142: field descriptions reach the MCP client.** `test/semantic/tools/search-notes-description.test.ts` checks the post-gate schema and builds the tool from `TEST_SIMILARITY`, so calibrated profile values never reach it. No PR 4 snippet changes. No `src/` file outside `model-profiles.ts` holds a threshold literal (grep for `0.35`, `0.9`, `0.3`, `0.5` in `src/` is empty).
- **(c) The eval harness as merged.** `loadSnapshot(vaultRoot, expected)` in `eval/backends.ts` is the only manifest gate. `--stats` and `--baseline` exist. A `--stats --baseline` report records `stats.baseline` (`file`, `model_key`, `vault_sha`, `code_sha`). A default whose population is empty gets `suggested.<key>.threshold: null`, and Task 12.1 treats null as "stop, nothing to match", never as 0. Task 12.1 has no rsync step: the bge baseline is re-captured in Task 11.0 on the **same** vault copy the profiles are calibrated on, so `vault_sha` matches and no comparability warning fires. Re-syncing between the baseline and the profile runs would break that pairing. Every harness command is `npx tsx ./eval/run.ts …`.
- **(d) A baseline from a removed profile must stay readable.** `readBaseline` (`eval/run.ts`) checks only `typeof report.model_key === 'string'`; it never resolves the key against the registry. A `bge-micro-v2` baseline therefore still reads after Task 11.3. Task 11.3 pins this with a test.
- **(e) What Task 11.3's switch breaks, found by grep on `main`:**
  - `test/semantic/embedding-service.test.ts` resolves `bge-micro-v2` for its mean-pooling cases. No remaining profile pools by mean, so those cases build a local fixture profile (`{ ...resolveModelProfile('granite-97m'), key: 'mean-fixture', pooling: 'mean' }`) instead.
  - `test/eval/run.test.ts` has an unknown-model regex `/bge-micro-v2.*granite-97m/s`.
  - The `bge-micro-v2` row in `test/integration/profile-tokenizers.test.ts`.
  - `test/config.test.ts`'s duplicate-flag value.
  - The expected rebuild and announcement lines in `test/cli-index.test.ts` and `test/semantic/backend/corpus-backend.test.ts`. After 11.1 they read `active model is bge-micro-v2 (embed_version 2)`; the cli-index test resolves `DEFAULT_MODEL_KEY`, so after 11.3 its line reads `harrier-270m (embed_version 2)`.
  - `eval/README.md`'s "currently `bge-micro-v2`".

  `TEST_IDENTITY` and the tool fixtures' `modelKey: 'bge-micro-v2'` stay. They are fixture identities and never resolve against the registry.
- **(f) Task 11.2 changes what the `bucketByLength` comment claims** (`src/modules/semantic/embed-queue.ts`) and what design D6 says ("while `EMBED_CHAR_BUDGET` caps it"). Both get rewritten in 11.2's commit (see that task).
- **(g) Calibration populations.** On bge, five of the six defaults pass 100 % of the top-10 populations, so literal D11 degenerates. The decision is to measure pass rates on **unranked** populations, recorded in design D11 by its own `docs(openspec)` commit. The new Task 11.0 implements those populations and re-captures the bge baseline on them **before** Task 11.3 removes the profile. Task 12.1 reads them.
- **Environment** (as in PR 3): the worktree guard blocks the bare word `eval` and any compound command (pipe, subshell, `;`) on a path containing the scratchpad. Real-data steps therefore run one simple command each, or a `.mjs`/`.mts` driver in the scratchpad (top-level `await` only in `.mts`). The vault copy lives in the scratchpad: `<scratchpad>/vault-bge/Obsidian`, with per-profile copies cloned from it so every copy shares one `vault_sha`.

### Task 11.0: Unranked calibration populations; re-capture the bge baseline

Design D11 as decided for PR 4. Runs **before** Task 11.3: its last step needs `bge-micro-v2` in the registry.

**Files:**
- Modify: `eval/stats.ts`, `eval/run.ts` (`readBaseline`, `formatStats`), `eval/README.md` (Calibration), `openspec/changes/embedding-model-profiles/calibration.md`
- Test: `test/eval/stats.test.ts`, `test/eval/run.test.ts`

**Interfaces:**
- `Populations` gains `query_all` (each query vector against every source), `seed_all` (each seed against every source that is not one of that query's seeds) and `note_all` (each source against every other source, ordered pairs). The four ranked/max populations stay.
- `POPULATION_OF` (now exported): `quick`, `deep`, `fallback` → `query_all`; `expansionFloor` → `seed_all`; `similarNotes` → `note_all`; `duplicates` → `note_max`.
- `CalibrationStats.populations` holds quantiles for all seven keys, built by iterating the `Populations` keys so a new one cannot be missed.
- `readBaseline` refuses a baseline whose `pass_rates.<key>.population` differs from `POPULATION_OF[key]`. The PR 3 baseline was measured on the ranked populations, and its pass rates mean something else. The message names the file, the key and both populations, and says to re-capture with `--stats`.

- [ ] **Step 1: Write the failing tests**

`test/eval/stats.test.ts`: the population test uses `topK: 2` over the three-note fixture, so ranked and unranked differ. It asserts `query_candidates` has 2 values and `query_all` has 3. With seed `a.md` (one seed), `seed_all` is `[0.8, 0]` in either order: `b` and `c`, never the seed itself. `note_all` has 6 values (3 × 2) and `note_top10` still has 6. `pass_rates.deep.population` is `'query_all'`, `expansionFloor`'s is `seed_all`, `similarNotes`'s is `note_all`, `duplicates`'s is `note_max`. Add a test that `POPULATION_OF` covers exactly `DEFAULT_KEYS`, and update the existing assertions that name `query_candidates` / `expansion_neighbours` as a default's population.

`test/eval/run.test.ts`, next to the other `--baseline` refusals:

```ts
  it('refuses a --baseline that measured a default on another population, before embedding anything', async () => {
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const ranked = structuredClone(first.report);
    ranked.stats!.pass_rates.deep.population = 'query_candidates';
    const rankedFile = path.join(resultsDir, 'ranked-baseline.json');
    await writeFile(rankedFile, JSON.stringify(ranked));
    const embedSpy = vi.fn(embed);
    const run = runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true, baseline: rankedFile },
      { embed: embedSpy, resultsDir },
    );
    await expect(run).rejects.toThrow(/ranked-baseline\.json.*deep.*query_candidates.*query_all/s);
    expect(embedSpy).not.toHaveBeenCalled();
  });
```

(Use the file's existing harness names.) Run: `npx vitest run test/ev[a]l` — Expected: FAIL.

- [ ] **Step 2: Implement**

`collectPopulations` ranks once per vector and slices, so the unranked populations cost no extra pass:

```ts
  for (const queryVector of args.queryVectors) {
    const all = findNeighbors({ queryVector, sources: sources.values(), threshold: -1 });
    query_all.push(...all.map((r) => r.similarity));
    const ranked = all.slice(0, args.topK);
    query_candidates.push(...ranked.map((r) => r.similarity));
    const seeds = ranked.slice(0, args.seedPool);
    const seedSet = new Set(seeds.map((s) => s.path));
    for (const seed of seeds) {
      const source = sources.get(seed.path);
      if (!source) continue;
      const others = findNeighbors({
        queryVector: source.embedding,
        sources: sources.values(),
        threshold: -1,
      }).filter((n) => !seedSet.has(n.path));
      seed_all.push(...others.map((n) => n.similarity));
      // Mirrors the production expansion leg, minus its floor.
      expansion_neighbours.push(...others.slice(0, args.expansionLimit).map((n) => n.similarity));
    }
  }
  for (const source of sources.values()) {
    const others = findNeighbors({
      queryVector: source.embedding,
      sources: sources.values(),
      threshold: -1,
      excludePath: source.path,
    });
    note_all.push(...others.map((n) => n.similarity));
    note_top10.push(...others.slice(0, 10).map((n) => n.similarity));
    const [nearest] = others;
    if (nearest) note_max.push(nearest.similarity);
  }
```

Doc comments on the three new `Populations` fields say what they hold and that they are unranked, and why: on bge-micro the ranked populations pass 100 % at five defaults (design D11). In `readBaseline`, after the pass-rate validation:

```ts
    const population = (stats.pass_rates as Record<string, { population?: unknown }>)[key].population;
    if (population !== POPULATION_OF[key]) {
      throw new UsageError(
        `--baseline ${file}: ${key} was measured on ${JSON.stringify(population) ?? 'nothing'}, this build measures it on "${POPULATION_OF[key]}" — re-capture the baseline with --stats`,
      );
    }
```

`formatStats` prints each default's population (`deep: population=query_all threshold=… pass=…`). In `eval/README.md` § Calibration, the populations table gets seven rows: three ranked, three unranked, and `note_max`. Then add a short paragraph on why the defaults are matched on the unranked ones, linking design D11. In § Baseline, add a sentence on the new population refusal.

- [ ] **Step 3: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add ./ev[a]l test/ev[a]l
git commit -m "feat(eval): match similarity defaults on unranked populations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Re-capture the bge baseline** (bge-micro-v2 must still be in the registry)

On `<scratchpad>/vault-bge/Obsidian`, a fresh rsync of the live vault (one simple command each):

1. Confirm the copy's `.neuro-vault/corpus/manifest.json` is `bge-micro-v2`, `embed_version 1`.
2. `npm run build`, then `node dist/cli.js index --vault <copy> --model bge-micro-v2`. This brings the corpus up to the copy's notes. Expected: no `rebuilding` line, `failed=0`.
3. `npx tsx ./eval/run.ts --vault <copy> --model bge-micro-v2 --pipeline semantic --stats`.
4. **Decision rule (design D11):** each of `quick`, `deep`, `fallback`, `expansionFloor` and `similarNotes` must pass **< 1.0** of its unranked population. If any passes 1.0, stop and ask the owner. Do not proceed to Task 11.3.
5. Copy the full report to the main checkout's gitignored `eval/results/baseline-bge-micro-v2-unranked.json` (absolute path, no `cd`). PR 3's `baseline-bge-micro-v2.json` stays as it is.
6. `calibration.md`: replace the "open question" section with a short "Resolved" note pointing at design D11. Add "Baseline — bge-micro-v2, unranked populations" with metrics, the seven populations' quantiles, the pass rates and the guards, plus the raw aggregates block (`{ code_sha, vault_sha, model_key, identity, config, metrics, stats }`, with `stats.baseline` absent and no `per_query`). Keep PR 3's section as history and mark it superseded for calibration.

```bash
git add openspec/changes/embedding-model-profiles/calibration.md
git commit -m "docs(openspec): re-capture the bge-micro baseline on unranked populations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11.1: Manifest v2 records the producing identity

**Files:**
- Modify: `src/lib/obsidian/corpus/types.ts`, `src/lib/obsidian/corpus/identity.ts`, `src/lib/obsidian/corpus/shard-store.ts`, `src/lib/obsidian/corpus/reconcile.ts` (types only)
- Test: `test/lib/obsidian/corpus/identity.test.ts`, `test/lib/obsidian/corpus/shard-store.test.ts`, `test/lib/obsidian/corpus/reconcile.test.ts`, plus fixtures the typecheck flags (`test/semantic/backend/corpus-backend.test.ts`, `test/eval/*.test.ts`)

**Interfaces:**
- Produces: `CorpusManifest` = `{ embed_version; provider; model_key; model_id; revision; dtype; dims; pooling; max_tokens; strategy; created }`; `type ProducerField = 'provider' | 'revision' | 'dtype' | 'pooling' | 'max_tokens'`; `type StoredManifest = Omit<CorpusManifest, ProducerField> & Partial<Pick<CorpusManifest, ProducerField>>`; `EMBED_VERSION = 2`; `EMBED_STRATEGY = 'token-window-v1'` (replaces `SC_PARITY_STRATEGY`); `readManifest(): Promise<StoredManifest | null>`; `isManifestCompatible(stored: StoredManifest | null, expected: CorpusIdentity, hasShards)`; `onRebuild`'s `stored: StoredManifest | null`.

- [ ] **Step 1: Write the failing tests**

`test/lib/obsidian/corpus/identity.test.ts` — replace the `corpusIdentityOf` expectation:

```ts
    ).toEqual({
      embed_version: 2,
      provider: 'transformers.js',
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
      dtype: 'q8',
      dims: 384,
      pooling: 'mean',
      max_tokens: 512,
      strategy: 'token-window-v1',
    });
```

`test/lib/obsidian/corpus/shard-store.test.ts`:

```ts
describe('manifest identity v2', () => {
  it.each(['embed_version', 'provider', 'model_key', 'model_id', 'revision', 'dtype', 'dims', 'pooling', 'max_tokens', 'strategy'] as const)(
    'a stored %s that differs is incompatible',
    (field) => {
      const stored = { ...TEST_IDENTITY, created: 'x', [field]: typeof TEST_IDENTITY[field] === 'number' ? 1234 : 'different' };
      expect(isManifestCompatible(stored, TEST_IDENTITY, true)).toBe(false);
    },
  );

  it('a matching manifest is compatible regardless of created', () => {
    expect(isManifestCompatible({ ...TEST_IDENTITY, created: 'any' }, TEST_IDENTITY, true)).toBe(true);
  });

  it('reads a legacy embed_version 1 manifest instead of rejecting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-legacy-'));
    await mkdir(path.join(root, '.neuro-vault/corpus'), { recursive: true });
    await writeFile(
      path.join(root, '.neuro-vault/corpus/manifest.json'),
      JSON.stringify({ embed_version: 1, model_key: 'bge-micro-v2', model_id: 'TaylorAI/bge-micro-v2', dims: 384, strategy: 'sc-parity-v1', created: '2026-08-25T00:00:00.000Z' }),
    );
    const manifest = await new CorpusStore(root, { dims: TEST_DIMS }).readManifest();
    expect(manifest).toMatchObject({ model_key: 'bge-micro-v2', embed_version: 1 });
    expect(isManifestCompatible(manifest, TEST_IDENTITY, true)).toBe(false);
  });
});
```

`test/lib/obsidian/corpus/reconcile.test.ts`:

```ts
  it('names a legacy bge-micro-v2 corpus when it rebuilds it', async () => {
    const { run, root } = await harness({ 'A.md': body('A') });
    await run();
    await writeFile(
      path.join(root, '.neuro-vault/corpus/manifest.json'),
      JSON.stringify({ embed_version: 1, model_key: 'bge-micro-v2', model_id: 'TaylorAI/bge-micro-v2', dims: 384, strategy: 'sc-parity-v1', created: 'x' }),
    );
    const rebuilds: string[] = [];
    const summary = await run({ onRebuild: ({ stored }) => rebuilds.push(formatIdentity(stored)) });
    expect(rebuilds).toEqual(['bge-micro-v2 (embed_version 1)']);
    expect(summary.embedded).toBe(1);
  });
```

Run: `npx vitest run test/lib/obsidian/corpus` — Expected: FAIL.

- [ ] **Step 2: Implement**

`types.ts`:

```ts
export interface CorpusManifest {
  embed_version: number;
  /** Everything below up to `max_tokens` is what produced the vectors (design D8). */
  provider: string;
  model_key: string;
  /** The repo id the vectors were produced from. */
  model_id: string;
  revision: string;
  dtype: string;
  dims: number;
  pooling: string;
  max_tokens: number;
  strategy: string;
  created: string;
}

/** Producer fields a manifest written before embed_version 2 lacks. */
export type ProducerField = 'provider' | 'revision' | 'dtype' | 'pooling' | 'max_tokens';

/**
 * A manifest as read from disk: one this build wrote, or a legacy one without
 * the producer fields — still readable so a rebuild can name what it replaces.
 */
export type StoredManifest = Omit<CorpusManifest, ProducerField> & Partial<Pick<CorpusManifest, ProducerField>>;

export const EMBED_STRATEGY = 'token-window-v1';
export const EMBED_VERSION = 2;
```

(delete `SC_PARITY_STRATEGY`; the note formula changes in Task 11.2, in the same PR, so the bump covers both.)

`identity.ts` — `corpusIdentityOf` maps every field:

```ts
export function corpusIdentityOf(embedding: EmbeddingIdentity): CorpusIdentity {
  return {
    embed_version: EMBED_VERSION,
    provider: embedding.provider,
    model_key: embedding.model_key,
    model_id: embedding.model_id,
    revision: embedding.revision,
    dtype: embedding.dtype,
    dims: embedding.dims,
    pooling: embedding.pooling,
    max_tokens: embedding.max_tokens,
    strategy: EMBED_STRATEGY,
  };
}
```

and update its doc comment (no longer "the five fields existing manifests carry").

`shard-store.ts`:

```ts
const IDENTITY_FIELDS = [
  'embed_version', 'provider', 'model_key', 'model_id', 'revision',
  'dtype', 'dims', 'pooling', 'max_tokens', 'strategy',
] as const satisfies ReadonlyArray<keyof CorpusIdentity>;

export function isManifestCompatible(
  stored: StoredManifest | null,
  expected: CorpusIdentity,
  hasShards: boolean,
): boolean {
  if (stored === null) return !hasShards;
  return IDENTITY_FIELDS.every((field) => stored[field] === expected[field]);
}

function isValidManifest(value: unknown): value is StoredManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optional = (key: string, type: 'string' | 'number') => v[key] === undefined || typeof v[key] === type;
  return (
    typeof v.embed_version === 'number' &&
    typeof v.model_key === 'string' &&
    typeof v.model_id === 'string' &&
    typeof v.dims === 'number' &&
    typeof v.strategy === 'string' &&
    typeof v.created === 'string' &&
    optional('provider', 'string') &&
    optional('revision', 'string') &&
    optional('dtype', 'string') &&
    optional('pooling', 'string') &&
    optional('max_tokens', 'number')
  );
}
```

`readManifest()` and `ensureManifest()`'s `previous` become `StoredManifest | null`; `ReconcileOptions.onRebuild`'s `stored` likewise.

- [ ] **Step 3: Fix fixtures, run everything**

Run `npm run typecheck`; every manifest literal the tests build becomes `{ ...TEST_IDENTITY, <changed field>, created: … }`; the corpus-backend `fakeStore` incompatible manifest becomes `{ ...TEST_IDENTITY, model_key: 'other', embed_version: 99, created: 'now' }` (the expected strings in Task 2.3's announcement test and Task 2.4's index rebuild-line test change to `active model is bge-micro-v2 (embed_version 2)`). Then `npm test && npm run lint` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A src test
git commit -m "feat(corpus): record the full producing identity in manifest v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11.2: Remove the character budget

**Files:**
- Modify: `src/lib/obsidian/corpus/embed-text.ts`, `src/lib/obsidian/corpus/types.ts`
- Test: `test/lib/obsidian/corpus/embed-text.test.ts`, `test/lib/obsidian/corpus/types.test.ts`

- [ ] **Step 1: Write the failing test** (replace the `EMBED_CHAR_BUDGET` truncation test in `embed-text.test.ts`)

```ts
  it('does not cut a long note by characters — the tokenizer bounds it', () => {
    const content = `# Title\n${'слово '.repeat(1000)}`;
    const { note } = buildEmbedInputs('Folder/Long.md', content);
    expect(note).toBe(`Folder > Long:\n${content}`);
    expect(note!.length).toBeGreaterThan(5000);
  });
```

Delete the `EMBED_CHAR_BUDGET` assertion from `types.test.ts` and update its strategy/version pins to `EMBED_STRATEGY === 'token-window-v1'`, `EMBED_VERSION === 2`. Run — Expected: FAIL.

- [ ] **Step 2: Implement**

`embed-text.ts`:

```ts
import { MIN_CHARS, type ChunkedBlock, type NoteEmbedInputs } from './types.js';
// ...
  // No character budget: how much reaches the model is decided in tokens by
  // the active profile's tokenizer (design D9), never by an assumed ratio.
  const note = content.length >= MIN_CHARS ? `${pathBreadcrumbs(notePath)}:\n${content}` : null;
```

`types.ts`: delete `EMBED_CHAR_BUDGET` and its comment.

`src/modules/semantic/embed-queue.ts`: `bucketByLength`'s doc comment justifies sorting with "`EMBED_CHAR_BUDGET` caps it and not them, so a long block can outrun it". That is no longer true. Now the note text holds every block uncut, so it is usually the longest input. It is not always the longest: a block's embed text carries its heading breadcrumbs, which can make it outrun a note that is little more than that block. Blocks also differ widely in length among themselves. Rewrite the comment to say that, and nothing about a budget:

```ts
/**
 * Groups text indices shortest-first into buckets of at most `maxBatchSize`
 * whose longest text is at most twice the shortest (design D6), so no input is
 * padded to one far longer. A note's inputs differ widely in length — its
 * blocks among themselves, and the note text (which holds them all) from each
 * of them — and which one is longest is not fixed: a block's heading
 * breadcrumbs can make it outrun a note that is little more than that block.
 * So the buckets come from measured lengths, not from input order.
 */
```

In the same commit, rewrite design D6's "Why bucketing" bullet to the same effect. Drop the `EMBED_CHAR_BUDGET` clause and the 349-of-888 figure, which measured the capped text.

- [ ] **Step 3: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "EMBED_CHAR_BUDGET\|1894" src eval test` — Expected: PASS, grep empty.

```bash
git add src/lib/obsidian/corpus src/modules/semantic/embed-queue.ts test/lib/obsidian/corpus openspec/changes/embedding-model-profiles/design.md
git commit -m "feat(corpus): bound note text by tokens, not a character budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11.3: `harrier-270m` becomes the default; `bge-micro-v2` leaves the registry

**Files:**
- Modify: `src/modules/semantic/model-profiles.ts`, `test/integration/profile-tokenizers.test.ts`
- Test: `test/semantic/model-profiles.test.ts`, `test/config.test.ts`, and whatever else the switch breaks

- [ ] **Step 1: Write the failing tests**

`test/semantic/model-profiles.test.ts`:

```ts
  it('holds exactly the verified profiles, harrier-270m by default', () => {
    expect([...MODEL_KEYS].sort()).toEqual(['granite-97m', 'harrier-0.6b', 'harrier-270m']);
    expect(DEFAULT_MODEL_KEY).toBe('harrier-270m');
  });
```

(replace the old key-set test; the unknown-key message becomes `choose one of: harrier-270m, granite-97m, harrier-0.6b`; replace the bge `identityOf` test with the same assertion for `harrier-270m` — `model_id: 'onnx-community/harrier-oss-v1-270m-ONNX'`, revision `d59c919d0159aea2c19ed7d04288fcdd048d0f9c`, `dims: 640`, `pooling: 'last_token'`.) In `test/config.test.ts` add:

```ts
    it('rejects the retired bge-micro-v2 profile, listing the current keys', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'bge-micro-v2'])).rejects.toThrow(
          /Choices:.*"harrier-270m".*"granite-97m".*"harrier-0.6b"/s,
        );
      } finally {
        errorLog.mockRestore();
      }
    });
```

and change the duplicate-flag test's second value to `harrier-0.6b`. In `test/eval/run.test.ts`, the unknown-model regex becomes `/harrier-270m.*granite-97m.*harrier-0\.6b/s`, and this test pins reconciliation note (d), next to the other `--baseline` tests:

```ts
  it('reads a baseline whose profile has left the registry', async () => {
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const retired = path.join(resultsDir, 'retired-baseline.json');
    await writeFile(retired, JSON.stringify({ ...first.report, model_key: 'bge-micro-v2' }));
    const { report } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true, baseline: retired },
      { embed, resultsDir },
    );
    expect(report.stats?.baseline?.model_key).toBe('bge-micro-v2');
    expect(report.stats?.suggested).toBeDefined();
  });
```

(Use the file's existing harness names for the vault, embedder and results directory.) Run — Expected: FAIL. This new test passes already, and is a regression pin.

- [ ] **Step 2: Implement**

In `model-profiles.ts`: delete `BGE_MICRO_V2`; order the registry `HARRIER_270M`, `GRANITE_97M`, `HARRIER_0_6B`; `export const DEFAULT_MODEL_KEY = HARRIER_270M.key;`. Remove the `bge-micro-v2` row from `EXPECTED` in `test/integration/profile-tokenizers.test.ts`.

- [ ] **Step 3: Fix what the switch breaks**

Run `npm test`. Tests that resolve `DEFAULT_MODEL_KEY` only to get *a* profile keep working. Tests that depend on 384-dim fixtures and the default profile switch to `resolveModelProfile('granite-97m')` explicitly. Then fix the known breakages from reconciliation note (e): the embedding-service mean-pooling cases move to a local `mean-fixture` profile; the cli-index rebuild line and the corpus-backend announcement name `harrier-270m (embed_version 2)` wherever they resolve the default; `eval/README.md` names `harrier-270m` as the current default. `TEST_IDENTITY` keeps its `bge-micro-v2` key on purpose: it is a fixture identity and never resolves against the registry.

- [ ] **Step 4: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint && grep -rn "bge-micro-v2" src` — Expected: PASS; grep prints nothing in `src/`.

```bash
git add -A src test eval/README.md
git commit -m "feat(semantic)!: default to the harrier-270m embedding profile

BREAKING CHANGE: the default embedding model is now harrier-oss-v1-270m
(int8, ~344 MB, ~2 GB peak RSS) and bge-micro-v2 is no longer a profile.
Every vault's corpus is discarded and rebuilt once on upgrade (manifest v2).

Refs #98

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12.1: Calibrate every profile's similarity defaults

Data-producing task: the numbers it writes come from the runs below. Aggregates only go into the repo.

**Files:**
- Modify: `src/modules/semantic/model-profiles.ts` (each profile's `similarity`), `openspec/changes/embedding-model-profiles/calibration.md`
- Test: `test/semantic/model-profiles.test.ts`

- [ ] **Step 1: Build and set up**

`npm run build`. `BASELINE` is the baseline Task 11.0 re-captured, on the same vault copy. Do **not** re-sync the copy: the profile runs must share the baseline's `vault_sha`. Each profile `KEY` gets its own clone of the bge copy, `<scratchpad>/vault-$KEY/Obsidian` (`rsync -a --exclude .neuro-vault/corpus <scratchpad>/vault-bge/Obsidian/ <scratchpad>/vault-$KEY/Obsidian/`), so the corpora sit side by side and a guard re-run never needs a re-index.

- [ ] **Step 2: Per profile — index, measure, choose, verify** (once per `KEY` in `harrier-270m`, `granite-97m`, `harrier-0.6b`; each line is one simple command, per the environment note)

```bash
/usr/bin/time -l node dist/cli.js index --vault <scratchpad>/vault-$KEY/Obsidian --model $KEY
npx tsx ./eval/run.ts --vault <scratchpad>/vault-$KEY/Obsidian --model $KEY --pipeline semantic --stats --baseline $BASELINE
```

The index run is cold: the clone has no corpus. Its last stdout line ends `failed=0`; `/usr/bin/time` gives wall time and max RSS on stderr. From the report the eval prints, take `stats.suggested.<default>.threshold` for `quick`, `deep`, `similarNotes` and `duplicates`. A `null` means an empty population: stop and investigate, never read it as 0. Choose each value by rounding **down** to two decimals (a floor rounded down never filters more than the baseline did). `fallback` and `expansionFloor` follow the owner's ruling in design D11 ("Outcome of the rule"): on bge they passed 1.0 of their unranked population. Set each just below the minimum of its own unranked population on this profile (`stats.populations.query_all.min`, `stats.populations.seed_all.min`), rounded **down to 0.05**. Enforce `quick ≥ deep > fallback`; if the rounded `fallback` is not below `deep`, step it down another 0.05 and note it. Write the six values into that profile's `similarity` as its own frozen object (replacing `BGE_SCALE_SIMILARITY` for that profile). Then re-measure with the chosen values. There is no rebuild; the corpus is still this profile's:

```bash
npx tsx ./eval/run.ts --vault <scratchpad>/vault-$KEY/Obsidian --model $KEY --pipeline semantic --stats
```

Guards: `deep_filtered_first_relevant` must be `0` and `quick_hit_at_3_drop` at most `1`. If a guard fails, lower that threshold by 0.01 and re-run this command until it passes; record each adjustment. Then record in `calibration.md`, section "<KEY>": cold-index wall time and max RSS, the semantic metrics (overall/UA/EN MRR and hit@3), the population quantiles, each default's baseline pass rate → suggested → chosen value, and the final guards.

- [ ] **Step 3: Remove the shared bge-scale constant and pin the chosen values**

Once all three profiles carry their own values, delete `BGE_SCALE_SIMILARITY`. In `test/semantic/model-profiles.test.ts`, **replace** the test "pins every profile's similarity defaults" (which fixes the bge values on every profile) with the following. Copy the literal from `calibration.md`'s "Chosen values" table, one row per profile:

```ts
  it('pins the calibrated similarity defaults (calibration.md, "Chosen values")', () => {
    const chosen = Object.fromEntries(MODEL_KEYS.map((key) => [key, resolveModelProfile(key).similarity]));
    expect(chosen).toEqual(CALIBRATED_SIMILARITY);
  });
```

where `CALIBRATED_SIMILARITY` is a `Record<string, SimilarityDefaults>` literal declared at the top of the test file with exactly the values Step 2 chose. A deliberate retune later edits the profile, this pin and `calibration.md` together.

- [ ] **Step 4: Run, then commit**

Run: `npm test && npm run typecheck && npm run lint` — Expected: PASS (the calibration-curve and description tests use `TEST_SIMILARITY`, not profile values, so they are unaffected).

```bash
git add src/modules/semantic/model-profiles.ts test/semantic/model-profiles.test.ts openspec/changes/embedding-model-profiles/calibration.md
git commit -m "feat(semantic): calibrate each profile's similarity defaults on its own scale

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12.2: Acceptance

- [ ] **Step 1: Default profile, cold index and semantic quality**

This runs on a fresh clone of the bge copy with no corpus: `<scratchpad>/vault-accept/Obsidian`. No `--model` anywhere, so the default is what gets exercised. Each line is one simple command:

```bash
npm run build
/usr/bin/time -l node dist/cli.js index --vault <scratchpad>/vault-accept/Obsidian
npx tsx ./eval/run.ts --vault <scratchpad>/vault-accept/Obsidian --pipeline semantic
npx tsx ./eval/run.ts --vault <scratchpad>/vault-accept/Obsidian --pipeline fused
```

Expected: the index line ends `failed=0` and wall time is in minutes (bake-off: 6–11 min for ~6k vectors). Semantic `ua mrr ≥ 0.600` and `en mrr ≥ 0.800`. Remember en has n = 4, so one query moves en MRR by up to 0.25. If either MRR misses, stop and investigate with `superpowers:systematic-debugging` (query prefix applied? EOS kept? pooling from the mask?). The bake-off measured 0.695 / 0.812 on the same golden set.

- [ ] **Step 2: granite-97m end to end through the server**

Re-index the acceptance clone with `--model granite-97m`. Expected: the first stdout line announces the rebuild from `harrier-270m (embed_version 2)`. Then drive the stdio server from a scratchpad driver, `<scratchpad>/accept-granite.mjs`. It spawns `node dist/cli.js --vault <clone> --model granite-97m`, writes `initialize`, `notifications/initialized` and a `tools/call` of `search_notes` with `{"query":["векторний пошук","embeddings"]}`, and waits for the response with id 2. It asserts that every stdout line parses as JSON-RPC, that the response carries semantic hits, and that stderr has no rebuild line. Run it with `node <scratchpad>/accept-granite.mjs`.

- [ ] **Step 3: Record and commit**

Add an "Acceptance" section to `calibration.md` with the index time, max RSS, both metric blocks (aggregates only) and the granite result.

```bash
git add openspec/changes/embedding-model-profiles/calibration.md
git commit -m "docs(openspec): record acceptance measurements for embedding-model-profiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13.1: ADR-0017

**Files:**
- Create: `docs/adr/0017-embedding-model-profiles.md`
- Modify: `docs/adr/INDEX.md`

- [ ] **Step 1: Write the ADR** following `docs/adr/0000-template.md`:
  - **Status** Accepted; **Date** the merge date.
  - **Context**: one model hardcoded in six places; bge-micro-v2 fails the UA MRR > 0.4 gate (0.317); the bake-off (link `docs/research/2026-10-embedding-model-bakeoff.md`) and its three engineering facts (EOS lost to post-processor-then-truncate; 3.7 chars/token matches no model; one model per process); the hub may embed remotely (#126).
  - **Decision**: a closed, versioned registry of verified profiles chosen by `--model` (no repository ids from input); `harrier-270m` default, `granite-97m` lite, `harrier-0.6b` quality, each pinned to a revision; the `EmbeddingProvider` contract with `identity`, `embedQuery`, `embedDocuments`; provider-owned template-aware tokenisation and mask pooling; per-profile similarity defaults calibrated by distribution matching against the bge-micro baseline with golden-set guards; manifest v2 recording the producer; auto-rebuild on mismatch, announced.
  - **Consequences**: one forced re-index per vault; ~344 MB default download and ~2 GB peak RSS; cold index ~3–5× bge-micro; query ~54 ms; a server and `index` with different `--model` on one vault rebuild against each other; the calibrated table copied from `calibration.md` ("Chosen values" plus each profile's UA/EN MRR); CI checks every profile's real tokenizer.
  - **Alternatives considered**: free-form repo ids; Qwen3-Embedding-0.6B (dominated); q4 and CoreML (slower on CPU / macOS-only); per-profile corpus directories; one threshold set for all profiles; keeping the feature-extraction pipeline.
- [ ] **Step 2: `docs/adr/INDEX.md`** — add the 0017 row; change 0013's status cell to "Accepted; model identity and text bound refined in part by [0017](0017-embedding-model-profiles.md)".
- [ ] **Step 3: Commit**

```bash
git add docs/adr
git commit -m "docs(adr): record ADR-0017, embedding models as verified profiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13.2: Architecture docs sweep

- [ ] **Step 1:** Update, each to its current state (one concept per file, ADR-0008):
  - `docs/architecture/embedding-pipeline.md` — profiles (table of the three), default, identity, tokenisation, pooling, batching, cache dir; link ADR-0017.
  - `docs/architecture/own-corpus.md` — constants list (no model constants, no char budget; `EMBED_VERSION` 2, `EMBED_STRATEGY`), the note formula without a cut (line 42), divergence #4 rewritten (inputs bounded in tokens by the profile tokenizer), manifest v2 fields (line 72), the compatibility list (line 107) and the legacy-read rule, benchmarks (lines 120–132) re-stated per profile from `calibration.md`.
  - `docs/architecture/semantic-backend.md` — the startup announcement line; the `index` hint carrying `--model`.
  - `docs/architecture/retrieval-policy.md` — every literal (0.5/0.35/0.3) replaced by "the active profile's `quick`/`deep`/`fallback`/`expansionFloor`"; a "Calibration" section with the per-profile table, the method (design D11) and a pointer to `calibration.md`'s numbers; fix the stale `retrieval-policy.ts:12/18` code references (now `model-profiles.ts`).
  - `docs/architecture/mcp-parameter-dictionary.md` (line 30) — thresholds described as profile defaults; drop "empirically 0.89–0.985, 0.9+ typical".
  - `docs/architecture/module-structure.md` (line 64) — the mermaid node reads `Embedding service<br/>model profile (--model)`.
  - `docs/architecture/cli-startup.md` — final key list and default.
  - `docs/architecture/README.md` (line 19) — the embedding-pipeline blurb.
- [ ] **Step 2: Commit**

```bash
git add docs/architecture
git commit -m "docs(architecture): sweep for model profiles, manifest v2 and per-profile thresholds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13.3: Guide, README and AGENTS sweep

- [ ] **Step 1:** Update:
  - `docs/guide/finding-notes.md` — lines 23–24, 50, 120, 172, 190–197, 239–254: thresholds are the active profile's defaults; replace the bge-scale tuning guide ("0.50 / 0.35 / 0.30 / 0.60+ … below ~0.7 weakens fast") with a per-profile table of defaults from `calibration.md` and model-agnostic advice (raise above the default to tighten; the fallback note tells you when hits came from the retry); lines 361 and 394 (`get_similar_notes`/`find_duplicates` defaults) state "the profile's default" plus the table.
  - `docs/guide/configuration.md` — `--model` row (three keys, default `harrier-270m`); line 79 download sizes per profile; line 81 thresholds as profile defaults; line 88 memory note (~2 GB peak with harrier-270m; granite-97m for small hosts).
  - `docs/guide/installation.md` — download sizes, RAM, cold-index cost (minutes on a ~1k-note vault, about an hour on a 50k-vector vault with harrier-270m; granite-97m ≈ today's cost), the one-time re-index on upgrade and how to pre-warm it with `index`.
  - `README.md` — model sentence and sizes (line 212); `--model` in the index and client-config examples.
  - `AGENTS.md` line 3 — "semantic search (over the server's own embedding corpus)".
- [ ] **Step 2: Grep check**

```bash
grep -rn -i "bge\|xenova\|1894\|3\.7 chars\|~40 MB\|0\.35\|0\.3 \|0\.5 quick" README.md AGENTS.md docs eval/README.md | grep -v "docs/research/\|docs/adr/0006\|docs/adr/0013\|docs/adr/0014"
```

Expected: every remaining hit is historical (ADR-0017's context, the bake-off link) or a fixture-style example; resolve anything else.

- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md docs
git commit -m "docs: sweep the guide and README for the harrier default and profile thresholds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13.4: Guide page — choosing and configuring an embedding model (owner's request)

The owner asked, during PR 4, for one user-facing page that explains how to run a given model, with benchmarks alongside.

**Files:**
- Create: `docs/guide/embedding-models.md`
- Modify: `docs/guide/README.md` (add it to the list), `README.md` (§ user guide list; the model sentence links here), `docs/guide/configuration.md` (the `--model` row links here)

- [ ] **Step 1: Write the page.** Model-agnostic and current-state (no history), with these sections:
  - **The profiles**: a table with key, what it is for (default / lite / quality), repo, dims, pooling, download size, peak RSS while indexing, cold-index time on the measured vault, and query latency where measured.
  - **Choosing**: harrier-270m for most users, granite-97m for small hosts or a fast first index, harrier-0.6b where quality matters more than index time. Ukrainian vs English quality in a sentence each, from the numbers.
  - **Configuring**: `--model <key>` in the MCP client config (one JSON example for Claude Desktop / Claude Code, `args`); the same `--model` for `neuro-vault-mcp index` (pre-warming); the cache directory and `XDG_CACHE_HOME`; `ONNXRUNTIME_NODE_INSTALL=skip` on CPU-only Linux.
  - **Switching models**: one corpus per vault, so a switch discards and rebuilds it (the stderr line the server prints, `semantic_status: indexing` meanwhile, lexical search unaffected). Keep the server and `index` on the same `--model`, or they rebuild against each other. An unknown key fails, listing the keys.
  - **Similarity thresholds per model**: the calibrated table (six defaults × three profiles) from `calibration.md` ("Chosen values"), one sentence on how they were derived (link ADR-0017), and the advice that an explicit `threshold` is on that model's scale and does not carry over to another.
  - **Benchmarks**: semantic MRR / hit@3 overall, UA and EN per profile, plus fused for the default. Measured on the owner's private vault (≈ 950 notes, 25 golden queries: 21 UA, 4 EN). Each EN query is worth up to 0.25 of EN MRR. State the measurement date and point at `eval/README.md`'s reproduction procedure (`neuro-vault-mcp index --model <key>`, then the eval run on a copy) rather than SHAs. Aggregates only, from `calibration.md`; no note paths.
- [ ] **Step 2: Link it** from `docs/guide/README.md`, `README.md` and `configuration.md`, and check that `docs/README.md`'s description of `guide/` still covers it.
- [ ] **Step 3: Commit**

```bash
git add docs/guide README.md
git commit -m "docs(guide): add a page on choosing and configuring the embedding model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14.1–14.4: Delivery (strictly in this order)

- [ ] **14.1 Verify** — run `/opsx:verify` for `embedding-model-profiles`; it writes `verify.md` with the gates (`npm test` count vs PR 3, `npm run lint`, `npm run typecheck`, `npm run build`), the acceptance numbers from `calibration.md`, and a spec-by-spec check. Re-run until no blocking issue remains.
- [ ] **14.2 Retrospective** — write `retrospective.md` per the schema's retrospective instruction, before the PR.
- [ ] **14.3 Archive** — `npx openspec archive embedding-model-profiles -y` (syncs the delta specs into `openspec/specs/` and moves the change folder under `openspec/changes/archive/`); `npx openspec validate --all --strict` passes; commit.
- [ ] **14.4 PR** — after retrospective and archive, invoke `superpowers:finishing-a-development-branch`: push and `gh pr create --base main --title "feat!: embedding model profiles — harrier-270m default, calibrated thresholds (4/4)"`. Body: what changed for users (default model, sizes, the one-time re-index, `--model`), the acceptance table, the calibrated defaults, ADR-0017, `Closes #98`, footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Bind with the ccd_pr tools. **STOP** for review; release stays the owner's call from `main` after merge (`feat!` → major).
