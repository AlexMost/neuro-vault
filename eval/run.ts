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
  type SimilarityDefaults,
} from '../src/lib/model-profiles.js';
import type { SearchEffort } from '../src/modules/semantic/types.js';
import { BackendError, loadCorpus, notesWithVectors } from './backends.js';
import {
  GoldenSetError,
  goldenSetPath,
  isControl,
  LANGS,
  loadGoldenSet,
  QUERY_CLASSES,
  queriesOf,
  scanVault,
} from './golden.js';
import {
  aggregate,
  computeCoverage,
  legDiagnostics,
  scoreQuery,
  type QueryScore,
  type SliceMetrics,
} from './metrics.js';
import {
  bestRelevantSimilarity,
  createLexicalContext,
  EVAL_TOP_K,
  evalConfig,
  PIPELINES,
  rankQuery,
  RUN_MODES,
  type EmbedFn,
  type LexicalContext,
  type PipelineId,
  type RunMode,
} from './pipelines.js';
import {
  gitSha,
  REPORT_FORMAT_VERSION,
  resultsDirOf,
  writeReport,
  type EvalReport,
} from './report.js';
import {
  collectPopulations,
  computeCalibrationStats,
  MAX_STATS_SOURCES,
  measuredKeys,
  POPULATION_OF,
  type CalibrationStats,
  type EntryTop1,
} from './stats.js';

export class UsageError extends Error {}

export interface EvalArgs {
  vault: string;
  pipeline: PipelineId;
  run: RunMode;
  effort: SearchEffort;
  model: ModelProfile;
  stats: boolean;
  baseline?: string;
}

const USAGE =
  'usage: npm run eval -- --vault <path> [--run <positional|production>] [--pipeline <semantic|fused|lexical>] [--effort <quick|deep>] [--model <key>] [--stats [--baseline <report.json>]]';
const VALUE_FLAGS = ['--vault', '--run', '--pipeline', '--effort', '--model', '--baseline'];
const EFFORTS: readonly SearchEffort[] = ['quick', 'deep'];

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
  if (!(PIPELINES as readonly string[]).includes(pipeline)) {
    throw new UsageError(`unknown pipeline "${pipeline}" — supported: ${PIPELINES.join(', ')}`);
  }
  const run = values.get('--run') ?? 'positional';
  if (!(RUN_MODES as readonly string[]).includes(run)) {
    throw new UsageError(`unknown run "${run}" — supported: ${RUN_MODES.join(', ')}`);
  }
  const effortFlag = values.get('--effort');
  if (effortFlag !== undefined && !(EFFORTS as readonly string[]).includes(effortFlag)) {
    throw new UsageError(`unknown effort "${effortFlag}" — supported: ${EFFORTS.join(', ')}`);
  }
  if (run === 'positional' && effortFlag === 'quick') {
    throw new UsageError('a positional run is deep; --effort quick needs --run production');
  }
  if (run === 'production' && pipeline === 'semantic') {
    throw new UsageError(
      'the semantic pipeline is a positional model check; use --pipeline fused or lexical',
    );
  }
  // A production run defaults to `search_notes`' own default effort.
  const effort = (effortFlag ?? (run === 'positional' ? 'deep' : 'quick')) as SearchEffort;
  const modelKey = values.get('--model') ?? DEFAULT_MODEL_KEY;
  if (!MODEL_KEYS.includes(modelKey)) {
    throw new UsageError(`unknown model "${modelKey}" — supported: ${MODEL_KEYS.join(', ')}`);
  }
  const baseline = values.get('--baseline');
  if (baseline !== undefined && !stats) {
    throw new UsageError(`--baseline requires --stats\n${USAGE}`);
  }
  if (stats && pipeline !== 'semantic') {
    throw new UsageError(`--stats measures the semantic pipeline; drop --pipeline ${pipeline}`);
  }
  return {
    vault,
    pipeline: pipeline as PipelineId,
    run: run as RunMode,
    effort,
    model: resolveModelProfile(modelKey),
    stats,
    ...(baseline !== undefined ? { baseline } : {}),
  };
}

// "This repo" is the checkout the harness code came from — not the cwd the
// runner happened to be launched from. `code_sha` derives from it, so a report
// always names the code that produced its numbers.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A `--stats` report read back as the calibration baseline, with its provenance. */
interface Baseline {
  stats: CalibrationStats;
  provenance: NonNullable<CalibrationStats['baseline']>;
}

