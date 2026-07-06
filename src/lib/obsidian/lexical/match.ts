export interface UnitHit {
  phrase: boolean;
  density: number; // matched chars / unit length, capped at 1
  firstIndex: number; // index of first match in the NORMALIZED unit
  matchLen: number; // normalized length of the phrase (or first token) matched
}

export function matchUnit(normUnit: string, normQuery: string, tokens: string[]): UnitHit | null {
  if (tokens.length === 0 || normUnit.length === 0) return null;

  const phraseIdx = normUnit.indexOf(normQuery);
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
    const idx = normUnit.indexOf(token);
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
