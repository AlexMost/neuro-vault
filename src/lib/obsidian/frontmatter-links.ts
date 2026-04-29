import { parseWikilinks } from './wikilink.js';

export function extractWikilinksFromFrontmatter(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  walk(fm, out);
  return out;
}

function walk(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    for (const target of parseWikilinks(value)) {
      out.push(target);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      walk(child, out);
    }
  }
}
