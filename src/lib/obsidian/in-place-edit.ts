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

export type ApplyReplaceResult =
  | { body: string }
  | { error: 'NOT_FOUND' }
  | { error: 'AMBIGUOUS_MATCH'; lines: number[] };

export function applyReplace(
  body: string,
  find: string,
  replacement: string,
  replaceAll: boolean,
): ApplyReplaceResult {
  if (find === '') {
    // The tool layer rejects empty `find` with INVALID_ARGUMENT before reaching
    // this function. If we somehow get here, treat it as NOT_FOUND rather than
    // matching every position.
    return { error: 'NOT_FOUND' };
  }

  const positions: number[] = [];
  let from = 0;
  while (true) {
    const idx = body.indexOf(find, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + find.length;
  }

  if (positions.length === 0) {
    return { error: 'NOT_FOUND' };
  }

  if (positions.length > 1 && !replaceAll) {
    return { error: 'AMBIGUOUS_MATCH', lines: positions.map((p) => lineNumberAt(body, p)) };
  }

  if (positions.length === 1) {
    const at = positions[0]!;
    return { body: body.slice(0, at) + replacement + body.slice(at + find.length) };
  }

  // replaceAll === true and >1 matches — String.prototype.replaceAll iterates
  // across the original string, never the replacement output.
  return { body: body.replaceAll(find, replacement) };
}

function lineNumberAt(body: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (body.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}
