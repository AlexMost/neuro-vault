import { describe, expect, it } from 'vitest';

import { parseNote } from '../../../../src/lib/obsidian/lexical/blocks.js';
import { rankNotes } from '../../../../src/lib/obsidian/lexical/rank.js';

// Pins the snippet / lines / heading output of a match whose normalized offset
// differs from its raw offset: NFKD expansion (ﬁ, ½), stripped combining marks,
// surrogate pairs, collapsed whitespace runs and mixed case before the match.
const prefix = 'ЗАГАЛЬНИЙ Résumé ﬁle ½ 🐍🐍 NAÏVE   café\t\tЗ’ясувати '.repeat(4);
const suffix = ' кінець Ünïcödé 🐍 '.repeat(8);
const body = [
  '# Вступ',
  '',
  `${prefix}ПОШУК Розумний${suffix}`,
  '',
  '## Деталі',
  '',
  'короткий пошук',
  '',
].join('\n');

function rank(queries: string[]) {
  const notes = new Map([['Нотатка.md', parseNote({ path: 'Нотатка.md', body, lineOffset: 3 })]]);
  return rankNotes({
    notes,
    queries,
    noteCap: 10,
    perNoteCap: 5,
    getBacklinkCount: () => 0,
  }).notes[0].matches;
}

describe('rankNotes snippets on shifted offsets', () => {
  it('windows a long body paragraph around a phrase match', () => {
    expect(rank(['пошук розумний'])).toEqual([
      {
        matched_in: 'body',
        snippet:
          '…З’ясувати ЗАГАЛЬНИЙ Résumé ﬁle ½ 🐍🐍 NAÏVE   café\t\tЗ’ясувати ПОШУК Розумний кінець Ünïcödé 🐍  кінець Ünïcödé 🐍  кінець Ünïcödé 🐍  кінець Ünïcödé 🐍  кін…',
        lines: [6, 6],
        heading: 'Вступ',
      },
    ]);
  });

  it('windows around the first token of an all-token match', () => {
    expect(rank(['naive resume'])).toEqual([
      {
        matched_in: 'body',
        snippet:
          'ЗАГАЛЬНИЙ Résumé ﬁle ½ 🐍🐍 NAÏVE   café\t\tЗ’ясувати ЗАГАЛЬНИЙ Résumé ﬁle ½ 🐍🐍 NAÏVE   café…',
        lines: [6, 6],
        heading: 'Вступ',
      },
    ]);
  });

  it('keeps short units whole and reports lines and heading', () => {
    expect(rank(['пошук'])).toEqual([
      { matched_in: 'body', snippet: 'короткий пошук', lines: [10, 10], heading: 'Деталі' },
      {
        matched_in: 'body',
        snippet:
          '…fé\t\tЗ’ясувати ЗАГАЛЬНИЙ Résumé ﬁle ½ 🐍🐍 NAÏVE   café\t\tЗ’ясувати ПОШУК Розумний кінець Ünïcödé 🐍  кінець Ünïcödé 🐍  кінець Ünïcödé 🐍  кінець Ünïcödé 🐍…',
        lines: [6, 6],
        heading: 'Вступ',
      },
    ]);
  });
});
