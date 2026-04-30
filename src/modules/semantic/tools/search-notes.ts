import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import {
  executeMultiRetrieval,
  executeRetrieval,
  type MultiRetrievalOutput,
  type RetrievalOutput,
} from '../retrieval-policy.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import type { EmbeddingProvider, PathExistsCheck, SearchEngine, SmartSource } from '../types.js';

const SEARCH_NOTES_DESCRIPTION = [
  'Search notes by semantic similarity. Best for fuzzy recall, topic exploration, or cross-language matches. Pass short keyword queries (1-4 words), not sentences.',
  '',
  'MODES (pick based on intent):',
  '- "quick" (default) — specific lookup. Returns up to 3 top notes plus block-level matches scoped to those notes. Use when you want one or two specific notes.',
  '- "deep" — topic exploration. Returns up to 8 notes plus block-level matches across the whole vault. After the merged top-`limit` results are selected, expansion runs once to pull in semantically related notes; expansion-derived results carry `via_expansion: true`. Use for "tell me about X" or building an overview.',
  '',
  'PARAMETERS:',
  '- query (required): string, or array of 1-8 strings. Pass an array for synonyms / reformulations / translations — embedded in batch, merged into one ranked list. Each result carries `matched_queries` (which of your queries hit it). `limit` is the FINAL result count regardless of how many queries are passed — passing more queries widens coverage but does not increase the result count.',
  '- mode: "quick" | "deep" (default "quick").',
  '- limit: max notes in `results`. Default 3 (quick) / 8 (deep). Override to widen or narrow the result set. Does not affect `blockResults` (quick: capped at 5; deep: capped at mode limit).',
  '- threshold: min similarity, 0-1. Default 0.5 (quick) / 0.35 (deep). Raise to 0.6+ to cut weak matches; lower (e.g. 0.3) when nothing comes back.',
  '',
  'OUTPUT FIELDS (multi-query):',
  '- matched_queries: which of your queries surfaced this result — tells you which synonym was load-bearing.',
  '- truncated: true when more unique candidates were merged than fit in `limit`.',
  '- via_expansion: true on results pulled in by post-merge expansion in deep mode (mutually exclusive with matched_queries).',
  '',
  'EXAMPLES:',
  '- "where did I write about X?" → search_notes({query: "X"}) — quick.',
  '- "what do I know about Y?" → search_notes({query: "Y", mode: "deep"}).',
  '- multilingual pair: search_notes({query: ["embeddings", "векторний пошук"]}) — returns one merged list; notes matched by both queries appear with both in matched_queries.',
  '- multilingual deep: search_notes({query: ["optimization", "оптимізація"], mode: "deep"}) — merged top-`limit` seeds, then expansion once on the merged set.',
].join('\n');

const inputSchema = z.object({
  query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
  mode: z.enum(['quick', 'deep']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

type SearchNotesInput = z.infer<typeof inputSchema>;

type EnrichResults<T extends { results: { path: string }[] }> = Omit<T, 'results'> & {
  results: Array<T['results'][number] & { backlink_count: number }>;
};

type SearchNotesOutput = EnrichResults<RetrievalOutput> | EnrichResults<MultiRetrievalOutput>;

export interface SearchNotesDeps {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists: PathExistsCheck;
  graph: WikilinkGraphIndex;
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

function wrapDependencyError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): ToolHandlerError {
  if (error instanceof ToolHandlerError) {
    return error;
  }
  return new ToolHandlerError('DEPENDENCY_ERROR', message, { details, cause: error });
}

export function buildSearchNotesTool(
  deps: SearchNotesDeps,
): ITool<SearchNotesInput, SearchNotesOutput> {
  const { sources, embeddingProvider, searchEngine, modelKey, pathExists, graph } = deps;

  return {
    name: 'search_notes',
    title: 'Search Notes',
    description: SEARCH_NOTES_DESCRIPTION,
    inputSchema,
    handler: async (input) => {
      const mode = input.mode ?? 'quick';
      const threshold =
        input.threshold !== undefined
          ? readThreshold(input.threshold, input.threshold, 'threshold')
          : undefined;
      const limit =
        input.limit !== undefined
          ? readPositiveInteger(input.limit, input.limit, 'limit')
          : undefined;

      if (Array.isArray(input.query)) {
        const queries = normalizeQueryArray(input.query);
        try {
          const output = await executeMultiRetrieval({
            queries,
            mode,
            threshold,
            limit,
            sources,
            embeddingProvider,
            searchEngine,
          });
          const candidatePaths: string[] = [
            ...output.results.map((r) => r.path),
            ...(output.blockResults?.map((b) => b.path) ?? []),
          ];
          const [existing] = await Promise.all([
            buildExistingPathSet(candidatePaths, pathExists),
            graph.ensureFresh(),
          ]);
          return {
            results: output.results
              .filter((r) => existing.has(r.path))
              .map((r) => ({ ...r, backlink_count: graph.getBacklinkCount(r.path) })),
            ...(output.blockResults !== undefined
              ? { blockResults: output.blockResults.filter((b) => existing.has(b.path)) }
              : {}),
            truncated: output.truncated,
          };
        } catch (error) {
          throw wrapDependencyError(error, 'Failed to search notes', {
            modelKey,
            operation: 'search_notes',
          });
        }
      }

      const query = normalizeQuery(input.query);
      try {
        const output = await executeRetrieval({
          query,
          mode,
          limit,
          threshold,
          sources,
          embeddingProvider,
          searchEngine,
        });
        const candidatePaths: string[] = [
          ...output.results.map((r) => r.path),
          ...(output.blockResults?.map((b) => b.path) ?? []),
        ];
        const [existing] = await Promise.all([
          buildExistingPathSet(candidatePaths, pathExists),
          graph.ensureFresh(),
        ]);
        return {
          results: output.results
            .filter((r) => existing.has(r.path))
            .map((r) => ({ ...r, backlink_count: graph.getBacklinkCount(r.path) })),
          ...(output.blockResults !== undefined
            ? { blockResults: output.blockResults.filter((b) => existing.has(b.path)) }
            : {}),
        };
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to search notes', {
          modelKey,
          operation: 'search_notes',
        });
      }
    },
  };
}
