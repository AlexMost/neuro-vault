const APOSTROPHE_VARIANTS = /['ʼ‘’]/;
const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/u;

export interface NormalizedText {
  norm: string;
  /** map[i] = index in the raw string of the character that produced norm[i]. */
  map: number[];
}

/**
 * lowercase → NFKD → strip combining marks → apostrophe unification →
 * whitespace collapse (+ trim). Keeps an offset map so a match position in
 * the normalized text can be projected back onto the raw text for snippets.
 */
export function normalizeWithMap(raw: string): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // swallows leading whitespace
  let rawIndex = 0;

  for (const ch of raw) {
    const decomposed = ch.toLowerCase().normalize('NFKD');
    for (const piece of decomposed) {
      if (COMBINING_MARK.test(piece)) continue;
      if (WHITESPACE.test(piece)) {
        if (!lastWasSpace) {
          out.push(' ');
          map.push(rawIndex);
          lastWasSpace = true;
        }
        continue;
      }
      out.push(APOSTROPHE_VARIANTS.test(piece) ? "'" : piece);
      map.push(rawIndex);
      lastWasSpace = false;
    }
    rawIndex += ch.length;
  }

  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  return { norm: out.join(''), map };
}

export function normalizeText(raw: string): string {
  return normalizeWithMap(raw).norm;
}

export function tokenizeQuery(query: string): string[] {
  const norm = normalizeText(query);
  return norm.length === 0 ? [] : norm.split(' ');
}