async function readBaseline(file: string, similarity: SimilarityDefaults): Promise<Baseline> {
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
  // Only the defaults this run measures need a rate to reproduce; a baseline may carry more.
  for (const key of measuredKeys(similarity)) {
    const entry = (
      stats.pass_rates as Record<string, { pass_rate?: unknown; population?: unknown } | undefined>
    )[key];
    const rate = entry?.pass_rate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new UsageError(
        `--baseline ${file}: pass_rates.${key}.pass_rate must be a number in [0, 1], got ${JSON.stringify(rate) ?? 'nothing'}`,
      );
    }
    // A pass rate only means something on the population it was measured on.
    const population = entry?.population;
    if (population !== POPULATION_OF[key]) {
      throw new UsageError(
        `--baseline ${file}: ${key} was measured on ${JSON.stringify(population) ?? 'nothing'}, this build measures it on "${POPULATION_OF[key]}" — re-capture the baseline with --stats`,
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
  // model/corpus work), then the vault's corpus.
  const entries = await loadGoldenSet(vaultRoot);
  const profile = args.model; // the only profile this run sees
  const identity = identityOf(profile);
  const corpus = await loadCorpus(vaultRoot, corpusIdentityOf(identity));
  // Refused here, not as a RangeError after the whole golden set has been embedded.
  if (args.stats && corpus.size() > MAX_STATS_SOURCES) {
    throw new UsageError(
      `--stats keeps every note↔note similarity in memory and takes at most ${MAX_STATS_SOURCES} note vectors; this vault has ${corpus.size()}`,
    );
  }
  // A bad baseline fails here, not after the whole golden set has been embedded.
  const baseline =
    args.baseline === undefined ? undefined : await readBaseline(args.baseline, profile.similarity);
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService({ profile });
      return (text: string) => service.embedQuery(text);
    })();
  // Each distinct string is embedded once; every pipeline ranks the same vectors.
  const vectors = new Map<string, number[]>();
  const vectorsOf = async (queries: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (const query of queries) {
      let vector = vectors.get(query);
      if (vector === undefined) {
        vector = await embed(query);
        vectors.set(query, vector);
      }
      out.push(vector);
    }
    return out;
  };
  const context: LexicalContext | undefined =
    args.pipeline === 'semantic' ? undefined : await createLexicalContext(vaultRoot);
  const shape = { run: args.run, effort: args.effort };

  const config = evalConfig(profile.similarity, shape);
  // `semantic` ranks one vector: an array entry is one call of several strings, which only
  // the retrieval pipeline can merge.
  const scored = entries.filter((e) => args.pipeline !== 'semantic' || typeof e.query === 'string');
  const per_query: QueryScore[] = [];
  const queryVectors: number[][] = [];
  for (const entry of scored) {
    const queries = queriesOf(entry);
    const entryVectors = await vectorsOf(queries);
    queryVectors.push(...entryVectors);
    const ranked = await rankQuery({
      pipeline: args.pipeline,
      shape,
      queries,
      vectors,
      corpus,
      context,
      similarity: profile.similarity,
    });
    per_query.push(
      scoreQuery(entry, ranked, await bestRelevantSimilarity(entryVectors, entry.relevant, corpus)),
    );
  }

  let stats: CalibrationStats | undefined;
  if (args.stats) {
    // Separation covers every entry, array ones included: a call returns a note when any
    // of its strings clears the floor, so its top-1 is the best over its strings.
    const top1: EntryTop1[] = [];
    for (const entry of entries) {
      const lists = await corpus.nearest(
        (await vectorsOf(queriesOf(entry))).map((vector) => ({ vector })),
        { threshold: -1, limit: 1 },
      );
      const best = lists.flatMap((hits) => (hits?.[0] ? [hits[0].similarity] : []));
      if (best.length > 0) top1.push({ control: isControl(entry), similarity: Math.max(...best) });
    }
    // The run's own knobs, so the populations can never drift from what was ranked.
    const populations = await collectPopulations({
      queryVectors,
      corpus,
      paths: await notesWithVectors(corpus),
      seedPool: config.semantic_pool,
      expansionLimit: config.expansion_limit,
      topK: EVAL_TOP_K,
    });
    stats = computeCalibrationStats({
      populations,
      similarity: profile.similarity,
      perQuery: per_query,
      top1,
      deepPool: config.semantic_pool,
      baseline: baseline?.stats,
    });
    if (baseline) stats.baseline = baseline.provenance;
  }

  const coverage = computeCoverage({
    entries,
    indexed: new Set(await notesWithVectors(corpus)),
    corpusPaths: [...(await corpus.entries()).keys()],
    vaultPaths: await scanVault(vaultRoot),
  });
  const scoredIds = new Set(scored.map((e) => e.id));
  const report: EvalReport = {
    format_version: REPORT_FORMAT_VERSION,
    code_sha: await gitSha(MODULE_DIR),
    vault_sha: await gitSha(vaultRoot),
    model_id: identity.model_id,
    model_key: profile.key,
    identity,
    pipeline: args.pipeline,
    run: args.run,
    effort: args.effort,
    config: { ...config },
    golden: {
      path: goldenSetPath(vaultRoot),
      count: entries.length,
      scored: scored.length,
      skipped_ids: entries.filter((e) => !scoredIds.has(e.id)).map((e) => e.id),
    },
    coverage,
    metrics: aggregate(per_query),
    ...(args.run === 'production' && args.pipeline !== 'semantic'
      ? { diagnostics: legDiagnostics(per_query) }
      : {}),
    per_query,
    ...(stats ? { stats } : {}),
  };
  const reportFile = await writeReport(report, deps.resultsDir ?? resultsDirOf(vaultRoot));
  return { reportFile, report };
}

