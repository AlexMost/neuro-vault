const WINDOW = 150;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * ~150-char grapheme-safe window around the first match, projected from
 * normalized-match coordinates back onto the raw text via the offset map.
 */
export function makeSnippet(
  raw: string,
  map: number[],
  normStart: number,
  normLen: number,
  window = WINDOW,
): string {
  if (raw.length <= window) return raw;

  const rawStart = map[Math.min(normStart, map.length - 1)] ?? 0;
  const rawEnd = map[Math.min(normStart + Math.max(normLen - 1, 0), map.length - 1)] ?? rawStart;

  const graphemes = [...segmenter.segment(raw)]; // { segment, index }
  const startG = graphemes.findIndex((g) => g.index + g.segment.length > rawStart);
  const endG = graphemes.findIndex((g) => g.index + g.segment.length > rawEnd);
  const matchSpan = Math.max(endG - startG + 1, 1);
  const pad = Math.max(Math.floor((window - matchSpan) / 2), 0);

  const from = Math.max(startG - pad, 0);
  const to = Math.min(endG + pad, graphemes.length - 1);
  const slice = graphemes
    .slice(from, to + 1)
    .map((g) => g.segment)
    .join('');

  return `${from > 0 ? '…' : ''}${slice.trim()}${to < graphemes.length - 1 ? '…' : ''}`;
}
