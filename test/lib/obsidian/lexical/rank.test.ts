import { describe, expect, it } from 'vitest';

import { parseNote } from '../../../../src/lib/obsidian/lexical/blocks.js';
import { rankNotes } from '../../../../src/lib/obsidian/lexical/rank.js';

function notes(entries: Array<[string, string]>) {
  return new Map(entries.map(([p, body]) => [p, parseNote({ path: p, body, lineOffset: 0 })]));
}

const noBacklinks = () => 0;

describe('rankNotes', () => {
  it('title match outranks heading match outranks body match', () => {
    const map = notes([
      ['c-body.md', 'десь тут пошук у тексті\n'],
      ['a-пошук.md', ''],
      ['b-head.md', '# пошук\n'],
    ]);
    // rename a-пошук.md so its TITLE matches:
    map.set('Пошук.md', parseNote({ path: 'Пошук.md', body: '', lineOffset: 0 }));
    map.delete('a-пошук.md');
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['Пошук.md', 'b-head.md', 'c-body.md']);
    expect(ranked[0].matches[0].matched_in).toBe('title');
    expect(ranked[1].matches[0].matched_in).toBe('heading');
    expect(ranked[2].matches[0].matched_in).toBe('body');
  });

  it('density breaks ties within a tier', () => {
    const map = notes([
      ['Довгі роздуми про пошук сенсу.md', ''],
      ['Пошук.md', ''],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['Пошук.md', 'Довгі роздуми про пошук сенсу.md']);
  });

  it('phrase beats AND-tokens in the same unit kind', () => {
    const map = notes([
      ['tokens.md', '# пошук векторний та інше\n'],
      ['phrase.md', '# векторний пошук\n'],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['векторний пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['phrase.md', 'tokens.md']);
  });

  it('groups all evidence of one note under matches[] with per-note cap', () => {
    const body = [
      '# пошук',
      '',
      'пошук раз.',
      '',
      'пошук два.',
      '',
      'пошук три.',
      '',
      'пошук чотири.',
      '',
    ].join('\n');
    const map = notes([['Пошук.md', body]]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches).toHaveLength(3); // capped, best tiers first
    expect(ranked[0].matches[0].matched_in).toBe('title');
  });

  it('body match carries section heading and lines', () => {
    const map = notes([['n.md', '# Рішення\n\nтут пошук живе.\n']]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    const body = ranked[0].matches.find((m) => m.matched_in === 'body')!;
    expect(body.heading).toBe('Рішення');
    expect(body.lines).toEqual([3, 3]);
  });

  it('global cap truncates and reports truncated', () => {
    const map = notes([
      ['a пошук.md', ''],
      ['b пошук.md', ''],
      ['c пошук.md', ''],
    ]);
    const res = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 2,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(res.notes).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('multi-query merges with matchedQueries annotation', () => {
    const map = notes([
      ['Vector search.md', ''],
      ['Векторний пошук.md', ''],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['vector search', 'векторний пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(2);
    for (const n of ranked) expect(n.matchedQueries).toHaveLength(1);
  });

  describe('query variants fuse by weighted reciprocal rank', () => {
    const rank = (map: ReturnType<typeof notes>, queries: string[], noteCap = 10) =>
      rankNotes({
        notes: map,
        queries,
        noteCap,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      }).notes.map((n) => n.path);

    it('a single query ranks by tier, density, backlinks, then path, as before', () => {
      const map = notes([
        ['b.md', '# трейдинг\n'],
        ['a.md', '# трейдинг\n'],
        ['c.md', '# трейдинг\n'],
        ['Трейдинг.md', ''],
        ['d.md', 'трейдинг у тексті\n'],
      ]);
      const backlinks = (p: string) => (p === 'c.md' ? 2 : 0);
      const ranked = rankNotes({
        notes: map,
        queries: ['трейдинг'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: backlinks,
      }).notes.map((n) => n.path);
      expect(ranked).toEqual(['Трейдинг.md', 'c.md', 'a.md', 'b.md', 'd.md']);
    });

    it('does not depend on the order notes were read in', () => {
      const entries: Array<[string, string]> = [
        ['Метрики A.md', ''],
        ['x.md', 'тут згадано трейдинг\n'],
        ['y.md', '# метрики і трейдинг\n'],
        ['z.md', 'метрики\n'],
      ];
      const forward = rank(notes(entries), ['трейдинг', 'метрики']);
      expect(rank(notes([...entries].reverse()), ['трейдинг', 'метрики'])).toEqual(forward);
    });

    it('breaks an exact fused tie by the single-list order', () => {
      // Rank 1 under weight 0.5 and rank 7 under weight 1 both score 1/12 at k = 5.
      const filler = Array.from(
        { length: 6 },
        (_, i) => [`f${i}.md`, '# альфа\n'] as [string, string],
      );
      const map = notes([...filler, ['body.md', 'альфа в тексті\n'], ['Бета.md', '']]);
      const ranked = rank(map, ['альфа', 'бета']);
      // body.md is 7th for "альфа"; Бета.md is 1st for "бета", a title hit, so it wins the tie.
      expect(ranked.indexOf('Бета.md')).toBeLessThan(ranked.indexOf('body.md'));
      expect(ranked.indexOf('body.md')).toBe(ranked.indexOf('Бета.md') + 1);
    });

    it("a broad variant's title hits cannot crowd the first variant's body hits out of the pool", () => {
      const map = notes([
        ['Метрики A.md', ''],
        ['Метрики B.md', ''],
        ['Метрики C.md', ''],
        ['x.md', 'тут згадано трейдинг\n'],
        ['y.md', 'ще раз трейдинг у тексті абзацу\n'],
      ]);
      // One shared tier sort would take the three title hits first.
      expect(rank(map, ['трейдинг', 'метрики'], 2)).toEqual(['x.md', 'y.md']);
    });

    it('weighs the first variant above the others at the same rank', () => {
      const map = notes([
        ['a.md', '# альфа\n'],
        ['b.md', '# бета\n'],
      ]);
      expect(rank(map, ['бета', 'альфа'])).toEqual(['b.md', 'a.md']);
      expect(rank(map, ['альфа', 'бета'])).toEqual(['a.md', 'b.md']);
    });

    it('a note several variants match outranks one matched by a single variant', () => {
      const map = notes([
        ['solo.md', '# трейдинг\n'],
        ['both.md', 'трейдинг і біржа в одному абзаці, досить довгому, щоб знизити щільність\n'],
        ['other.md', '# біржа\n'],
      ]);
      expect(rank(map, ['трейдинг', 'біржа'])[0]).toBe('both.md');
    });

    it('leaves matchedQueries and per-query counts as they were', () => {
      const map = notes([
        ['x.md', 'трейдинг\n'],
        ['Метрики.md', 'трейдинг\n'],
      ]);
      const out = rankNotes({
        notes: map,
        queries: ['трейдинг', 'метрики'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(out.perQueryCounts).toEqual({ трейдинг: 2, метрики: 1 });
      expect(out.notes.find((n) => n.path === 'Метрики.md')?.matchedQueries.sort()).toEqual(
        ['метрики', 'трейдинг'].sort(),
      );
    });
  });

  it('a phrase split across a hard-wrapped line still matches as one body unit at the paragraph line range', () => {
    const map = notes([['n.md', 'векторний\nпошук у vault\n']]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['векторний пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches[0]).toMatchObject({ matched_in: 'body', lines: [1, 2] });
  });

  it('a heading-looking line inside a fenced code block matches as body, not heading', () => {
    const map = notes([['n.md', '```\n# пошук\n```\n']]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches[0].matched_in).toBe('body');
  });

  it('inflected forms match by word prefix (heading пошуком matches query пошук)', () => {
    const map = notes([['n.md', '# розмова про пошуком\n']]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches[0].matched_in).toBe('heading');
  });

  it('an in-word occurrence is no candidate', () => {
    const { notes: ranked, perQueryCounts } = rankNotes({
      notes: notes([['n.md', 'rapid growth\n']]),
      queries: ['api'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toEqual([]);
    expect(perQueryCounts).toEqual({ api: 0 });
  });

  it('a drawing payload is neither matched nor counted', () => {
    const body = '## Drawing\n```compressed-json\nn4kak api\n```\n';
    const { notes: ranked, perQueryCounts } = rankNotes({
      notes: notes([['d.excalidraw.md', body]]),
      queries: ['n4kak'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toEqual([]);
    expect(perQueryCounts).toEqual({ n4kak: 0 });
  });

  it('reports per-query candidate counts before the note cap', () => {
    const map = notes([
      ['a пошук.md', ''],
      ['b пошук.md', ''],
      ['c пошук.md', ''],
      ['retrieval.md', ''],
    ]);
    const { notes: ranked, perQueryCounts } = rankNotes({
      notes: map,
      queries: ['пошук', 'retrieval', 'відсутнє'],
      noteCap: 1,
      perNoteCap: 3,
      getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1); // cap applied to the list…
    expect(perQueryCounts).toEqual({ пошук: 3, retrieval: 1, відсутнє: 0 }); // …not to the counts
  });

  it('is deterministic: backlink desc then path asc as final tie-breaks', () => {
    const map = notes([
      ['b пошук тут.md', ''],
      ['a пошук тут.md', ''],
    ]);
    const backlinks = (p: string) => (p.startsWith('b') ? 5 : 0);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['пошук'],
      noteCap: 10,
      perNoteCap: 3,
      getBacklinkCount: backlinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['b пошук тут.md', 'a пошук тут.md']);
  });

  describe('perQueryTokenCounts', () => {
    it('reports per-token note counts for an AND-killed multi-token query', () => {
      const map = notes([
        ['Копірайт-ревізія алертів.md', 'нотатка про алертів і їх ревізію\n'],
        ['Інша нотатка.md', 'нічого дотичного\n'],
      ]);
      const { perQueryCounts, perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['ретеншн алертів'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryCounts['ретеншн алертів']).toBe(0);
      expect(perQueryTokenCounts['ретеншн алертів']).toEqual({
        ретеншн: 0,
        алертів: 1,
      });
    });

    it('counts a token only where it starts a word', () => {
      const { perQueryTokenCounts } = rankNotes({
        notes: notes([
          ['a.md', 'rapid api\n'],
          ['b.md', 'rapid\n'],
        ]),
        queries: ['api zzz'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts['api zzz']).toEqual({ api: 1, zzz: 0 });
    });

    it('has no entry for a single-token dead query', () => {
      const map = notes([['Пошук.md', '']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['нема'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts).toEqual({});
    });

    it('has no entry for a matching multi-token query', () => {
      const map = notes([['phrase.md', '# векторний пошук\n']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['векторний пошук'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts).toEqual({});
    });

    it('counts a note once per token even when the token hits several units', () => {
      const map = notes([['multi.md', '# алертів\n\nще раз алертів у тілі\n']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['ретеншн алертів'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts['ретеншн алертів']).toEqual({ ретеншн: 0, алертів: 1 });
    });

    it('counts a note once per token even when the query repeats a token', () => {
      const map = notes([['multi.md', 'тут є алертів\n']]);
      const { perQueryTokenCounts } = rankNotes({
        notes: map,
        queries: ['алертів алертів ретеншн'],
        noteCap: 10,
        perNoteCap: 3,
        getBacklinkCount: noBacklinks,
      });
      expect(perQueryTokenCounts['алертів алертів ретеншн']).toEqual({
        алертів: 1,
        ретеншн: 0,
      });
    });
  });
});
