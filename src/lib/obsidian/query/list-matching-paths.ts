import { ToolHandlerError } from '../../tool-response.js';
import { ScanPathNotFoundError } from '../vault-reader.js';
import type { VaultReader } from '../vault-reader.js';
import type { WikilinkGraphIndex } from '../wikilink-graph.js';
import { applyDefaultRegexOptions } from './default-regex-options.js';
import { normalizeVaultPathPrefix } from './path-prefix.js';
import { collectMatchingPaths } from './query-notes.js';
import { validateFilter } from './whitelist.js';

export interface NoteFilter {
  path_prefix?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export type ListMatchingPaths = (filter: NoteFilter) => Promise<Set<string>>;

export interface ListMatchingPathsDeps {
  reader: VaultReader;
  graph?: WikilinkGraphIndex;
}

export function createListMatchingPaths(deps: ListMatchingPathsDeps): ListMatchingPaths {
  return async (filter) => {
    const { path_prefix, tags, frontmatter } = filter;

    const hasPathPrefix = path_prefix !== undefined && path_prefix !== '';
    const hasTags = Array.isArray(tags) && tags.length > 0;
    const hasFrontmatter = frontmatter !== undefined && Object.keys(frontmatter).length > 0;

    if (!hasPathPrefix && !hasTags && !hasFrontmatter) {
      throw new ToolHandlerError(
        'INVALID_FILTER',
        'filter must specify at least one of: path_prefix, tags, frontmatter',
      );
    }

    const normalizedPrefix = hasPathPrefix
      ? normalizeVaultPathPrefix(
          path_prefix!,
          (message) => new ToolHandlerError('INVALID_FILTER', message),
        )
      : undefined;

    // Fast-path: only path_prefix → scan-only, never read frontmatter.
    if (hasPathPrefix && !hasTags && !hasFrontmatter) {
      try {
        const paths = await deps.reader.scan({ pathPrefix: normalizedPrefix });
        return new Set(paths);
      } catch (err) {
        if (err instanceof ScanPathNotFoundError) {
          throw new ToolHandlerError('PATH_NOT_FOUND', err.message, {
            details: { path_prefix: normalizedPrefix },
          });
        }
        throw err;
      }
    }

    // Validate the raw user-supplied frontmatter object before compileFilter
    // rewrites top-level keys like `$where` into dotted paths (`frontmatter.$where`)
    // that no longer trigger the operator allow-list check.
    if (hasFrontmatter) {
      validateFilter(frontmatter!);
    }

    // General path: compile NoteFilter → internal sift filter, delegate.
    const internalFilter = compileFilter({ tags, frontmatter });
    const effectiveFilter = applyDefaultRegexOptions(internalFilter);

    const rows = await collectMatchingPaths(
      {
        filter: effectiveFilter,
        pathPrefix: normalizedPrefix,
        includeContent: false,
      },
      deps,
    );

    return new Set(rows.map((row) => row.record.path));
  };
}

function compileFilter(parts: {
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  if (parts.tags && parts.tags.length > 0) {
    clauses.push({ tags: { $in: parts.tags } });
  }
  if (parts.frontmatter && Object.keys(parts.frontmatter).length > 0) {
    for (const [key, value] of Object.entries(parts.frontmatter)) {
      clauses.push({ [`frontmatter.${key}`]: value });
    }
  }
  if (clauses.length === 1) return clauses[0]!;
  return { $and: clauses };
}
