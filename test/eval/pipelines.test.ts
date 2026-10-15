import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SmartSource } from '../../src/lib/obsidian/corpus/types.js';
import { TEST_SIMILARITY } from '../_identity.js';
import {
  EVAL_TOP_K,
  bestRelevantSimilarity,
  createFusedContext,
  evalConfig,
  rankQuery,
} from '../../eval/pipelines.js';

// 3-dim vectors are fine here: pipelines never touch CorpusStore's dims guard.
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
      sources: SOURCES,
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

  it('fuses semantic and lexical legs with production fuseRanks', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-fused-'));
    await mkdir(path.join(vaultRoot, 'Notes'), { recursive: true });
    // lexical-only hit: matches the query text, has no vector in SOURCES
    await writeFile(
      path.join(vaultRoot, 'Notes/lexical-hit.md'),
      '# quirkyterm\nquirkyterm body\n',
    );
    await writeFile(path.join(vaultRoot, 'a.md'), '# alpha\nunrelated text\n');
    const fusedContext = await createFusedContext(vaultRoot);
    const ranked = await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      queryVector: QUERY_VECTOR,
      sources: SOURCES,
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
});

describe('bestRelevantSimilarity', () => {
  it('reaches relevant notes outside the top list', () => {
    const sources = new Map([
      ['far.md', { path: 'far.md', embedding: new Float32Array([0.6, 0.8]), blocks: [] }],
      ['near.md', { path: 'near.md', embedding: new Float32Array([1, 0]), blocks: [] }],
    ]);
    expect(bestRelevantSimilarity([1, 0], ['far.md', 'gone.md'], sources)).toBeCloseTo(0.6);
    expect(bestRelevantSimilarity([1, 0], ['gone.md'], sources)).toBeNull();
  });
});

describe('evalConfig', () => {
  it('records every knob the run used', () => {
    expect(evalConfig(TEST_SIMILARITY)).toMatchObject({
      top_k: 10,
      semantic_threshold: 0,
      semantic_pool: 8,
      expansion_limit: 3,
      expansion_floor: 0.35,
      lexical_note_cap: 10,
      lexical_per_note_cap: 3,
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
