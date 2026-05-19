import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { resolveSemanticVault } from '../../../lib/resolve-vault.js';
import { runSemanticFanOut, type IFanOutResult } from '../../../lib/fan-out.js';
import {
  executeMultiRetrieval,
  executeRetrieval,
  type MultiRetrievalOutput,
  type RetrievalOutput,
} from '../retrieval-policy.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  pathExistsForEntry,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import type { EmbeddingProvider, NoteFilter, SearchEngine, SmartSource } from '../types.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';
import type { SmartConnectionsCorpusIndex } from '../../../lib/obsidian/smart-connections-corpus-index.js';
import { vaultParamShape } from '../../../lib/vault-param.js';

const prefixSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const filterSchema = z.object({
  path_prefix: prefixSchema.optional(),
  exclude_path_prefix: prefixSchema.optional(),
  tags: z.array(z.string()).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
});

interface SearchNotesInput {
  vault?: string;
  query: string | string[];
  mode?: 'quick' | 'deep';
  limit?: number;
  threshold?: number;
  filter?: {
    path_prefix?: string | string[];
    exclude_path_prefix?: string | string[];
    tags?: string[];
    frontmatter?: Record<string, unknown>;
  };
}

type EnrichResults<T extends { results: { path: string }[] }> = Omit<T, 'results'> & {
  results: Array<T['results'][number] & { backlink_count: number; vault: string }>;
};

export type SearchNotesOutput =
  | EnrichResults<RetrievalOutput>
  | EnrichResults<MultiRetrievalOutput>;

export interface SearchNotesDeps {
  registry: IVaultRegistry;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
}

