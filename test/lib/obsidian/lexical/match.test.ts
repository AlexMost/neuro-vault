import { describe, expect, it } from 'vitest';

import { matchUnit } from '../../../../src/lib/obsidian/lexical/match.js';

describe('matchUnit word-prefix rule', () => {
  it('matches a stem at the start of an inflected word', () => {
    expect(matchUnit('пошуком у vault', 'пошук', ['пошук'])).toMatchObject({ firstIndex: 0 });
  });

  it('does not match a token inside a longer word', () => {
    expect(matchUnit('rapid growth', 'api', ['api'])).toBeNull();
  });

  it('treats _ and the apostrophe as word characters', () => {
    expect(matchUnit('tolerant_arguments', 'arguments', ['arguments'])).toBeNull();
    expect(matchUnit("об'єкт", 'єкт', ['єкт'])).toBeNull();
  });

  it('treats a hyphen as a boundary', () => {
    expect(
      matchUnit('tolerant-arguments', 'tolerant arguments', ['tolerant', 'arguments']),
    ).toMatchObject({ phrase: false });
  });

  it('skips an in-word occurrence and points at the one at a word start', () => {
    expect(matchUnit('rapid api', 'api', ['api'])).toMatchObject({ phrase: true, firstIndex: 6 });
    expect(
      matchUnit('xvector search, vector search', 'vector search', ['vector', 'search']),
    ).toMatchObject({ phrase: true, firstIndex: 16 });
  });

  it('treats an opening single quote as a boundary', () => {
    expect(matchUnit("he said 'vector' search", 'vector', ['vector'])).toMatchObject({
      firstIndex: 9,
    });
    expect(matchUnit("'пошук' тут", 'пошук', ['пошук'])).toMatchObject({ firstIndex: 1 });
    expect(matchUnit("o'brien", 'brien', ['brien'])).toBeNull();
  });

  it('counts a letter outside the BMP as a word character', () => {
    expect(matchUnit('\u{1D400}api', 'api', ['api'])).toBeNull();
  });

  it('reads a lone low surrogate as no word character', () => {
    expect(matchUnit('a\udc00api', 'api', ['api'])).not.toBeNull();
  });

  it('needs no boundary for a token that starts with neither a letter nor a digit', () => {
    expect(matchUnit('v2/api/notes', '/api', ['/api'])).not.toBeNull();
    expect(matchUnit('x.env', '.env', ['.env'])).not.toBeNull();
    expect(matchUnit("rock'n'roll", "'n", ["'n"])).not.toBeNull();
  });

  it('still needs every token', () => {
    expect(matchUnit('vector db', 'vector search', ['vector', 'search'])).toBeNull();
  });
});
