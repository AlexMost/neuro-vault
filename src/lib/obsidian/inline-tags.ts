import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Parent } from 'mdast';

/**
 * Obsidian-documented tag grammar: `#` preceded by start-of-text or
 * whitespace, tag characters restricted to `[A-Za-z0-9_/-]`. The ≥1
 * non-numeric-character rule is enforced separately below.
 */
const TAG_PATTERN = /(?<=^|\s)#([A-Za-z0-9_/-]+)/g;

/** A tag must contain at least one non-numeric character (`#123` is not a tag). */
const NON_NUMERIC = /[A-Za-z_/-]/;

/** Node types whose text must never yield tags (code fences, indented code, inline code). */
const SKIPPED_TYPES = new Set(['code', 'inlineCode']);

/**
 * Extract inline `#tags` from a markdown body, deduped, without the leading
 * `#`. Walks the mdast tree so code is excluded structurally; heading markers
 * never appear in text nodes, so `## Heading` cannot match while a literal
 * `#tag` inside heading text still does (Obsidian behavior).
 */
export function extractInlineTags(body: string): string[] {
  if (body === '') return [];
  const tags = new Set<string>();
  const visit = (node: Nodes): void => {
    if (SKIPPED_TYPES.has(node.type)) return;
    if (node.type === 'text') {
      for (const match of node.value.matchAll(TAG_PATTERN)) {
        const tag = match[1] as string;
        if (NON_NUMERIC.test(tag)) tags.add(tag);
      }
      return;
    }
    if ('children' in node) {
      for (const child of (node as Parent).children) visit(child as Nodes);
    }
  };
  visit(fromMarkdown(body));
  return [...tags];
}
