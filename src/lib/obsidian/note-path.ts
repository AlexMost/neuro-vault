import path from 'node:path';

import { normalizeVaultPath } from './paths.js';

/**
 * Normalize a vault-relative POSIX path that refers to an *individual note*.
 *
 * Wraps {@link normalizeVaultPath} (which rejects empty / absolute / `..`
 * inputs and strips leading `./`), then auto-appends `.md` when the final
 * path segment has no extension. Idempotent: paths that already end in
 * `.md` (or any other extension) are returned unchanged.
 *
 * Tools that take a path referring to an *individual note* (create_note,
 * edit_note, set_property, read_property, remove_property, get_note_links)
 * must funnel paths through this helper so behavior is consistent across the
 * surface. Tools that take subtree prefixes (`path_prefix`,
 * `exclude_path_prefix`) and `read_notes`'s batch path list use
 * {@link normalizeVaultPath} / `normalizeScanPrefix` directly — those are
 * not individual notes.
 */
export function normalizeNotePath(raw: string): string {
  const normalized = normalizeVaultPath(raw);
  const ext = path.posix.extname(normalized);
  // path.posix.extname returns '' when there is no dot in the final segment,
  // and '.' when the segment ends in a dot ("Foo."). We treat both as "no
  // real extension" and append .md.
  if (ext === '' || ext === '.') {
    return `${normalized}.md`;
  }
  return normalized;
}
