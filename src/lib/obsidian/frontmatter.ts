import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

/**
 * Serialize a frontmatter object to a fenced YAML block: `---\n…\n---\n`.
 * Inverse of {@link splitFrontmatter}. `yaml.stringify` quotes flow-sequence-
 * leading strings (e.g. `[[wikilink]]`), keeps `YYYY-MM-DD` dates as plain
 * scalars, and renders arrays as block lists. Callers must not pass `{}` — the
 * empty-object case is handled by the caller (the create_note tool treats an
 * empty object as "no frontmatter").
 */
export function serializeFrontmatter(fm: Record<string, unknown>): string {
  return `---\n${stringifyYaml(fm)}---\n`;
}
