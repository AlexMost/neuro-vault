import { extractWikilinksFromFrontmatter } from './frontmatter-links.js';
import { splitFrontmatter } from './frontmatter.js';
import type { BasenameIndex } from './link-resolver.js';
import { normalizeWikilinkTarget, parseWikilinks } from './wikilink.js';

export interface GetNoteLinksOptions {
  notePath: string;
  readNoteContent: (vaultRelativePath: string) => Promise<string>;
  basenameIndex: BasenameIndex;
}

/**
 * Read a note and return the set of vault-relative paths it forward-links to
 * via [[wikilinks]] in its body or frontmatter values. The note's own path is
 * excluded; unresolved targets are dropped.
 *
 * Read errors (e.g. ENOENT) propagate to the caller — this function does not
 * map them to MCP error codes.
 */
export async function getNoteLinks(opts: GetNoteLinksOptions): Promise<Set<string>> {
  const { notePath, readNoteContent, basenameIndex } = opts;

  const raw = await readNoteContent(notePath);
  const { content: body, frontmatter } = splitFrontmatter(raw);

  const rawTargets = [
    ...parseWikilinks(body),
    ...(frontmatter ? extractWikilinksFromFrontmatter(frontmatter) : []),
  ];

  const resolved = new Set<string>();
  for (const target of rawTargets) {
    const normalized = normalizeWikilinkTarget(target);
    if (!normalized) continue;
    const path = basenameIndex.resolve(normalized);
    if (!path) continue;
    if (path === notePath) continue;
    resolved.add(path);
  }
  return resolved;
}
