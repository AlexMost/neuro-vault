import { describe, expect, it } from 'vitest';

import {
  normalizeText,
  normalizeWithMap,
  tokenizeQuery,
} from '../../../../src/lib/obsidian/lexical/normalize.js';

describe('normalizeText', () => {
  it('lowercases Latin and Cyrillic', () => {
    expect(normalizeText('ПОШУК MCP')).toBe('пошук mcp');
  });

  it('strips combining marks via NFKD (accent-insensitive)', () => {
    expect(normalizeText('résumé')).toBe('resume');
  });

  it('folds й→и and ї→і (deliberate recall bias)', () => {
    expect(normalizeText('йога її')).toBe('иога іі');
  });

  it('does NOT merge і and и', () => {
    expect(normalizeText('і')).not.toBe(normalizeText('и'));
  });

  it('unifies apostrophe variants to U+0027', () => {
    // Input variants with different apostrophes
    const variant1 = `об'єкт`; // U+0027 standard
    const variant2 = `обʼєкт`; // U+02BC modifier
    const variant3 = `об‘єкт`; // U+2018 left quote
    const variant4 = `об’єкт`; // U+2019 right quote
    const expected = `об'єкт`; // U+0027 expected output

    for (const s of [variant1, variant2, variant3, variant4]) {
      expect(normalizeText(s)).toBe(expected);
    }
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a\t\tb \n c  ')).toBe('a b c');
  });
});

describe('normalizeWithMap', () => {
  it('maps normalized indices back to raw indices', () => {
    const raw = `Об’єкт X`;
    const { norm, map } = normalizeWithMap(raw);
    expect(norm).toBe(`об'єкт x`);
    // norm[0] 'о' came from raw[0] 'О'
    expect(map[0]).toBe(0);
    // norm index of 'x' maps to raw index of 'X'
    expect(raw[map[norm.indexOf('x')]!]).toBe('X');
  });
});

describe('tokenizeQuery', () => {
  it('splits on whitespace, keeps punctuation inside tokens', () => {
    expect(tokenizeQuery('  Tolerant-Arguments  spec ')).toEqual(['tolerant-arguments', 'spec']);
  });

  it('returns [] for blank input', () => {
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});
