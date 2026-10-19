import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmartSource } from '../../src/lib/obsidian/corpus/types.js';
import { runRetrievalPipeline } from '../../src/modules/semantic/retrieval-pipeline.js';
import { TEST_SIMILARITY } from '../_identity.js';
import { corpusOver } from '../_memory-corpus.js';
import {
  EVAL_TOP_K,
  bestRelevantSimilarity,
  createFusedContext,
  evalConfig,
  rankQuery,
} from '../../eval/pipelines.js';

// 3-dim vectors are fine here: pipelines never touch ShardStore's dims guard.
function src(p: string, v: number[]): [string, SmartSource] {
  return [p, { path: p, embedding: Float32Array.from(v), blocks: [] }];
}

const SOURCES = new Map<string, SmartSource>([
  src('a.md', [1, 0, 0]),
  src('b.md', [0.9, 0.1, 0]),
  src('c.md', [0, 1, 0]),
]);
const QUERY_VECTOR = [1, 0, 0];

describe('semantic pipeline', () => {
  it('ranks by cosine at threshold 0 and caps at top-10', async () => {
    const ranked = await rankQuery({
      pipeline: 'semantic',
      query: 'q',
      queryVector: QUERY_VECTOR,
      corpus: corpusOver(SOURCES),
      similarity: TEST_SIMILARITY,
    });
    const top = ranked.map((r) => r.path);
    expect(top[0]).toBe('a.md');
    expect(top[1]).toBe('b.md');
    // threshold 0: even the orthogonal note appears — positions only.
    expect(top).toContain('c.md');
    expect(top.length).toBeLessThanOrEqual(EVAL_TOP_K);
    // Each path carries the cosine it was ranked by.
    expect(ranked[0].score).toBeCloseTo(1);
    expect(ranked[2].score).toBeCloseTo(0);
  });
});

