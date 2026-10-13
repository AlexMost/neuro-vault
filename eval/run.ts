import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbeddingService } from '../src/modules/semantic/embedding-service.js';
import { corpusIdentityOf } from '../src/lib/obsidian/corpus/identity.js';
import {
  DEFAULT_MODEL_KEY,
  identityOf,
  MODEL_KEYS,
  resolveModelProfile,
  type ModelProfile,
} from '../src/modules/semantic/model-profiles.js';
import { BackendError, loadSnapshot } from './backends.js';
import { GoldenSetError, goldenSetPath, loadGoldenSet } from './golden.js';
import { aggregate, scoreQuery, type QueryScore } from './metrics.js';
import {
  bestRelevantSimilarity,
  createFusedContext,
  EVAL_TOP_K,
  evalConfig,
  rankQuery,
  type EmbedFn,
  type FusedContext,
  type PipelineId,
} from './pipelines.js';
import { gitSha, writeReport, type EvalReport } from './report.js';
import { collectPopulations, computeCalibrationStats, type CalibrationStats } from './stats.js';

export class UsageError extends Error {}

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
    // A value token that is itself a flag means the real value was omitted and
    // the next flag got silently swallowed as this one's value.
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
  if (baseline !== undefined && !stats) {
    throw new UsageError(`--baseline requires --stats\n${USAGE}`);
  }
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

// "This repo" is the checkout the harness code came from — not the cwd the
// runner happened to be launched from. Both the default results directory and
// `code_sha` derive from it, so a report always names the code that produced
// its numbers.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = path.join(MODULE_DIR, 'results');

const DEFAULT_KEYS = ['quick', 'deep', 'fallback', 'expansionFloor', 'similarNotes', 'duplicates'];

/** A `--stats` report read back as the calibration baseline, with its provenance. */
interface Baseline {
  stats: CalibrationStats;
  provenance: NonNullable<CalibrationStats['baseline']>;
}

