const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

export function parseWikilinks(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    out.push(match[1]);
  }
  return out;
}

export function normalizeWikilinkTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const hashIdx = trimmed.indexOf('#');
  const pipeIdx = trimmed.indexOf('|');
  const cutCandidates = [hashIdx, pipeIdx].filter((i) => i >= 0);
  if (cutCandidates.length === 0) return trimmed;
  const cut = Math.min(...cutCandidates);
  return trimmed.slice(0, cut).trim();
}
