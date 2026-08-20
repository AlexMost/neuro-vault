import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Parent } from 'mdast';

/**
 * Obsidian-documented tag grammar: tag characters restricted to `[A-Za-z0-9_/-]`,
 * with `#` required to be preceded by start-of-text or whitespace (enforced via
 * preceding-character check below). The ≥1 non-numeric-character rule is enforced
 * separately below.
 */
const TAG_PATTERN = /#([A-Za-z0-9_/-]+)/g;

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
  const tags = new Set<string>();
  const visit = (node: Nodes): void => {
    if (SKIPPED_TYPES.has(node.type)) return;
    if (node.type === 'text') {
      for (const match of node.value.matchAll(TAG_PATTERN)) {
        const tag = match[1];
        if (!NON_NUMERIC.test(tag)) continue;

        // Check preceding character: must be start-of-text or whitespace
        let precedingChar: string | undefined;
        if (match.index > 0) {
          // Preceding char is within the same text node
          precedingChar = node.value[match.index - 1];
        } else if (match.index === 0) {
          // Tag starts at beginning of this text node; get the char before it from body
          const nodeOffset = node.position?.start?.offset;
          if (nodeOffset !== undefined && nodeOffset > 0) {
            precedingChar = body[nodeOffset - 1];
          }
          // If nodeOffset is undefined or 0, precedingChar stays undefined (start-of-text)
        }

        // Accept only if preceding char is undefined (start-of-text) or whitespace
        if (precedingChar === undefined || /\s/.test(precedingChar)) {
          tags.add(tag);
        }
      }
      return;
    }
    if ('children' in node) {
      for (const child of (node as Parent).children) visit(child);
    }
  };
  visit(fromMarkdown(body));
  return [...tags];
}
