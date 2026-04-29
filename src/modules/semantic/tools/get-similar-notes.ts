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

function collectSemanticCandidates(args: {
  searchEngine: SearchEngine;
  queryVector: number[];
  sources: Map<string, SmartSource>;
  threshold: number;
  excludePath: string;
}): Map<string, Candidate> {
  const results = args.searchEngine.findNeighbors({
    queryVector: args.queryVector,
    sources: args.sources.values(),
    threshold: args.threshold,
    excludePath: args.excludePath,
  });
  const candidates = new Map<string, Candidate>();
  for (const r of results) {
    candidates.set(r.path, { path: r.path, signals: { semantic: r.similarity } });
  }
  return candidates;
}

async function resolveForwardLinks(args: {
  notePath: string;
  readNoteContent: (vaultRelativePath: string) => Promise<string>;
  basenameIndex: BasenameIndex;
}): Promise<Set<string>> {
  try {
    return await getNoteLinks(args);
  } catch (err) {
    if (isEnoent(err)) {
      throw new ToolHandlerError(
        'NOT_FOUND',
        `Query note file is missing on disk: ${args.notePath}`,
        { details: { path: args.notePath }, cause: err },
      );
    }
    throw err;
  }
}

function mergeForwardLinks(candidates: Map<string, Candidate>, linkedPaths: Set<string>): void {
  for (const linked of linkedPaths) {
    const existing = candidates.get(linked);
    if (existing) {
      existing.signals.forward_link = true;
    } else {
      candidates.set(linked, { path: linked, signals: { forward_link: true } });
    }
  }
}

async function filterCandidates(args: {
  candidates: Iterable<Candidate>;
  excludePrefixes: readonly string[];
  pathExists: PathExistsCheck;
}): Promise<Candidate[]> {
  const afterExclude = [...args.candidates].filter(
    (c) => !isExcluded(c.path, args.excludePrefixes),
  );
  const uniquePaths = new Set(afterExclude.map((c) => c.path));
  const checks = await Promise.all(
    [...uniquePaths].map(async (p) => [p, await args.pathExists(p)] as const),
  );
  const existing = new Set(checks.filter(([, ok]) => ok).map(([p]) => p));
  return afterExclude.filter((c) => existing.has(c.path));
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const aLink = a.signals.forward_link === true;
  const bLink = b.signals.forward_link === true;
  if (aLink !== bLink) return aLink ? -1 : 1;
  const aSem = a.signals.semantic ?? Number.NEGATIVE_INFINITY;
  const bSem = b.signals.semantic ?? Number.NEGATIVE_INFINITY;
  if (aSem !== bSem) return bSem - aSem;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function toSimilarNoteResult(c: Candidate): SimilarNoteResult {
  const signals: SimilarNoteResult['signals'] = {};
  if (c.signals.semantic !== undefined) signals.semantic = c.signals.semantic;
  if (c.signals.forward_link === true) signals.forward_link = true;
  const result: SimilarNoteResult = { path: c.path, signals };
  if (c.signals.semantic !== undefined) result.similarity = c.signals.semantic;
  return result;
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
      const excludePrefixes = (input.exclude_folders ?? []).map(normalizeExcludeEntry);

      try {
        const candidates = collectSemanticCandidates({
          searchEngine,
          queryVector: source.embedding,
          sources,
          threshold,
          excludePath: notePath,
        });
        const linkedPaths = await resolveForwardLinks({
          notePath,
          readNoteContent,
          basenameIndex,
        });
        mergeForwardLinks(candidates, linkedPaths);
        const filtered = await filterCandidates({
          candidates: candidates.values(),
          excludePrefixes,
          pathExists,
        });
        filtered.sort(compareCandidates);
        return filtered.slice(0, limit).map(toSimilarNoteResult);
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
