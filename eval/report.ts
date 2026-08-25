import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackendId } from './backends.js';
import type { Metrics, QueryScore } from './metrics.js';
import type { PipelineId } from './pipelines.js';

const execFileAsync = promisify(execFile);

export interface EvalReport {
  /** Repo HEAD; `<sha>-dirty` on a dirty tree; null when not a git repo. */
  code_sha: string | null;
  /** Vault HEAD, same convention — two reports compare iff these match, clean. */
  vault_sha: string | null;
  model_id: string;
  pipeline: PipelineId;
  backend: BackendId;
  config: Record<string, unknown>;
  golden: { path: string; count: number };
  metrics: Metrics;
  per_query: QueryScore[];
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
  const file = path.join(resultsDir, `${stamp}-${report.pipeline}-${report.backend}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
