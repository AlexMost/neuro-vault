export interface UnitHit {
  phrase: boolean;
  density: number; // matched chars / unit length, capped at 1
  firstIndex: number; // index of first match in the NORMALIZED unit
  matchLen: number; // normalized length of the phrase (or first token) matched
}

const WORD_CHAR = /^[\p{L}\p{N}_]$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

// Start index of the code point that ends at `end`, stepping back over a
// surrogate pair so a non-BMP letter reads as a letter.
function codePointStartBefore(unit: string, end: number): number {
  const low = unit.charCodeAt(end - 1);
  const high = unit.charCodeAt(end - 2);
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return pair ? end - 2 : end - 1;
}

// A word character is a letter, digit or `_`; an apostrophe is one only
// inside a word (`об'єкт`), so an opening quote still starts a word.
function endsWithWordChar(unit: string, end: number): boolean {
  if (end <= 0) return false;
  const start = codePointStartBefore(unit, end);
  const ch = unit.slice(start, end);
  return ch === "'" ? endsWithWordChar(unit, start) : WORD_CHAR.test(ch);
}

// First occurrence of `needle` that starts a word: at index 0 or after a
// non-word character. The end is free, so a stem matches its inflections. A
// needle led by punctuation (`/api`, `.env`) is its own boundary.
function indexAtBoundary(unit: string, needle: string): number {
  if (!LETTER_OR_DIGIT.test(needle)) return unit.indexOf(needle);
  for (let i = unit.indexOf(needle); i >= 0; i = unit.indexOf(needle, i + 1)) {
    if (!endsWithWordChar(unit, i)) return i;
  }
  return -1;
}

export function matchUnit(normUnit: string, normQuery: string, tokens: string[]): UnitHit | null {
  if (tokens.length === 0 || normUnit.length === 0) return null;

  const phraseIdx = indexAtBoundary(normUnit, normQuery);
  if (phraseIdx >= 0) {
    return {
      phrase: true,
      density: Math.min(normQuery.length / normUnit.length, 1),
      firstIndex: phraseIdx,
      matchLen: normQuery.length,
    };
  }

  let firstIndex = Number.MAX_SAFE_INTEGER;
  let firstLen = 0;
  let total = 0;
  for (const token of tokens) {
    const idx = indexAtBoundary(normUnit, token);
    if (idx < 0) return null; // AND semantics
    total += token.length;
    if (idx < firstIndex) {
      firstIndex = idx;
      firstLen = token.length;
    }
  }
  return {
    phrase: false,
    density: Math.min(total / normUnit.length, 1),
    firstIndex,
    matchLen: firstLen,
  };
}
