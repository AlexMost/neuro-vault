import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_ID } from '../src/lib/obsidian/corpus/types.js';
import { EmbeddingService } from '../src/modules/semantic/embedding-service.js';
import { BackendError, loadSnapshot, type BackendId } from './backends.js';
import { GoldenSetError, goldenSetPath, loadGoldenSet } from './golden.js';
import { aggregate, scoreQuery, type QueryScore } from './metrics.js';
import {
  EVAL_CONFIG,
  createFusedContext,
  rankQuery,
  type EmbedFn,
  type FusedContext,
  type PipelineId,
} from './pipelines.js';
import { gitSha, writeReport, type EvalReport } from './report.js';

export class UsageError extends Error {}

export interface EvalArgs {
  vault: string;
  pipeline: PipelineId;
  backend: BackendId;
}

const USAGE =
  'usage: npm run eval -- --vault <path> --pipeline <semantic|fused> --backend <sc|own>';

export function parseEvalArgs(argv: string[]): EvalArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--vault', '--pipeline', '--backend'].includes(flag) || value === undefined) {
      throw new UsageError(`unknown or valueless argument "${flag}"\n${USAGE}`);
    }
    values.set(flag, value);
  }
  const vault = values.get('--vault');
  if (vault === undefined) throw new UsageError(`--vault is required\n${USAGE}`);
  const pipeline = values.get('--pipeline') ?? 'semantic';
  if (pipeline !== 'semantic' && pipeline !== 'fused') {
    throw new UsageError(`unknown pipeline "${pipeline}" — supported: semantic, fused`);
  }
  const backend = values.get('--backend') ?? 'own';
  if (backend !== 'sc' && backend !== 'own') {
    throw new UsageError(`unknown backend "${backend}" — supported: sc, own`);
  }
  return { vault, pipeline, backend };
}

const DEFAULT_RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');

export async function runEval(
  args: EvalArgs,
  deps: { embed?: EmbedFn; resultsDir?: string; modelId?: string } = {},
): Promise<{ reportFile: string; report: EvalReport }> {
  const vaultRoot = path.resolve(args.vault);
  // Validation gates the run: golden set first (its failures must precede any
  // model/corpus work), then the backend snapshot.
  const entries = await loadGoldenSet(vaultRoot);
  const sources = await loadSnapshot(args.backend, vaultRoot);
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService();
      return (text: string) => service.embed(text);
    })();
  const fusedContext: FusedContext | undefined =
    args.pipeline === 'fused' ? await createFusedContext(vaultRoot) : undefined;

  const per_query: QueryScore[] = [];
  for (const entry of entries) {
    const top = await rankQuery({
      pipeline: args.pipeline,
      query: entry.query,
      sources,
      embed,
      fusedContext,
    });
    per_query.push(scoreQuery(entry, top));
  }

  const report: EvalReport = {
    code_sha: await gitSha(process.cwd()),
    vault_sha: await gitSha(vaultRoot),
    model_id: deps.modelId ?? MODEL_ID,
    pipeline: args.pipeline,
    backend: args.backend,
    config: { ...EVAL_CONFIG },
    golden: { path: goldenSetPath(vaultRoot), count: entries.length },
    metrics: aggregate(per_query),
    per_query,
  };
  const reportFile = await writeReport(report, deps.resultsDir ?? DEFAULT_RESULTS_DIR);
  return { reportFile, report };
}

function formatSlice(name: string, m: EvalReport['metrics']['overall']): string {
  return `${name.padEnd(8)} n=${m.n}  p@3=${m.precision_at_3.toFixed(3)}  mrr=${m.mrr.toFixed(3)}  hit@3=${m.hit_at_3.toFixed(3)}`;
}

async function main(): Promise<void> {
  try {
    const args = parseEvalArgs(process.argv.slice(2));
    const { report, reportFile } = await runEval(args);
    console.log(`pipeline=${report.pipeline} backend=${report.backend}`);
    console.log(`code_sha=${report.code_sha ?? 'n/a'} vault_sha=${report.vault_sha ?? 'n/a'}`);
    console.log(formatSlice('overall', report.metrics.overall));
    console.log(formatSlice('ua', report.metrics.ua));
    console.log(formatSlice('en', report.metrics.en));
    console.log(`report: ${reportFile}`);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof GoldenSetError ||
      error instanceof BackendError
    ) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exitCode = 1;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main();
}