const fmt = (value: number | null): string => (value === null ? '  —  ' : value.toFixed(3));

export function formatSlice(name: string, m: SliceMetrics): string {
  return [
    name.padEnd(22),
    `n=${String(m.answerable).padStart(3)}`,
    `hit@3=${fmt(m.hit_at_3)}`,
    `mrr=${fmt(m.mrr)}`,
    `r@10=${fmt(m.recall_at_10)}`,
    `ctl=${String(m.controls).padStart(3)}`,
    `ctl_hit=${fmt(m.control_hit_rate)}`,
    `ctl_mean=${m.control_mean_results === null ? '  —  ' : m.control_mean_results.toFixed(2)}`,
  ].join('  ');
}

/** The summary the CLI prints: every slice, the coverage, and the leg diagnostics. */
export function formatReport(report: EvalReport): string[] {
  const { metrics } = report;
  const lines = [
    `model=${report.model_key} run=${report.run} pipeline=${report.pipeline} effort=${report.effort}`,
    `code_sha=${report.code_sha ?? 'n/a'} vault_sha=${report.vault_sha ?? 'n/a'}`,
    `golden ${report.golden.scored}/${report.golden.count} scored` +
      (report.golden.skipped_ids.length > 0 ? ` (array entries skipped by semantic)` : ''),
    formatSlice('overall', metrics.overall),
    ...LANGS.map((l) => formatSlice(`lang:${l}`, metrics.lang[l])),
    ...QUERY_CLASSES.map((c) => formatSlice(`class:${c}`, metrics.class[c])),
    ...Object.entries(metrics.class_lang).map(([key, m]) => formatSlice(key, m)),
    `coverage relevant_indexed=${report.coverage.relevant_paths_indexed}/${report.coverage.relevant_paths_total}` +
      ` unwinnable=${report.coverage.entries_unwinnable} corpus_stale=${report.coverage.corpus_stale_paths}`,
  ];
  const { diagnostics } = report;
  if (diagnostics) {
    for (const kind of ['answerable', 'control'] as const) {
      const d = diagnostics[kind];
      lines.push(
        `legs ${kind}: returned=${d.returned} semantic_only=${d.semantic_only} semantic=${d.semantic}` +
          ` lexical=${d.lexical} expansion=${d.expansion} relevant=${d.relevant}` +
          ` relevant_semantic_only=${d.relevant_semantic_only}`,
      );
    }
  }
  return lines;
}

function formatStats(stats: CalibrationStats): string[] {
  const lines = Object.entries(stats.pass_rates).map(([key, rate]) => {
    const suggested = stats.suggested?.[key as keyof typeof stats.pass_rates];
    const tail =
      suggested === undefined
        ? ''
        : suggested.threshold === null
          ? '  → no suggestion (empty population)'
          : `  → suggested ${suggested.threshold.toFixed(3)}`;
    return `${key}: population=${rate.population} threshold=${rate.threshold.toFixed(3)} pass=${rate.pass_rate.toFixed(3)}${tail}`;
  });
  for (const kind of ['answerable', 'control'] as const) {
    const q = stats.separation[kind];
    lines.push(
      `separation ${kind}: n=${q.n} p10=${q.p10.toFixed(3)} p50=${q.p50.toFixed(3)} p90=${q.p90.toFixed(3)} max=${q.max.toFixed(3)}`,
    );
  }
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
    for (const line of formatReport(report)) console.log(line);
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
