import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { EmbeddingIdentity } from '../src/lib/obsidian/corpus/types.js';
import type { Coverage, LegDiagnostics, Metrics, QueryScore } from './metrics.js';
import type { PipelineId, RunMode } from './pipelines.js';
import type { SearchEffort } from '../src/modules/semantic/types.js';
import type { CalibrationStats } from './stats.js';

const execFileAsync = promisify(execFile);

/**
 * Bumped whenever a report's shape or meaning changes. 2: control entries, class slices,
 * recall@10, run modes, coverage and leg diagnostics; precision@3 dropped. Reports of
 * different versions are not comparable.
 */
export const REPORT_FORMAT_VERSION = 2;

/** `<vault>/.neuro-vault/eval/results/` — reports live beside the golden set, in the vault's repository. */
export function resultsDirOf(vaultRoot: string): string {
  return path.join(vaultRoot, '.neuro-vault/eval/results');
}

export interface EvalReport {
  format_version: typeof REPORT_FORMAT_VERSION;
  /** Repo HEAD; `<sha>-dirty` on a dirty tree; null when not a git repo. */
  code_sha: string | null;
  /** Vault HEAD, same convention — two reports compare iff these match, clean. */
  vault_sha: string | null;
  model_id: string;
  /** The profile key the run was invoked with (`--model`). */
  model_key: string;
  /** The full identity the corpus was gated against and queries were embedded under. */
  identity: EmbeddingIdentity;
  pipeline: PipelineId;
  run: RunMode;
  effort: SearchEffort;
  config: Record<string, unknown>;
  /** `count` entries in the set, `scored` of them in this run (`semantic` skips array entries). */
  golden: { path: string; count: number; scored: number; skipped_ids: string[] };
  coverage: Coverage;
  metrics: Metrics;
  /** Which legs the returned notes came from; present on a production run of `fused` or `lexical`. */
  diagnostics?: LegDiagnostics;
  per_query: QueryScore[];
  /** Calibration statistics; present only on a `--stats` run. */
  stats?: CalibrationStats;
}

export async function gitSha(dir: string): Promise<string | null> {
  try {
    const { stdout: sha } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const { stdout: status } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
    const clean = status.trim() === '';
    return clean ? sha.trim() : `${sha.trim()}-dirty`;
  } catch {
    return null;
  }
}

export async function writeReport(
  report: EvalReport,
  resultsDir: string,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  const file = path.join(
    resultsDir,
    `${stamp}-${report.model_key}-${report.run}-${report.pipeline}-${report.effort}.json`,
  );
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
