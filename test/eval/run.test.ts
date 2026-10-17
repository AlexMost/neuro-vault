import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShardStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { TEST_DIMS } from '../_identity.js';
import { modelCorpusDir } from '../../src/lib/obsidian/corpus/layout.js';
import { corpusIdentityOf } from '../../src/lib/obsidian/corpus/identity.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { GoldenSetError } from '../../eval/golden.js';
import {
  UsageError,
  baselineComparabilityWarning,
  parseEvalArgs,
  runEval,
} from '../../eval/run.js';
import { BackendError } from '../../eval/backends.js';
import type { EvalReport } from '../../eval/report.js';
import {
  DEFAULT_MODEL_KEY,
  identityOf,
  resolveModelProfile,
} from '../../src/lib/model-profiles.js';

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
    const args = parseEvalArgs([
      '--vault',
      '/v',
      '--model',
      'granite-97m',
      '--stats',
      '--baseline',
      '/r.json',
    ]);
    expect(args.model.key).toBe('granite-97m');
    expect(args.stats).toBe(true);
    expect(args.baseline).toBe('/r.json');
  });

  it.each([
    [['--pipeline', 'semantic'], /--vault/],
    [['--vault', '/v', '--pipeline', 'reranked'], /semantic.*fused/s],
    [['--vault', '/v', '--pipeline', 'semantic', '--bogus'], /--bogus/],
    [['--vault', '--pipeline'], /--vault/],
    [
      ['--vault', '/v', '--model', 'text-embedding-3-small'],
      /harrier-270m.*granite-97m.*harrier-0\.6b/s,
    ],
    [['--vault', '/v', '--baseline', '/r.json'], /--baseline requires --stats/],
    [['--vault', '/v', '--pipeline', 'fused', '--stats'], /--stats measures the semantic pipeline/],
  ])('rejects %j naming what is supported', (argv, pattern) => {
    expect(() => parseEvalArgs(argv)).toThrow(UsageError);
    expect(() => parseEvalArgs(argv)).toThrow(pattern);
  });

  it('rejects the retired backend axis', () => {
    expect(() => parseEvalArgs(['--vault', '/v', '--backend', 'sc'])).toThrow(UsageError);
    expect(() => parseEvalArgs(['--vault', '/v', '--backend', 'sc'])).toThrow(/backend/i);
  });
});

