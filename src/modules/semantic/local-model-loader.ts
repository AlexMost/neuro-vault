import os from 'node:os';
import path from 'node:path';

import type { ModelProfile } from './model-profiles.js';
import type { ModelOutput } from './pooling.js';

/** The tokenizer surface the provider uses — a structural slice of transformers.js's. */
export interface TokenizerHandle {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  /** The side the tokenizer pads on; transformers.js defaults to right when its config is silent. */
  readonly padding_side?: string;
  /** May equal a template id (harrier-0.6b pads with its suffix) — pooling reads the mask, never ids. */
  readonly pad_token_id?: number | null;
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
  config?: { max_position_embeddings?: number };
  dispose?(): Promise<unknown>;
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

function pickOutput(
  profile: ModelProfile,
  outputNames: string[],
): { name: string; kind: ModelOutput['kind'] } {
  const tokenStates = TOKEN_STATE_OUTPUTS.find((name) => outputNames.includes(name));
  if (tokenStates !== undefined) return { name: tokenStates, kind: 'token_states' };
  if (outputNames.includes(POOLED_OUTPUT)) return { name: POOLED_OUTPUT, kind: 'pooled' };
  throw new Error(
    `model "${profile.key}": export has no usable output (has: ${outputNames.join(', ')})`,
  );
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

    const tokenizer = await tf.AutoTokenizer.from_pretrained(profile.repo, {
      revision: profile.revision,
    });
    const model = await tf.AutoModel.from_pretrained(profile.repo, {
      revision: profile.revision,
      dtype: profile.dtype,
      device: 'cpu',
    });

    // Fail at load, naming the profile, rather than embed garbage later. A
    // rejected export must not keep its weights alive until GC, so the session
    // is released before the error propagates.
    let output: { name: string; kind: ModelOutput['kind'] };
    try {
      const session = Object.values(model.sessions)[0];
      if (session === undefined)
        throw new Error(`model "${profile.key}": no inference session was loaded`);
      for (const input of REQUIRED_INPUTS) {
        if (!session.inputNames.includes(input)) {
          throw new Error(
            `model "${profile.key}": export lacks the "${input}" input (has: ${session.inputNames.join(', ')})`,
          );
        }
      }
      output = pickOutput(profile, session.outputNames);
      // The model's position window, not the tokenizer's declared one: bge-micro's
      // tokenizer declares an effectively unbounded window over a 512-position model.
      const window = model.config?.max_position_embeddings;
      if (typeof window === 'number' && window < profile.maxTokens) {
        throw new Error(
          `model "${profile.key}": maxTokens ${profile.maxTokens} exceeds the model's ${window}-position window`,
        );
      }
    } catch (error) {
      await model.dispose?.().catch(() => undefined);
      throw error;
    }

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
