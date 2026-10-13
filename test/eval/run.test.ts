import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorpusStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { TEST_DIMS } from '../_identity.js';
import { corpusIdentityOf } from '../../src/lib/obsidian/corpus/identity.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { GoldenSetError } from '../../eval/golden.js';
import { UsageError, parseEvalArgs, runEval } from '../../eval/run.js';
import { BackendError } from '../../eval/backends.js';
import {
  DEFAULT_MODEL_KEY,
  identityOf,
  resolveModelProfile,
} from '../../src/modules/semantic/model-profiles.js';

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
    [['--vault', '/v', '--model', 'text-embedding-3-small'], /bge-micro-v2.*granite-97m/s],
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
    const store = new CorpusStore(vaultRoot, { dims: TEST_DIMS });
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
    expect(report.config).toMatchObject({ top_k: 10, semantic_threshold: 0 });
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

  it('hands the selected profile to the corpus gate before any query is embedded', async () => {
    await makeVault(GOLDEN); // the fixture corpus is granite-97m's
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
    await expect(run).rejects.toThrow(/not harrier-270m/);
    expect(embed).not.toHaveBeenCalled();
  });
});