describe('fused pipeline', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  async function makeFusedVault(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-fused-'));
    await mkdir(path.join(root, 'Notes'), { recursive: true });
    // lexical-only hit: matches the query text, has no vector in SOURCES
    await writeFile(path.join(root, 'Notes/lexical-hit.md'), '# quirkyterm\nquirkyterm body\n');
    await writeFile(path.join(root, 'a.md'), '# alpha\nunrelated text\n');
    return root;
  }

  it('fuses semantic and lexical legs with production fuseRanks', async () => {
    vaultRoot = await makeFusedVault();
    const fusedContext = await createFusedContext(vaultRoot);
    const ranked = await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      queryVector: QUERY_VECTOR,
      corpus: corpusOver(SOURCES),
      fusedContext,
      similarity: TEST_SIMILARITY,
    });
    const top = ranked.map((r) => r.path);
    // Fused scores are RRF scores, best first.
    expect(ranked.map((r) => r.score)).toEqual(
      [...ranked.map((r) => r.score)].sort((a, b) => b - a),
    );
    // The lexical leg surfaced a note the semantic leg cannot know about —
    // the fused list carries it (the Moby-case mechanism, RRF fusion).
    expect(top).toContain('Notes/lexical-hit.md');
    // Semantic leg still contributes its threshold-0 ranking.
    expect(top).toContain('a.md');
  });

  // The retired production-fusion pin's geometry: 10 unit vectors fanned away
  // from the query, so deep's pool (8) seeds n0..n7 and leaves n8/n9
  // expansion-only, plus a lexical-only note and two backlinks onto n9. That
  // is 11 candidates against deep's merged cap of 12, so eval's top-k is the
  // cut — a wrong effort, cap or pool changes the list.
  const FAN = 10;
  const fanPath = (i: number): string => `Notes/n${i}.md`;
  const FAN_LEXICAL_ONLY = 'Notes/lexical-only quirkyterm.md';

  function fanSources(): Map<string, SmartSource> {
    return new Map(
      Array.from({ length: FAN }, (_, i) => {
        const t = i / FAN;
        return src(fanPath(i), [Math.cos(t), Math.sin(t), 0]);
      }),
    );
  }

  function fanBody(i: number): string {
    if (i === 3) return `# n3\n\n## quirkyterm section\n\nsome prose\n`;
    if (i === 9) return `# n9\n\nprose mentioning quirkyterm inline\n`;
    if (i === 5 || i === 6) return `# n${i}\n\nsee [[n9]]\n`;
    return `# n${i}\n\nfiller prose\n`;
  }

  async function makeFanVault(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-fused-fan-'));
    await mkdir(path.join(root, 'Notes'), { recursive: true });
    for (let i = 0; i < FAN; i++) await writeFile(path.join(root, fanPath(i)), fanBody(i));
    await writeFile(path.join(root, FAN_LEXICAL_ONLY), '# lexical only\n\nno vector here\n');
    return root;
  }

  it('ranks exactly as runRetrievalPipeline at deep effort, threshold 0, cap top-k', async () => {
    vaultRoot = await makeFanVault();
    const fusedContext = await createFusedContext(vaultRoot);
    const ranked = await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      queryVector: QUERY_VECTOR,
      corpus: corpusOver(fanSources()),
      fusedContext,
      similarity: TEST_SIMILARITY,
    });
    const { candidates } = await runRetrievalPipeline(
      {
        queries: ['quirkyterm'],
        effort: 'deep',
        semantic: true,
        threshold: 0,
        expansionFloor: TEST_SIMILARITY.expansionFloor,
        cap: EVAL_TOP_K,
      },
      {
        corpus: corpusOver(fanSources()),
        lexical: fusedContext.lexical,
        filterExisting: (paths) => Promise.resolve(new Set(paths)),
        embeddingProvider: {
          initialize: () => Promise.resolve(),
          embedQuery: () => Promise.resolve(QUERY_VECTOR),
        },
        similarity: TEST_SIMILARITY,
      },
    );
    expect(ranked).toEqual(candidates.map((c) => ({ path: c.path, score: c.score })));
    // Non-vacuity: top-k is the cut, and every leg reaches the fused list.
    expect(ranked).toHaveLength(EVAL_TOP_K);
    expect(candidates.some((c) => c.lexical !== undefined && c.semantic === undefined)).toBe(true);
    expect(candidates.some((c) => c.expansion !== undefined)).toBe(true);
    expect(candidates.some((c) => c.semantic !== undefined)).toBe(true);
  });

  it('runs the legs with the knobs its config records', async () => {
    vaultRoot = await makeFanVault();
    const fusedContext = await createFusedContext(vaultRoot);
    const lexicalSearch = vi.spyOn(fusedContext.lexical, 'search');
    const corpus = corpusOver(fanSources());
    const nearest = vi.spyOn(corpus, 'nearest');
    await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      queryVector: QUERY_VECTOR,
      corpus,
      fusedContext,
      similarity: TEST_SIMILARITY,
    });
    const config = evalConfig(TEST_SIMILARITY);
    expect(lexicalSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        noteCap: config.lexical_note_cap,
        perNoteCap: config.lexical_per_note_cap,
      }),
    );
    // The seed read over-fetches one past the pool to detect overflow; the
    // expansion read is the last, floored by the profile's expansion floor.
    expect(nearest.mock.calls[0][1]).toMatchObject({
      threshold: config.semantic_threshold,
      limit: config.semantic_pool + 1,
    });
    expect(nearest.mock.calls.at(-1)?.[1]).toMatchObject({
      threshold: config.expansion_floor,
      limit: config.expansion_limit,
    });
  });

  it('fails instead of reporting a lexical-only run when the semantic leg throws', async () => {
    vaultRoot = await makeFusedVault();
    const fusedContext = await createFusedContext(vaultRoot);
    const broken = corpusOver(SOURCES);
    broken.nearest = () => Promise.reject(new Error('corpus down'));
    await expect(
      rankQuery({
        pipeline: 'fused',
        query: 'quirkyterm',
        queryVector: QUERY_VECTOR,
        corpus: broken,
        fusedContext,
        similarity: TEST_SIMILARITY,
      }),
    ).rejects.toThrow('corpus down');
  });
});

describe('bestRelevantSimilarity', () => {
  it('reaches relevant notes outside the top list', async () => {
    const corpus = corpusOver(
      new Map([
        ['far.md', { path: 'far.md', embedding: new Float32Array([0.6, 0.8]), blocks: [] }],
        ['near.md', { path: 'near.md', embedding: new Float32Array([1, 0]), blocks: [] }],
      ]),
    );
    expect(await bestRelevantSimilarity([1, 0], ['far.md', 'gone.md'], corpus)).toBeCloseTo(0.6);
    expect(await bestRelevantSimilarity([1, 0], ['gone.md'], corpus)).toBeNull();
  });
});

describe('evalConfig', () => {
  // The pool numbers are pinned against the run itself in 'runs the legs with
  // the knobs its config records'; a retune must not need an edit here.
  it('records the fixed knobs', () => {
    expect(evalConfig(TEST_SIMILARITY)).toMatchObject({
      top_k: 10,
      semantic_threshold: 0,
      expansion_floor: 0.35,
      expansion_weight: 0.85,
      k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
    });
  });

  it('reports the profile’s expansion floor and zero query thresholds', () => {
    const config = evalConfig({ ...TEST_SIMILARITY, expansionFloor: 0.81 });
    expect(config.expansion_floor).toBe(0.81);
    expect(config.semantic_threshold).toBe(0);
  });
});
