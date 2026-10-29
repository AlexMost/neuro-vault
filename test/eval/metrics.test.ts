import { describe, expect, it } from 'vitest';
import type { GoldenEntry, Lang, QueryClass } from '../../eval/golden.js';
import { aggregate, computeCoverage, legDiagnostics, scoreQuery } from '../../eval/metrics.js';
import type { RankedPath } from '../../eval/pipelines.js';

const entry = (
  id: string,
  lang: Lang,
  relevant: string[],
  cls: QueryClass = relevant.length === 0 ? 'control' : 'concept',
): GoldenEntry => ({ id, query: id, class: cls, lang, relevant });

// Scores are irrelevant to rank metrics; a descending ladder keeps fixtures readable.
const ranked = (paths: string[]) => paths.map((path, i) => ({ path, score: 1 - i / 100 }));

describe('scoreQuery', () => {
  it('relevant ranked third → 1/3 RR, hit@3', () => {
    const s = scoreQuery(
      entry('q1', 'en', ['c.md']),
      ranked(['a.md', 'b.md', 'c.md', 'd.md']),
      null,
    );
    expect(s.first_relevant_rank).toBe(3);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 3);
    expect(s.hit_at_3).toBe(true);
    expect(s.recall_at_10).toBe(1);
  });

  it('no relevant in top-10 → zeros, rank null', () => {
    const s = scoreQuery(entry('q2', 'ua', ['zzz.md']), ranked(['a.md', 'b.md']), null);
    expect(s.first_relevant_rank).toBeNull();
    expect(s.reciprocal_rank).toBe(0);
    expect(s.hit_at_3).toBe(false);
    expect(s.recall_at_10).toBe(0);
  });

  it('relevant ranked fourth → miss for hit@3, RR 1/4', () => {
    const s = scoreQuery(
      entry('q4', 'en', ['d.md']),
      ranked(['a.md', 'b.md', 'c.md', 'd.md']),
      null,
    );
    expect(s.hit_at_3).toBe(false);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 4);
  });

  it('recall@10 is the share of relevant notes inside the top-10', () => {
    const top = ranked(Array.from({ length: 12 }, (_, i) => `n${i + 1}.md`));
    // n2 in, n11 past the cut, gone.md never ranked.
    const s = scoreQuery(entry('q5', 'en', ['n2.md', 'n11.md', 'gone.md']), top, null);
    expect(s.recall_at_10).toBeCloseTo(1 / 3);
    expect(s.relevant_ranks).toEqual([2, 11]);
  });

  it('a control entry carries no answerable metrics, only what it returned', () => {
    const s = scoreQuery(entry('c1', 'ua', []), ranked(['a.md', 'b.md']), null);
    expect(s).toMatchObject({
      class: 'control',
      result_count: 2,
      reciprocal_rank: null,
      hit_at_3: null,
      recall_at_10: null,
    });
  });

  it('keeps an array query as authored', () => {
    const e: GoldenEntry = { ...entry('q6', 'mixed', ['a.md']), query: ['вектор', 'vector'] };
    expect(scoreQuery(e, ranked(['a.md']), null).query).toEqual(['вектор', 'vector']);
  });

  it('records the legs behind each returned note when the pipeline reports them', () => {
    const legs: RankedPath[] = [
      { path: 'a.md', score: 0.2, found_in: ['semantic', 'lexical'] },
      { path: 'b.md', score: 0.1, found_in: ['expansion'] },
    ];
    expect(scoreQuery(entry('q7', 'en', ['a.md']), legs, null).top_found_in).toEqual([
      ['semantic', 'lexical'],
      ['expansion'],
    ]);
    expect(scoreQuery(entry('q8', 'en', ['a.md']), ranked(['a.md']), null)).not.toHaveProperty(
      'top_found_in',
    );
  });
});

describe('scoreQuery records the evidence behind a ranking', () => {
  it('records the score each path was ranked by and every relevant rank', () => {
    const score = scoreQuery(
      entry('q1', 'en', ['b.md', 'd.md']),
      [
        { path: 'a.md', score: 0.9 },
        { path: 'b.md', score: 0.8 },
        { path: 'c.md', score: 0.7 },
        { path: 'd.md', score: 0.6 },
      ],
      0.81,
    );
    expect(score.top).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(score.top_scores).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(score.relevant_ranks).toEqual([2, 4]);
    expect(score.best_relevant_similarity).toBe(0.81);
    expect(score.first_relevant_rank).toBe(2);
  });
});

