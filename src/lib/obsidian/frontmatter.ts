import { parse as parseYaml } from 'yaml';

export interface SplitResult {
  frontmatter: Record<string, unknown> | null;
  content: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;
// Matches a closing fence either at the start of `afterOpen` (empty YAML body)
// or after a preceding newline.
const FRONTMATTER_CLOSE = /(^|\r?\n)---[ \t]*(\r?\n|$)/;

export function splitFrontmatter(raw: string): SplitResult {
  const openMatch = raw.match(FRONTMATTER_OPEN);
  if (!openMatch) {
    return { frontmatter: null, content: raw };
  }

  const afterOpen = raw.slice(openMatch[0].length);
  const closeMatch = afterOpen.match(FRONTMATTER_CLOSE);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: null, content: raw };
  }

  const yamlBody = afterOpen.slice(0, closeMatch.index);
  const content = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch (err) {
    console.warn(
      `[neuro-vault] frontmatter YAML parse failed: ${(err as Error).message}; returning raw content`,
    );
    return { frontmatter: null, content: raw };
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, content };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `[neuro-vault] frontmatter parsed to non-object (${typeof parsed}); returning raw content`,
    );
    return { frontmatter: null, content: raw };
  }

  return { frontmatter: parsed as Record<string, unknown>, content };
}
