import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvalReport } from '../../eval/report.js';
import { aggregate } from '../../eval/metrics.js';
import { gitSha, REPORT_FORMAT_VERSION, resultsDirOf, writeReport } from '../../eval/report.js';
import { TEST_EMBEDDING_IDENTITY } from '../_identity.js';

const run = promisify(execFile);

describe('gitSha', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('returns null outside a git repository', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-nogit-'));
    await expect(gitSha(dir)).resolves.toBeNull();
  });

  it('returns the SHA, with -dirty appended on a dirty tree', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-git-'));
    const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
    await git('init');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x');
    const clean = await gitSha(dir);
    expect(clean).toMatch(/^[0-9a-f]{40}$/);
    await run('touch', [path.join(dir, 'f')]);
    await expect(gitSha(dir)).resolves.toBe(`${clean}-dirty`);
  });
});

describe('writeReport', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('writes identity fields and a deterministic filename', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-report-'));
    const report: EvalReport = {
      format_version: REPORT_FORMAT_VERSION,
      code_sha: 'abc',
      vault_sha: null,
      model_id: 'onnx-community/harrier-oss-v1-270m-ONNX',
      model_key: 'harrier-270m',
      identity: { ...TEST_EMBEDDING_IDENTITY, model_key: 'harrier-270m' },
      pipeline: 'fused',
      run: 'production',
      effort: 'quick',
      config: { top_k: 5 },
      golden: { path: '/v/.neuro-vault/eval/golden.yaml', count: 2, scored: 2, skipped_ids: [] },
      coverage: {
        relevant_paths_total: 1,
        relevant_paths_indexed: 1,
        entries_unwinnable: 0,
        unwinnable_ids: [],
        corpus_stale_paths: 0,
      },
      metrics: aggregate([]),
      per_query: [],
    };
    const file = await writeReport(report, dir, new Date('2026-10-13T12:00:00Z'));
    expect(path.basename(file)).toBe(
      '2026-10-13T12-00-00-harrier-270m-production-fused-quick.json',
    );
    const parsed = JSON.parse(await readFile(file, 'utf8')) as EvalReport;
    expect(parsed).toEqual(report);
  });
});

describe('resultsDirOf', () => {
  it('puts reports beside the golden set, in the vault', () => {
    expect(resultsDirOf('/v')).toBe(path.join('/v', '.neuro-vault/eval/results'));
  });
});