describe('aggregate', () => {
  it('averages per slice; slices partition by lang', () => {
    const scores = [
      scoreQuery(entry('u1', 'ua', ['a.md']), ranked(['a.md']), null), // RR 1, hit
      scoreQuery(entry('u2', 'ua', ['b.md']), ranked(['x.md']), null), // RR 0, miss
      scoreQuery(entry('e1', 'en', ['c.md']), ranked(['x.md', 'c.md']), null), // RR 1/2, hit
    ];
    const m = aggregate(scores);
    expect(m.overall.n).toBe(3);
    expect(m.lang.ua.n).toBe(2);
    expect(m.lang.en.n).toBe(1);
    expect(m.lang.ua.mrr).toBeCloseTo(0.5);
    expect(m.lang.ua.hit_at_3).toBeCloseTo(0.5);
    expect(m.lang.en.mrr).toBeCloseTo(0.5);
    expect(m.overall.mrr).toBeCloseTo((1 + 0 + 0.5) / 3);
    expect(m.overall.recall_at_10).toBeCloseTo(2 / 3);
  });

  it('an empty slice reports n 0 and null metrics', () => {
    const m = aggregate([scoreQuery(entry('u1', 'ua', ['a.md']), ranked(['a.md']), null)]);
    expect(m.lang.mixed).toEqual({
      n: 0,
      answerable: 0,
      mrr: null,
      hit_at_3: null,
      recall_at_10: null,
      controls: 0,
      control_hit_rate: null,
      control_mean_results: null,
    });
  });

  it('scores control entries for noise and keeps them out of the ranking metrics', () => {
    const m = aggregate([
      scoreQuery(entry('a1', 'ua', ['a.md']), ranked(['a.md']), null),
      scoreQuery(entry('c1', 'ua', []), ranked(['x.md', 'y.md', 'z.md']), null),
      scoreQuery(entry('c2', 'en', []), [], null),
    ]);
    expect(m.overall).toMatchObject({
      n: 3,
      answerable: 1,
      mrr: 1,
      hit_at_3: 1,
      controls: 2,
      control_hit_rate: 0.5,
      control_mean_results: 1.5,
    });
    expect(m.class.control).toMatchObject({ answerable: 0, mrr: null, controls: 2 });
    expect(m.class.concept).toMatchObject({ answerable: 1, controls: 0, control_hit_rate: null });
  });

  it('slices by class and by class × lang, keeping only the cells the set holds', () => {
    const m = aggregate([
      scoreQuery(entry('n1', 'ua', ['a.md'], 'name'), ranked(['a.md']), null),
      scoreQuery(entry('n2', 'mixed', ['a.md'], 'name'), ranked(['x.md']), null),
      scoreQuery(entry('s1', 'en', ['a.md'], 'single_token'), ranked(['a.md']), null),
    ]);
    expect(m.class.name.n).toBe(2);
    expect(m.class.single_token.n).toBe(1);
    expect(Object.keys(m.class_lang).sort()).toEqual(['name/mixed', 'name/ua', 'single_token/en']);
    expect(m.class_lang['name/mixed'].hit_at_3).toBe(0);
  });
});

describe('legDiagnostics', () => {
  it('counts the returned notes per leg, semantic-only apart, answerable and control apart', () => {
    const scores = [
      scoreQuery(
        entry('a1', 'en', ['a.md', 'c.md']),
        [
          { path: 'a.md', score: 0.3, found_in: ['semantic'] },
          { path: 'b.md', score: 0.2, found_in: ['semantic', 'lexical'] },
          { path: 'c.md', score: 0.1, found_in: ['expansion'] },
        ],
        null,
      ),
      scoreQuery(
        entry('c1', 'en', []),
        [{ path: 'x.md', score: 0.1, found_in: ['semantic'] }],
        null,
      ),
    ];
    expect(legDiagnostics(scores)).toEqual({
      answerable: {
        returned: 3,
        semantic_only: 1,
        semantic: 2,
        lexical: 1,
        expansion: 1,
        relevant: 2,
        relevant_semantic_only: 1,
      },
      control: {
        returned: 1,
        semantic_only: 1,
        semantic: 1,
        lexical: 0,
        expansion: 0,
        relevant: 0,
        relevant_semantic_only: 0,
      },
    });
  });
});

describe('computeCoverage', () => {
  it('counts indexed relevant paths, unwinnable entries and stale corpus paths', () => {
    const coverage = computeCoverage({
      entries: [
        entry('ok', 'en', ['a.md', 'b.md']),
        entry('lost', 'en', ['b.md']), // b.md has no vector
        entry('ctl', 'en', []), // a control is never unwinnable
      ],
      indexed: new Set(['a.md', 'gone.md']),
      corpusPaths: ['a.md', 'b.md', 'gone.md'],
      vaultPaths: new Set(['a.md', 'b.md']),
    });
    expect(coverage).toEqual({
      relevant_paths_total: 3,
      relevant_paths_indexed: 1,
      entries_unwinnable: 1,
      unwinnable_ids: ['lost'],
      corpus_stale_paths: 1,
    });
  });
});
