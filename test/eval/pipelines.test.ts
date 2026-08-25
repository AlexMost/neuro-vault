import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SmartSource } from '../../src/lib/obsidian/corpus/types.js';
import { EVAL_CONFIG, EVAL_TOP_K, createFusedContext, rankQuery } from '../../eval/pipelines.js';

// 3-dim vectors are fine here: pipelines never touch CorpusStore's dims guard.
function src(p: string, v: number[]): [string, SmartSource] {
  return [p, { path: p, embedding: v, blocks: [] }];
}

const SOURCES = new Map<string, SmartSource>([
  src('a.md', [1, 0, 0]),
  src('b.md', [0.9, 0.1, 0]),
  src('c.md', [0, 1, 0]),
]);
const embed = (_text: string): Promise<number[]> => Promise.resolve([1, 0, 0]);

describe('semantic pipeline', () => {
  it('ranks by cosine at threshold 0 and caps at top-10', async () => {
    const top = await rankQuery({ pipeline: 'semantic', query: 'q', sources: SOURCES, embed });
    expect(top[0]).toBe('a.md');
    expect(top[1]).toBe('b.md');
    // threshold 0: even the orthogonal note appears — positions only.
    expect(top).toContain('c.md');
    expect(top.length).toBeLessThanOrEqual(EVAL_TOP_K);
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
    const top = await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      sources: SOURCES,
      embed,
      fusedContext,
    });
    // The lexical leg surfaced a note the semantic leg cannot know about —
    // the fused list carries it (the Moby-case mechanism, RRF fusion).
    expect(top).toContain('Notes/lexical-hit.md');
    // Semantic leg still contributes its threshold-0 ranking.
    expect(top).toContain('a.md');
  });
});

describe('EVAL_CONFIG', () => {
  it('records every knob the run used', () => {
    expect(EVAL_CONFIG).toMatchObject({
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
});
