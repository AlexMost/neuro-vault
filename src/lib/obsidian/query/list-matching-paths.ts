import { ToolHandlerError } from '../../tool-response.js';
import { ScanPathNotFoundError } from '../vault-reader.js';
import type { VaultReader } from '../vault-reader.js';
import type { WikilinkGraphIndex } from '../wikilink-graph.js';
import { applyDefaultRegexOptions } from './default-regex-options.js';
import { matchesAnyPrefix, normalizePrefixList } from './path-prefix-set.js';
import { collectMatchingPaths } from './query-notes.js';
import { validateFilter } from './whitelist.js';

export interface NoteFilter {
  path_prefix?: string | string[];
  exclude_path_prefix?: string | string[];
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
    const { path_prefix, exclude_path_prefix, tags, frontmatter } = filter;

    const includePrefixes = normalizePrefixList(path_prefix, 'path_prefix', 'INVALID_FILTER');
    const excludePrefixes = normalizePrefixList(
      exclude_path_prefix,
      'exclude_path_prefix',
      'INVALID_FILTER',
    );

    const hasInclude = includePrefixes !== undefined;
    const hasExclude = excludePrefixes !== undefined;
    const hasTags = Array.isArray(tags) && tags.length > 0;
    const hasFrontmatter = frontmatter !== undefined && Object.keys(frontmatter).length > 0;

    if (!hasInclude && !hasExclude && !hasTags && !hasFrontmatter) {
      throw new ToolHandlerError(
        'INVALID_FILTER',
        'filter must specify at least one of: path_prefix, exclude_path_prefix, tags, frontmatter',
      );
    }

    // Fast path: only path filters, no tags / frontmatter — never reads frontmatter.
    if (!hasTags && !hasFrontmatter) {
      const collected = new Set<string>();
      try {
        if (hasInclude) {
          const scans = await Promise.all(
            includePrefixes!.map((p) => deps.reader.scan({ pathPrefix: p })),
          );
          for (const list of scans) for (const p of list) collected.add(p);
        } else {
          for (const p of await deps.reader.scan({ pathPrefix: undefined })) collected.add(p);
        }
      } catch (err) {
        if (err instanceof ScanPathNotFoundError) {
          throw new ToolHandlerError('PATH_NOT_FOUND', err.message);
        }
        throw err;
      }
      if (hasExclude) {
        for (const p of [...collected]) {
          if (matchesAnyPrefix(p, excludePrefixes!)) collected.delete(p);
        }
      }
      return collected;
    }

    // General path — validate frontmatter operators before sift compiles.
    if (hasFrontmatter) {
      validateFilter(frontmatter!);
    }
    const internalFilter = compileFilter({ tags, frontmatter });
    const effectiveFilter = applyDefaultRegexOptions(internalFilter);

    const scanPrefixes: Array<string | undefined> = hasInclude
      ? [...includePrefixes!]
      : [undefined];
    const batched = await Promise.all(
      scanPrefixes.map((prefix) =>
        collectMatchingPaths(
          {
            filter: effectiveFilter,
            pathPrefix: prefix,
            includeContent: false,
            excludePathPrefixes: hasExclude ? excludePrefixes : undefined,
          },
          deps,
        ),
      ),
    );

    const out = new Set<string>();
    for (const rows of batched) {
      for (const row of rows) out.add(row.record.path);
    }
    return out;
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
