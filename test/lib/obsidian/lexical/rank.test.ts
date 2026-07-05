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
    expect(ranked[0]!.matches[0]!.matched_in).toBe('title');
    expect(ranked[1]!.matches[0]!.matched_in).toBe('heading');
    expect(ranked[2]!.matches[0]!.matched_in).toBe('body');
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
    expect(ranked[0]!.matches).toHaveLength(3); // capped, best tiers first
    expect(ranked[0]!.matches[0]!.matched_in).toBe('title');
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
    const body = ranked[0]!.matches.find((m) => m.matched_in === 'body')!;
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
});
