import { z } from 'zod';

import { getNoteLinks, type BasenameIndex } from '../../../lib/obsidian/index.js';
import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { normalizeNotePath, readPositiveInteger, readThreshold } from '../tool-helpers.js';
import type {
  EmbeddingProvider,
  PathExistsCheck,
  SearchEngine,
  SimilarNoteResult,
  SmartSource,
} from '../types.js';

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_EXCLUDE_FOLDERS: readonly string[] = ['Templates', 'System', 'Daily', 'Archive'];

const inputSchema = z.object({
  path: z.string(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  exclude_folders: z.array(z.string()).optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface GetSimilarNotesDeps {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists: PathExistsCheck;
  basenameIndex: BasenameIndex;
  readNoteContent: (vaultRelativePath: string) => Promise<string>;
}

interface Candidate {
  path: string;
  signals: { semantic?: number; forward_link?: true };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function wrapDependencyError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): ToolHandlerError {
  if (error instanceof ToolHandlerError) return error;
  return new ToolHandlerError('DEPENDENCY_ERROR', message, { details, cause: error });
}

function normalizeExcludeEntry(entry: string): string {
  return entry.replace(/\/+$/, '');
}

function isExcluded(notePath: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (!prefix) continue;
    if (notePath === prefix) return true;
    if (notePath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

async function buildExistingPathSet(
  paths: Iterable<string>,
  pathExists: PathExistsCheck,
): Promise<Set<string>> {
  const unique = new Set(paths);
  const checks = await Promise.all(
    [...unique].map(async (notePath) => [notePath, await pathExists(notePath)] as const),
  );
  return new Set(checks.filter(([, exists]) => exists).map(([notePath]) => notePath));
}

export function buildGetSimilarNotesTool(
  deps: GetSimilarNotesDeps,
): ITool<Input, SimilarNoteResult[]> {
  const { sources, searchEngine, modelKey, pathExists, basenameIndex, readNoteContent } = deps;

  return {
    name: 'get_similar_notes',
    title: 'Get Similar Notes',
    description:
      'Find related notes — both semantically similar and explicitly linked from this note via [[wikilinks]]. Pass a vault-relative POSIX path (e.g. "Folder/note.md") as `path`. Forward-linked results rank ahead of semantic-only ones.',
    inputSchema,
    handler: async (input) => {
      const notePath = normalizeNotePath(input.path);
      const source = sources.get(notePath);
      if (!source) {
        throw new ToolHandlerError('NOT_FOUND', `No note found for path: ${notePath}`, {
          details: { path: notePath },
        });
      }
      const limit = readPositiveInteger(input.limit, DEFAULT_LIMIT, 'limit');
      const threshold = readThreshold(input.threshold, DEFAULT_THRESHOLD, 'threshold');
      const excludePrefixes = (input.exclude_folders ?? DEFAULT_EXCLUDE_FOLDERS).map(
        normalizeExcludeEntry,
      );

      try {
        // Step 2: semantic candidates (no limit yet — final truncation is post-union).
        const semanticResults = searchEngine.findNeighbors({
          queryVector: source.embedding,
          sources: sources.values(),
          threshold,
          excludePath: notePath,
        });
        const candidates = new Map<string, Candidate>();
        for (const r of semanticResults) {
          candidates.set(r.path, { path: r.path, signals: { semantic: r.similarity } });
        }

        // Step 3-5: read query note, extract wikilinks, resolve.
        let linkedPaths: Set<string>;
        try {
          linkedPaths = await getNoteLinks({ notePath, readNoteContent, basenameIndex });
        } catch (err) {
          if (isEnoent(err)) {
            throw new ToolHandlerError(
              'NOT_FOUND',
              `Query note file is missing on disk: ${notePath}`,
              { details: { path: notePath }, cause: err },
            );
          }
          throw err;
        }

        // Step 6: union by path.
        for (const linked of linkedPaths) {
          const existing = candidates.get(linked);
          if (existing) {
            existing.signals.forward_link = true;
          } else {
            candidates.set(linked, { path: linked, signals: { forward_link: true } });
          }
        }

        // Step 7: filter (exclude_folders + pathExists).
        const candidateList = [...candidates.values()].filter(
          (c) => !isExcluded(c.path, excludePrefixes),
        );
        const existing = await buildExistingPathSet(
          candidateList.map((c) => c.path),
          pathExists,
        );
        const filtered = candidateList.filter((c) => existing.has(c.path));

        // Step 8: sort. Forward-link first; then semantic desc; then path asc.
        filtered.sort((a, b) => {
          const aLink = a.signals.forward_link === true;
          const bLink = b.signals.forward_link === true;
          if (aLink !== bLink) return aLink ? -1 : 1;
          const aSem = a.signals.semantic ?? Number.NEGATIVE_INFINITY;
          const bSem = b.signals.semantic ?? Number.NEGATIVE_INFINITY;
          if (aSem !== bSem) return bSem - aSem;
          return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        });

        // Step 9: truncate.
        const sliced = filtered.slice(0, limit);

        return sliced.map((c): SimilarNoteResult => {
          const signals: SimilarNoteResult['signals'] = {};
          if (c.signals.semantic !== undefined) signals.semantic = c.signals.semantic;
          if (c.signals.forward_link === true) signals.forward_link = true;
          const result: SimilarNoteResult = { path: c.path, signals };
          if (c.signals.semantic !== undefined) result.similarity = c.signals.semantic;
          return result;
        });
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to find similar notes', {
          modelKey,
          operation: 'get_similar_notes',
          path: notePath,
        });
      }
    },
  };
}