async function buildExistingPathSet(
  entry: IVaultEntry,
  paths: Iterable<string>,
): Promise<Set<string>> {
  const unique = new Set(paths);
  const checks = await Promise.all(
    [...unique].map(
      async (notePath) => [notePath, await pathExistsForEntry(entry, notePath)] as const,
    ),
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

function isFilterEmpty(filter: NoteFilter): boolean {
  const hasInclude =
    filter.path_prefix !== undefined &&
    (Array.isArray(filter.path_prefix) ? filter.path_prefix.length > 0 : filter.path_prefix !== '');
  const hasExclude =
    filter.exclude_path_prefix !== undefined &&
    (Array.isArray(filter.exclude_path_prefix)
      ? filter.exclude_path_prefix.length > 0
      : filter.exclude_path_prefix !== '');
  const hasTags = Array.isArray(filter.tags) && filter.tags.length > 0;
  const hasFm = filter.frontmatter !== undefined && Object.keys(filter.frontmatter).length > 0;
  return !hasInclude && !hasExclude && !hasTags && !hasFm;
}

function narrowSources(
  sources: Map<string, SmartSource>,
  allowed: Set<string>,
): Map<string, SmartSource> {
  const out = new Map<string, SmartSource>();
  for (const path of allowed) {
    const src = sources.get(path);
    if (src) out.set(path, src);
  }
  return out;
}

async function runSearchForEntry(
  entry: IVaultEntry & { corpus: SmartConnectionsCorpusIndex },
  input: SearchNotesInput,
  deps: Pick<SearchNotesDeps, 'embeddingProvider' | 'searchEngine' | 'modelKey'>,
): Promise<SearchNotesOutput> {
  const corpus = entry.corpus;
  const { graph, listMatchingPaths } = entry;
  const { embeddingProvider, searchEngine, modelKey } = deps;

  let sources: Map<string, SmartSource>;
  try {
    ({ sources } = await corpus.snapshot());
  } catch (error) {
    throw wrapDependencyError(error, 'Failed to search notes', {
      modelKey,
      operation: 'search_notes',
    });
  }

  const mode = input.mode ?? 'quick';
  const threshold =
    input.threshold !== undefined
      ? readThreshold(input.threshold, input.threshold, 'threshold')
      : undefined;
  const limit =
    input.limit !== undefined ? readPositiveInteger(input.limit, input.limit, 'limit') : undefined;

  let effectiveSources = sources;

  if (input.filter !== undefined) {
    if (isFilterEmpty(input.filter)) {
      throw new ToolHandlerError(
        'INVALID_ARGUMENT',
        'filter must specify at least one of: path_prefix, exclude_path_prefix, tags, frontmatter',
      );
    }

    let allowed: Set<string>;
    try {
      allowed = await listMatchingPaths(input.filter);
    } catch (error) {
      if (error instanceof ToolHandlerError && error.code === 'INVALID_FILTER') {
        throw new ToolHandlerError('INVALID_ARGUMENT', error.message, {
          details: error.details,
        });
      }
      throw wrapDependencyError(error, 'Failed to compute filter set', {
        modelKey,
        operation: 'search_notes',
      });
    }

    if (allowed.size === 0) {
      const isMulti = Array.isArray(input.query);
      const isDeep = mode === 'deep';
      return {
        results: [],
        ...(isDeep ? { blockResults: [] } : {}),
        ...(isMulti ? { truncated: false } : {}),
      } as SearchNotesOutput;
    }

    effectiveSources = narrowSources(sources, allowed);
  }

  if (Array.isArray(input.query)) {
    const queries = normalizeQueryArray(input.query);
    try {
      const output = await executeMultiRetrieval({
        queries,
        mode,
        threshold,
        limit,
        sources: effectiveSources,
        embeddingProvider,
        searchEngine,
      });
      const candidatePaths: string[] = [
        ...output.results.map((r) => r.path),
        ...(output.blockResults?.map((b) => b.path) ?? []),
      ];
      const [existing] = await Promise.all([
        buildExistingPathSet(entry, candidatePaths),
        graph.ensureFresh(),
      ]);
      return {
        results: output.results
          .filter((r) => existing.has(r.path))
          .map((r) => ({
            ...r,
            backlink_count: graph.getBacklinkCount(r.path),
            vault: entry.name,
          })),
        ...(output.blockResults !== undefined
          ? {
              blockResults: output.blockResults
                .filter((b) => existing.has(b.path))
                .map((b) => ({ ...b, vault: entry.name })),
            }
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
      sources: effectiveSources,
      embeddingProvider,
      searchEngine,
    });
    const candidatePaths: string[] = [
      ...output.results.map((r) => r.path),
      ...(output.blockResults?.map((b) => b.path) ?? []),
    ];
    const [existing] = await Promise.all([
      buildExistingPathSet(entry, candidatePaths),
      graph.ensureFresh(),
    ]);
    return {
      results: output.results
        .filter((r) => existing.has(r.path))
        .map((r) => ({
          ...r,
          backlink_count: graph.getBacklinkCount(r.path),
          vault: entry.name,
        })),
      ...(output.blockResults !== undefined
        ? {
            blockResults: output.blockResults
              .filter((b) => existing.has(b.path))
              .map((b) => ({ ...b, vault: entry.name })),
          }
        : {}),
    };
  } catch (error) {
    throw wrapDependencyError(error, 'Failed to search notes', {
      modelKey,
      operation: 'search_notes',
    });
  }
}

export function buildSearchNotesTool(
  deps: SearchNotesDeps,
): ITool<SearchNotesInput, SearchNotesOutput | IFanOutResult<SearchNotesOutput>> {
  const { registry, embeddingProvider, searchEngine, modelKey } = deps;
  const entryDeps = { embeddingProvider, searchEngine, modelKey };
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
    mode: z.enum(['quick', 'deep']).optional(),
    limit: z.number().int().positive().optional(),
    threshold: z.number().min(0).max(1).optional(),
    filter: filterSchema.optional(),
  });
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
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
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
    '',
    'PRE-FILTER (filter parameter):',
    '- filter: optional structural narrowing applied BEFORE semantic ranking. Best when vault has many narrative notes that crowd top-K on a niche query.',
    '  Shape: { path_prefix?, exclude_path_prefix?, tags?, frontmatter? }. At least one field required.',
    '  - path_prefix: scope to a folder, or array of folders for OR-semantics (e.g. ["Tasks/", "Reflections/"]).',
    '  - exclude_path_prefix: drop notes whose path starts with any of the listed prefixes (e.g. ["Resources/", "Archive/"]). Valid as the sole filter field — "search the whole vault except these subtrees".',
    '  - tags: notes that have ANY of these tags (OR within the array; no leading "#").',
    '  - frontmatter: sift filter on frontmatter keys (e.g. { type: "reflection", status: "active" }). Same operator allow-list as query_notes.',
    '  Composition: include → exclude → tags → frontmatter → threshold → semantic. Use this instead of querying twice and intersecting on the client.',
    '- scoped recall: search_notes({query: "trading lessons", filter: {tags: ["trading"]}}) — semantic only inside notes tagged trading.',
    '- carve out noise: search_notes({query: "active thinking", filter: {exclude_path_prefix: ["Resources/", "Archive/"]}, mode: "deep"}).',
    '- scoped multi-query: search_notes({query: ["embeddings","векторний пошук"], filter: {path_prefix: ["Resources/", "Inbox/"]}, mode: "deep"}).',
    ...(registry.isMulti()
      ? [
          '',
          'In multi-vault mode, omit `vault:` to fan out across all registered vaults — the response shape switches to `results_by_vault: [...]` with `skipped_vaults: [...]` (vaults without a semantic index are listed in `skipped_vaults`).',
          '',
          'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
        ]
      : []),
  ].join('\n');

  return {
    name: 'search_notes',
    title: 'Search Notes',
    description: SEARCH_NOTES_DESCRIPTION,
    inputSchema,
    handler: async (input) => {
      if (input.vault === undefined && registry.isMulti()) {
        // runSemanticFanOut filters via semanticAvailableEntries(), so every
        // entry reaching the callback has corpus defined — the cast bridges
        // what TS cannot prove from the flag alone.
        return await runSemanticFanOut(registry, (entry) =>
          runSearchForEntry(
            entry as IVaultEntry & { corpus: SmartConnectionsCorpusIndex },
            input,
            entryDeps,
          ),
        );
      }
      const entry = resolveSemanticVault(input, registry, {
        tool: 'search_notes',
      });
      return runSearchForEntry(entry, input, entryDeps);
    },
  };
}