async function readBaseline(file: string): Promise<Baseline> {
  let report: Partial<EvalReport>;
  try {
    report = JSON.parse(await readFile(file, 'utf8')) as Partial<EvalReport>;
  } catch (error) {
    throw new UsageError(
      `--baseline ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stats = report.stats;
  if (stats?.pass_rates === undefined || typeof report.model_key !== 'string') {
    throw new UsageError(`--baseline ${file} is not a --stats report`);
  }
  for (const key of DEFAULT_KEYS) {
    const rate = (stats.pass_rates as Record<string, { pass_rate?: unknown } | undefined>)[key]
      ?.pass_rate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new UsageError(
        `--baseline ${file}: pass_rates.${key}.pass_rate must be a number in [0, 1], got ${JSON.stringify(rate) ?? 'nothing'}`,
      );
    }
  }
  return {
    stats,
    provenance: {
      file: path.resolve(file),
      model_key: report.model_key,
      vault_sha: report.vault_sha ?? null,
      code_sha: report.code_sha ?? null,
    },
  };
}

/**
 * One line when the baseline and this run are not a paired comparison (see the
 * README's comparability rule): the vault states differ, or either is unknown or dirty.
 */
export function baselineComparabilityWarning(report: EvalReport): string | undefined {
  const baseline = report.stats?.baseline;
  if (baseline === undefined) return undefined;
  const clean = (sha: string | null): sha is string => sha !== null && !sha.endsWith('-dirty');
  if (clean(report.vault_sha) && report.vault_sha === baseline.vault_sha) return undefined;
  return `warning: baseline ${baseline.file} (vault_sha ${baseline.vault_sha ?? 'n/a'}) and this run (vault_sha ${report.vault_sha ?? 'n/a'}) are not comparable — their vault states differ or are unknown/dirty, so the suggested thresholds may reflect the data rather than the model`;
}

export async function runEval(
  args: EvalArgs,
  deps: { embed?: EmbedFn; resultsDir?: string } = {},
): Promise<{ reportFile: string; report: EvalReport }> {
  const vaultRoot = path.resolve(args.vault);
  // Validation gates the run: golden set first (its failures must precede any
  // model/corpus work), then the backend snapshot.
  const entries = await loadGoldenSet(vaultRoot);
  const profile = args.model; // the only profile this run sees
  const identity = identityOf(profile);
  const sources = await loadSnapshot(vaultRoot, corpusIdentityOf(identity));
  // A bad baseline fails here, not after the whole golden set has been embedded.
  const baseline = args.baseline === undefined ? undefined : await readBaseline(args.baseline);
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService({ profile });
      return (text: string) => service.embedQuery(text);
    })();
  const fusedContext: FusedContext | undefined =
    args.pipeline === 'fused' ? await createFusedContext(vaultRoot) : undefined;

  const config = evalConfig(profile.similarity);
  const per_query: QueryScore[] = [];
  const queryVectors: number[][] = [];
  for (const entry of entries) {
    const queryVector = await embed(entry.query);
    queryVectors.push(queryVector);
    const ranked = await rankQuery({
      pipeline: args.pipeline,
      query: entry.query,
      queryVector,
      sources,
      fusedContext,
      similarity: profile.similarity,
    });
    per_query.push(
      scoreQuery(entry, ranked, bestRelevantSimilarity(queryVector, entry.relevant, sources)),
    );
  }

  let stats: CalibrationStats | undefined;
  if (args.stats) {
    // The run's own knobs, so the populations can never drift from what was ranked.
    const populations = collectPopulations({
      queryVectors,
      sources,
      seedPool: config.semantic_pool,
      expansionLimit: config.expansion_limit,
      topK: EVAL_TOP_K,
    });
    stats = computeCalibrationStats({
      populations,
      similarity: profile.similarity,
      perQuery: per_query,
      deepPool: config.semantic_pool,
      baseline: baseline?.stats,
    });
    if (baseline) stats.baseline = baseline.provenance;
  }

  const report: EvalReport = {
    code_sha: await gitSha(MODULE_DIR),
    vault_sha: await gitSha(vaultRoot),
    model_id: identity.model_id,
    model_key: profile.key,
    identity,
    pipeline: args.pipeline,
    config: { ...config },
    golden: { path: goldenSetPath(vaultRoot), count: entries.length },
    metrics: aggregate(per_query),
    per_query,
    ...(stats ? { stats } : {}),
  };
  const reportFile = await writeReport(report, deps.resultsDir ?? DEFAULT_RESULTS_DIR);
  return { reportFile, report };
}

function formatSlice(name: string, m: EvalReport['metrics']['overall']): string {
  return `${name.padEnd(8)} n=${m.n}  p@3=${m.precision_at_3.toFixed(3)}  mrr=${m.mrr.toFixed(3)}  hit@3=${m.hit_at_3.toFixed(3)}`;
}

function formatStats(stats: CalibrationStats): string[] {
  const lines = Object.entries(stats.pass_rates).map(([key, rate]) => {
    const suggested = stats.suggested?.[key as keyof typeof stats.pass_rates];
    const tail = suggested ? `  → suggested ${suggested.threshold.toFixed(3)}` : '';
    return `${key}: threshold=${rate.threshold.toFixed(3)} pass=${rate.pass_rate.toFixed(3)}${tail}`;
  });
  lines.push(
    `guard deep_filtered_first_relevant=${stats.guards.deep_filtered_first_relevant} (target 0)`,
    `guard quick_hit_at_3_drop=${stats.guards.quick_hit_at_3_drop} (target ≤ 1)`,
  );
  return lines;
}

async function main(): Promise<void> {
  try {
    const args = parseEvalArgs(process.argv.slice(2));
    const { report, reportFile } = await runEval(args);
    const warning = baselineComparabilityWarning(report);
    if (warning !== undefined) console.error(warning);
    console.log(`model=${report.model_key} pipeline=${report.pipeline}`);
    console.log(`code_sha=${report.code_sha ?? 'n/a'} vault_sha=${report.vault_sha ?? 'n/a'}`);
    console.log(formatSlice('overall', report.metrics.overall));
    console.log(formatSlice('ua', report.metrics.ua));
    console.log(formatSlice('en', report.metrics.en));
    if (report.stats) for (const line of formatStats(report.stats)) console.log(line);
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
