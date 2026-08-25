import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvalReport } from '../../eval/report.js';
import { gitSha, writeReport } from '../../eval/report.js';

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
      code_sha: 'abc',
      vault_sha: null,
      model_id: 'TaylorAI/bge-micro-v2',
      pipeline: 'semantic',
      config: { top_k: 10 },
      golden: { path: '/v/.neuro-vault/eval/golden.yaml', count: 2 },
      metrics: {
        overall: { n: 2, precision_at_3: 0.5, mrr: 0.75, hit_at_3: 1 },
        ua: { n: 1, precision_at_3: 1 / 3, mrr: 0.5, hit_at_3: 1 },
        en: { n: 1, precision_at_3: 2 / 3, mrr: 1, hit_at_3: 1 },
      },
      per_query: [],
    };
    const file = await writeReport(report, dir, new Date('2026-08-25T10:20:30Z'));
    expect(path.basename(file)).toBe('2026-08-25T10-20-30-semantic.json');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as EvalReport;
    expect(parsed).toEqual(report);
  });
});
