export interface FrontmatterSplit {
  prefix: string; // raw frontmatter slice including both fences and their EOLs, or empty string
  body: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;
// Match a closing fence either at the start of `afterOpen` (empty body) or
// after a preceding newline.
const FRONTMATTER_CLOSE = /(^|\r?\n)---[ \t]*(\r?\n|$)/;

export function splitRawFrontmatter(raw: string): FrontmatterSplit {
  const openMatch = raw.match(FRONTMATTER_OPEN);
  if (!openMatch) {
    return { prefix: '', body: raw };
  }

  const afterOpen = raw.slice(openMatch[0].length);
  const closeMatch = afterOpen.match(FRONTMATTER_CLOSE);
  if (!closeMatch || closeMatch.index === undefined) {
    return { prefix: '', body: raw };
  }

  const prefixLen = openMatch[0].length + closeMatch.index + closeMatch[0].length;
  return {
    prefix: raw.slice(0, prefixLen),
    body: raw.slice(prefixLen),
  };
}