describe('runEval end-to-end (stub embedder)', () => {
  // Named explicitly (not the default) so the fixtures survive a change of default profile.
  const GRANITE = resolveModelProfile('granite-97m');
  let vaultRoot: string;
  let resultsDir: string;
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(resultsDir, { recursive: true, force: true });
  });

  function unitVec(hot: number): number[] {
    const v = new Array<number>(TEST_DIMS).fill(0);
    v[hot] = 1;
    return v;
  }

  // More notes than the seed pool, so the expansion leg has non-seed neighbours to measure.
  async function addExtraNotes(): Promise<void> {
    const store = new ShardStore(vaultRoot, { modelKey: GRANITE.key, dims: TEST_DIMS });
    for (let i = 1; i <= 10; i += 1) {
      await store.writeShard({
        path: `Notes/extra-${i}.md`,
        content_hash: `x${i}`,
        mtime: i,
        size: 30,
        embedding: encodeVector(unitVec(10 + i)),
        blocks: [],
      });
    }
  }

  async function makeVault(golden: string): Promise<void> {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-e2e-vault-'));
    resultsDir = await mkdtemp(path.join(tmpdir(), 'eval-e2e-results-'));
    for (const [note, text] of [
      ['Notes/target.md', '# target\ncontent about the topic\n'],
      ['Notes/other.md', '# other\nsomething else entirely\n'],
    ] as const) {
      await mkdir(path.join(vaultRoot, path.dirname(note)), { recursive: true });
      await writeFile(path.join(vaultRoot, note), text);
    }
    const store = new ShardStore(vaultRoot, { modelKey: GRANITE.key, dims: TEST_DIMS });
    await store.ensureManifest(corpusIdentityOf(identityOf(GRANITE)));
    await store.writeShard({
      path: 'Notes/target.md',
      content_hash: 'h1',
      mtime: 1,
      size: 30,
      embedding: encodeVector(unitVec(0)), // matches the stub query vector
      blocks: [],
    });
    await store.writeShard({
      path: 'Notes/other.md',
      content_hash: 'h2',
      mtime: 2,
      size: 30,
      embedding: encodeVector(unitVec(5)), // orthogonal
      blocks: [],
    });
    await mkdir(path.join(vaultRoot, '.neuro-vault/eval'), { recursive: true });
    await writeFile(path.join(vaultRoot, '.neuro-vault/eval/golden.yaml'), golden);
  }

  const GOLDEN = `
- id: q001
  query: "the topic"
  lang: en
  relevant:
    - Notes/target.md
`;

  it('runs semantic and writes a correct report', async () => {
    await makeVault(GOLDEN);
    const { report, reportFile } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(reportFile).toContain('semantic');
    expect(report.pipeline).toBe('semantic');
    expect(report.vault_sha).toBeNull(); // temp vault is not a git repo
    expect(report.golden.count).toBe(1);
    expect(report.metrics.overall).toMatchObject({ n: 1, mrr: 1, hit_at_3: 1 });
    expect(report.per_query[0]).toMatchObject({
      id: 'q001',
      first_relevant_rank: 1,
    });
    expect(report.config).toMatchObject({
      top_k: 10,
      semantic_threshold: 0,
      expansion_floor: GRANITE.similarity.expansionFloor,
    });
  });

  it('records the profile and the evidence behind each ranking', async () => {
    await makeVault(GOLDEN);
    const { report, reportFile } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(report.model_key).toBe('granite-97m');
    expect(report.identity).toEqual(identityOf(GRANITE));
    expect(report.model_id).toBe(report.identity.model_id);
    expect(path.basename(reportFile)).toMatch(/-granite-97m-semantic\.json$/);
    expect(report.per_query[0]).toMatchObject({
      top: ['Notes/target.md', 'Notes/other.md'],
      top_scores: [1, 0],
      relevant_ranks: [1],
      best_relevant_similarity: 1,
    });
  });

  // `code_sha` answers "which checkout produced these numbers", so it must
  // describe the checkout the harness code came from — not whatever directory
  // the runner happened to be launched from.
  it('records code_sha for the harness checkout, whatever the cwd', async () => {
    await makeVault(GOLDEN);
    const outside = await mkdtemp(path.join(tmpdir(), 'eval-not-a-repo-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(outside);
    try {
      const { report } = await runEval(
        { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
        { embed: () => Promise.resolve(unitVec(0)), resultsDir },
      );
      expect(report.code_sha).not.toBeNull();
    } finally {
      cwdSpy.mockRestore();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('broken relevant path: fails before ranking, writes no report', async () => {
    await makeVault(`${GOLDEN}- id: q002\n  query: x\n  lang: en\n  relevant: [Gone/nope.md]\n`);
    await expect(
      runEval(
        { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
        { embed: () => Promise.reject(new Error('embed must not run')), resultsDir },
      ),
    ).rejects.toThrow(GoldenSetError);
    await expect(readdir(resultsDir)).resolves.toEqual([]);
  });

  it('fused also completes on the fixture', async () => {
    await makeVault(GOLDEN);
    const { report } = await runEval(
      { vault: vaultRoot, pipeline: 'fused', model: GRANITE, stats: false },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(report.metrics.overall.n).toBe(1);
    expect(report.per_query[0].top).toContain('Notes/target.md');
  });

  it('embeds each golden query exactly once, for the semantic and the fused pipeline alike', async () => {
    await makeVault(
      `${GOLDEN}- id: q002\n  query: other\n  lang: en\n  relevant: [Notes/other.md]\n`,
    );
    for (const pipeline of ['semantic', 'fused'] as const) {
      const embed = vi.fn(() => Promise.resolve(unitVec(0)));
      const { report } = await runEval(
        { vault: vaultRoot, pipeline, model: GRANITE, stats: false },
        { embed, resultsDir },
      );
      expect(report.golden.count).toBe(2);
      expect(embed).toHaveBeenCalledTimes(2);
    }
  });

  it('leaves the statistics out of a report that did not ask for them', async () => {
    await makeVault(GOLDEN);
    const { report } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(report).not.toHaveProperty('stats');
  });

  it('with --stats, measures the populations against the selected profile', async () => {
    await makeVault(GOLDEN);
    const { report, reportFile } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(report.stats?.pass_rates.deep.threshold).toBe(GRANITE.similarity.deep);
    expect(report.stats?.populations.query_candidates.n).toBe(2); // both notes are top-k candidates
    expect(report.stats?.guards).toEqual({
      deep_filtered_first_relevant: 0,
      quick_hit_at_3_drop: 0,
    });
    expect(report.stats?.suggested).toBeUndefined();
    const written = JSON.parse(await readFile(reportFile, 'utf8')) as EvalReport;
    expect(written.stats?.pass_rates.deep).toEqual(report.stats?.pass_rates.deep);
  });

  it('with --baseline, suggests thresholds reproducing the baseline report pass rates', async () => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = () => Promise.resolve(unitVec(0));
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const { report } = await runEval(
      {
        vault: vaultRoot,
        pipeline: 'semantic',
        model: GRANITE,
        stats: true,
        baseline: first.reportFile,
      },
      { embed, resultsDir },
    );
    const rate = first.report.stats!.pass_rates.deep.pass_rate;
    expect(first.report.stats?.populations.query_all.n).toBe(12); // every source, not just the top-k
    expect(rate).toBeCloseTo(1 / 12); // one source scores 1, the rest 0
    expect(report.stats?.suggested?.deep.baseline_pass_rate).toBe(rate);
    expect(report.stats?.suggested?.deep.threshold).toBe(1);
  });

  it('records which baseline produced the suggested thresholds', async () => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = () => Promise.resolve(unitVec(0));
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const { report } = await runEval(
      {
        vault: vaultRoot,
        pipeline: 'semantic',
        model: GRANITE,
        stats: true,
        baseline: path.relative(process.cwd(), first.reportFile),
      },
      { embed, resultsDir },
    );
    expect(report.stats?.baseline).toEqual({
      file: first.reportFile, // resolved, though it was passed relative
      model_key: first.report.model_key,
      vault_sha: first.report.vault_sha,
      code_sha: first.report.code_sha,
    });
    expect(first.report.stats?.baseline).toBeUndefined();
  });

  it('reads a baseline whose profile has left the registry', async () => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = () => Promise.resolve(unitVec(0));
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

  it.each([
    ['above 1', 1.5],
    ['negative', -0.1],
    ['non-finite (serialised as null)', null],
    ['not a number', '0.5'],
  ])('refuses a --baseline whose pass rate is %s, naming the file and key', async (_name, bad) => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = vi.fn(() => Promise.resolve(unitVec(0)));
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const broken = JSON.parse(await readFile(first.reportFile, 'utf8')) as EvalReport;
    (broken.stats!.pass_rates.similarNotes as { pass_rate: unknown }).pass_rate = bad;
    const brokenFile = path.join(resultsDir, 'broken-baseline.json');
    await writeFile(brokenFile, JSON.stringify(broken));
    embed.mockClear();
    const run = runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true, baseline: brokenFile },
      { embed, resultsDir },
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/broken-baseline\.json.*similarNotes/);
    expect(embed).not.toHaveBeenCalled();
  });

  it('refuses a --baseline that measured a default on another population, before embedding anything', async () => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = vi.fn(() => Promise.resolve(unitVec(0)));
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    const ranked = structuredClone(first.report);
    ranked.stats!.pass_rates.deep.population = 'query_candidates';
    const rankedFile = path.join(resultsDir, 'ranked-baseline.json');
    await writeFile(rankedFile, JSON.stringify(ranked));
    embed.mockClear();
    const run = runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true, baseline: rankedFile },
      { embed, resultsDir },
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/ranked-baseline\.json.*deep.*query_candidates.*query_all/s);
    expect(embed).not.toHaveBeenCalled();
  });

  it('refuses a --baseline that lacks one of the defaults, before embedding anything', async () => {
    await makeVault(GOLDEN);
    await addExtraNotes();
    const embed = vi.fn(() => Promise.resolve(unitVec(0)));
    const first = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true },
      { embed, resultsDir },
    );
    // An older report, written before a default existed.
    const older = JSON.parse(await readFile(first.reportFile, 'utf8')) as EvalReport;
    delete (older.stats!.pass_rates as Partial<Record<string, unknown>>).duplicates;
    const olderFile = path.join(resultsDir, 'older-baseline.json');
    await writeFile(olderFile, JSON.stringify(older));
    embed.mockClear();
    const run = runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: true, baseline: olderFile },
      { embed, resultsDir },
    );
    await expect(run).rejects.toThrow(/older-baseline\.json: pass_rates\.duplicates/);
    expect(embed).not.toHaveBeenCalled();
  });

  it('refuses a --baseline that is not a --stats report, before embedding anything', async () => {
    await makeVault(GOLDEN);
    const plain = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', model: GRANITE, stats: false },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    const embed = vi.fn(() => Promise.resolve(unitVec(0)));
    const run = runEval(
      {
        vault: vaultRoot,
        pipeline: 'semantic',
        model: GRANITE,
        stats: true,
        baseline: plain.reportFile,
      },
      { embed, resultsDir },
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/is not a --stats report/);
    expect(embed).not.toHaveBeenCalled();
  });

  it('refuses a --baseline file that cannot be read', async () => {
    await makeVault(GOLDEN);
    const run = runEval(
      {
        vault: vaultRoot,
        pipeline: 'semantic',
        model: GRANITE,
        stats: true,
        baseline: path.join(resultsDir, 'missing.json'),
      },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/missing\.json/);
  });

  it('hands the selected profile to the corpus gate before any query is embedded', async () => {
    await makeVault(GOLDEN); // the fixture corpus is granite-97m's, so harrier-270m has none
    const embed = vi.fn(() => Promise.reject(new Error('embed must not run')));
    const run = runEval(
      {
        vault: vaultRoot,
        pipeline: 'semantic',
        model: resolveModelProfile('harrier-270m'),
        stats: false,
      },
      { embed, resultsDir },
    );
    await expect(run).rejects.toThrow(BackendError);
    await expect(run).rejects.toThrow(
      `own corpus at ${modelCorpusDir(vaultRoot, 'harrier-270m')} is missing or empty (this vault has corpora for: granite-97m) — build it with: neuro-vault-mcp index --vault ${vaultRoot} --model harrier-270m`,
    );
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('baselineComparabilityWarning', () => {
  const report = (vault_sha: string | null, baselineSha: string | null): EvalReport =>
    ({
      vault_sha,
      stats: {
        baseline: { file: '/b.json', model_key: 'k', vault_sha: baselineSha, code_sha: null },
      },
    }) as unknown as EvalReport;

  it('is silent when both vault states are the same clean commit', () => {
    expect(baselineComparabilityWarning(report('abc', 'abc'))).toBeUndefined();
  });

  it('is silent when no baseline was used', () => {
    expect(baselineComparabilityWarning({ vault_sha: 'abc' } as EvalReport)).toBeUndefined();
  });

  it.each([
    ['differ', 'abc', 'def'],
    ['are unknown', null, null],
    ['are dirty', 'abc-dirty', 'abc-dirty'],
    ['has a dirty baseline', 'abc', 'abc-dirty'],
    ['has an unknown baseline', 'abc', null],
  ])('warns once when the vault states %s', (_name, current, baseline) => {
    const warning = baselineComparabilityWarning(report(current, baseline));
    expect(warning).toMatch(/not comparable/);
    expect(warning).toContain('/b.json');
    expect(warning).not.toContain('\n');
  });
});
