import { parse as parseYaml } from 'yaml';

import { splitRawFrontmatter } from './in-place-edit.js';

export interface SplitResult {
  frontmatter: Record<string, unknown> | null;
  content: string;
}

export function splitFrontmatter(raw: string): SplitResult {
  const { prefix, body } = splitRawFrontmatter(raw);
  if (prefix === '') {
    return { frontmatter: null, content: raw };
  }

  // Strip the opening "---" line and closing "---" line from the prefix to get
  // just the YAML body. The prefix is `---<eol>...---<eol>`.
  const firstEol = prefix.indexOf('\n');
  const yamlStart = firstEol + 1;
  const lastFence = prefix.lastIndexOf('---');
  const yamlBody = prefix.slice(yamlStart, lastFence);
  const content = body;

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
