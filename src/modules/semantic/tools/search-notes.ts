import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import { runFanOut, type IFanOutResult } from '../../../lib/fan-out.js';
import { executeMultiRetrieval, executeRetrieval } from '../retrieval-policy.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  pathExistsForEntry,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import type {
  EmbeddingProvider,
  NoteFilter,
  NoteResultNode,
  MultiNoteResultNode,
  SearchChannelMode,
  SearchEffort,
  SearchEngine,
  SmartSource,
} from '../types.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';
import { vaultParamShape } from '../../../lib/vault-param.js';
import { LexicalIndex, type LexicalMatch } from '../../../lib/obsidian/lexical/index.js';

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
  mode?: SearchChannelMode;
  effort?: SearchEffort;
  limit?: number;
  threshold?: number;
  filter?: {
    path_prefix?: string | string[];
    exclude_path_prefix?: string | string[];
    tags?: string[];
    frontmatter?: Record<string, unknown>;
  };
}

// Direct nodes carry backlink_count + vault. Related nodes are lightweight (no
// enrichment) — consumers can call get_similar_notes for a full neighbour profile.
type EnrichedNoteNode<T extends NoteResultNode> = T & {
  backlink_count: number;
  vault: string;
};

export interface LexicalNoteResult {
  path: string;
  backlink_count: number;
  vault: string;
  matched_queries?: string[];
  matches: LexicalMatch[];
}

export type SearchNotesOutput =
  | { semantic_matches: EnrichedNoteNode<NoteResultNode>[]; lexical_matches: LexicalNoteResult[] }
  | {
      semantic_matches: EnrichedNoteNode<MultiNoteResultNode>[];
      lexical_matches: LexicalNoteResult[];
      truncated: boolean;
    };

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
  entry: IVaultEntry,
  input: SearchNotesInput,
  deps: Pick<SearchNotesDeps, 'embeddingProvider' | 'searchEngine' | 'modelKey'> & {
    lexicalFor: (entry: IVaultEntry) => LexicalIndex;
  },
): Promise<SearchNotesOutput> {
  const { graph, listMatchingPaths } = entry;
  const { embeddingProvider, searchEngine, modelKey, lexicalFor } = deps;

  // `channel` picks which retrieval leg(s) run. `effort` maps onto the
  // internal quick|deep retrieval-policy vocabulary. `threshold` is
  // semantic-only; the lexical leg has no similarity score to threshold.
  const channel = input.mode ?? 'hybrid';
  const effort = input.effort ?? 'quick';
  const threshold =
    input.threshold !== undefined
      ? readThreshold(input.threshold, input.threshold, 'threshold')
      : undefined;
  const limit =
    input.limit !== undefined ? readPositiveInteger(input.limit, input.limit, 'limit') : undefined;

  let allowed: Set<string> | undefined;

  if (input.filter !== undefined) {
    if (isFilterEmpty(input.filter)) {
      throw new ToolHandlerError(
        'INVALID_ARGUMENT',
        'filter must specify at least one of: path_prefix, exclude_path_prefix, tags, frontmatter',
      );
    }

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
      return isMulti
        ? ({ semantic_matches: [], lexical_matches: [], truncated: false } as SearchNotesOutput)
        : ({ semantic_matches: [], lexical_matches: [] } as SearchNotesOutput);
    }
  }

  let isMulti: boolean;
  let queries: string[];
  if (Array.isArray(input.query)) {
    isMulti = true;
    queries = normalizeQueryArray(input.query);
  } else {
    isMulti = false;
    queries = [normalizeQuery(input.query)];
  }

  // Global lexical cap: in lexical-only mode the caller's `limit` steers the
  // list directly (falling back to the quick/deep default); in hybrid mode
  // `limit` is reserved for the semantic leg, so the lexical leg always uses
  // the quick/deep default regardless of `limit`.
  const lexCap =
    channel === 'lexical' ? (limit ?? (effort === 'deep' ? 10 : 5)) : effort === 'deep' ? 10 : 5;

  await graph.ensureFresh();
  const lexical = await lexicalFor(entry).search({
    queries,
    allowed,
    noteCap: lexCap,
    perNoteCap: 3,
    getBacklinkCount: (p) => graph.getBacklinkCount(p),
  });
  const lexical_matches: LexicalNoteResult[] = lexical.notes.map((n) => ({
    path: n.path,
    backlink_count: graph.getBacklinkCount(n.path),
    vault: entry.name,
    ...(isMulti ? { matched_queries: n.matchedQueries } : {}),
    matches: n.matches,
  }));

  // `mode: "lexical"` never touches the corpus loader. A vault without an
  // available semantic corpus (cold/absent) also falls back to lexical-only
  // rather than throwing — an available corpus that errors mid-search still
  // throws DEPENDENCY_ERROR below, unchanged.
  if (channel === 'lexical' || !entry.semanticAvailable || entry.corpus === undefined) {
    return isMulti
      ? ({
          semantic_matches: [],
          lexical_matches,
          truncated: lexical.truncated,
        } as SearchNotesOutput)
      : ({ semantic_matches: [], lexical_matches } as SearchNotesOutput);
  }

  const corpus = entry.corpus;
  let sources: Map<string, SmartSource>;
  try {
    ({ sources } = await corpus.snapshot());
  } catch (error) {
    throw wrapDependencyError(error, 'Failed to search notes', {
      modelKey,
      operation: 'search_notes',
    });
  }

  const effectiveSources = allowed !== undefined ? narrowSources(sources, allowed) : sources;

  try {
    if (isMulti) {
      const output = await executeMultiRetrieval({
        queries,
        mode: effort,
        threshold,
        limit,
        sources: effectiveSources,
        embeddingProvider,
        searchEngine,
      });
      // Candidate paths to check on disk: direct results plus everything in their
      // related[] (related nodes are filtered, not enriched, if missing).
      const candidatePaths: string[] = [
        ...output.results.map((r) => r.path),
        ...output.results.flatMap((r) => r.related.map((rel) => rel.path)),
      ];
      const existing = await buildExistingPathSet(entry, candidatePaths);
      const enriched = output.results
        .filter((r) => existing.has(r.path))
        .map((r) => ({
          ...r,
          related: r.related.filter((rel) => existing.has(rel.path)),
          backlink_count: graph.getBacklinkCount(r.path),
          vault: entry.name,
        }));
      return { semantic_matches: enriched, lexical_matches, truncated: output.truncated };
    }

    const output = await executeRetrieval({
      query: queries[0],
      mode: effort,
      limit,
      threshold,
      sources: effectiveSources,
      embeddingProvider,
      searchEngine,
    });
    const candidatePaths: string[] = [
      ...output.results.map((r) => r.path),
      ...output.results.flatMap((r) => r.related.map((rel) => rel.path)),
    ];
    const existing = await buildExistingPathSet(entry, candidatePaths);
    const enriched = output.results
      .filter((r) => existing.has(r.path))
      .map((r) => ({
        ...r,
        related: r.related.filter((rel) => existing.has(rel.path)),
        backlink_count: graph.getBacklinkCount(r.path),
        vault: entry.name,
      }));
    return { semantic_matches: enriched, lexical_matches };
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

  // Per-vault lexical indexes, created lazily; the Map lives for the tool's
  // lifetime. Never touches the Smart Connections corpus — it's a read-through
  // cache over the filesystem via `entry.reader`.
  const lexicalIndexes = new Map<string, LexicalIndex>();
  const lexicalFor = (entry: IVaultEntry): LexicalIndex => {
    let idx = lexicalIndexes.get(entry.name);
    if (!idx) {
      idx = new LexicalIndex({ vaultRoot: entry.path, reader: entry.reader });
      lexicalIndexes.set(entry.name, idx);
    }
    return idx;
  };

  const entryDeps = { embeddingProvider, searchEngine, modelKey, lexicalFor };
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
    mode: z.enum(['hybrid', 'lexical']).optional(),
    effort: z.enum(['quick', 'deep']).optional(),
    limit: z.number().int().positive().optional(),
    threshold: z.number().min(0).max(1).optional(),
    filter: filterSchema.optional(),
  });
  const SEARCH_NOTES_DESCRIPTION = [
    'Hybrid search over notes: a semantic leg (embedding similarity — fuzzy recall, topic exploration, cross-language) and a lexical leg (exact text matches over note titles, headings, and body — names, codes, terms). Returns both in one response. Pass short keyword queries (1-4 words), not sentences.',
    '',
    'AXES:',
    '- mode: "hybrid" (default) runs both legs; "lexical" runs ONLY exact text matching — works even when no embedding corpus exists.',
    '- effort: "quick" (default) — compact lookup (up to 3 semantic notes, ~5 lexical); "deep" — exploration (up to 8 semantic notes + related[], ~10 lexical).',
    '',
    'PARAMETERS:',
    '- query (required): string, or array of 1-8 strings for synonyms/translations — merged into one ranked list per leg; each result carries `matched_queries`.',
    '- mode: "hybrid" | "lexical" (default "hybrid").',
    '- effort: "quick" | "deep" (default "quick").',
    '- limit: in hybrid mode caps `semantic_matches`; in lexical mode caps `lexical_matches`.',
    '- threshold: min similarity 0-1 — SEMANTIC LEG ONLY. Default 0.5 (quick) / 0.35 (deep).',
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
    '',
    'RESPONSE SHAPE:',
    '- `semantic_matches[]` — the semantic tree: `path`, `similarity`, `backlink_count`, `vault`, `blocks[]` (heading, lines, similarity), `related[]` (deep only, `expansion_similarity`). Empty in lexical mode or when no corpus exists.',
    '- `lexical_matches[]` — grouped per note: `path`, `backlink_count`, `vault`, and `matches[]` (max ~3) of `{ matched_in: "title"|"heading"|"body", snippet, lines?, heading? }`. `heading` on a body match names its enclosing section. No numeric score — order and matched_in carry the ranking (title > heading > body; exact phrase > all-tokens).',
    '- `truncated` — top-level, only when `query` is an array.',
    '',
    'LEXICAL MATCHING: case-, accent-, and apostrophe-variant-insensitive substring; multiword query = ALL tokens must appear (AND), contiguous phrase ranks higher. A note in BOTH legs is a strong relevance signal.',
    '',
    'INVARIANTS:',
    '- `similarity`/`expansion_similarity` appear ONLY on semantic nodes; lexical items never carry scores.',
    '- `blocks[]` and `related[]` are always present on semantic results (possibly empty); `matches[]` is always non-empty on lexical items.',
    '- Empty `lexical_matches` means literally no exact match — unlike the semantic leg, it does not degrade to weak matches.',
    '',
    'EXAMPLES:',
    '- "where did I write about X?" → search_notes({query: "X"}).',
    '- exact name/code/term → search_notes({query: "PARAM_DICT", mode: "lexical"}).',
    '- "what do I know about Y?" → search_notes({query: "Y", effort: "deep"}).',
    '- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).',
    '',
    'PRE-FILTER (filter parameter) — applies to BOTH legs identically:',
    '  Shape: { path_prefix?, exclude_path_prefix?, tags?, frontmatter? }. At least one field required.',
    '  - path_prefix / exclude_path_prefix: scope to / drop folder subtrees (string or array).',
    '  - tags: notes with ANY of these tags (no leading "#").',
    '  - frontmatter: sift filter on frontmatter keys, same operator allow-list as query_notes.',
    ...(registry.isMulti()
      ? [
          '',
          'In multi-vault mode, omit `vault:` to fan out across all registered vaults — the response shape switches to `results_by_vault: [...]`. A vault without a semantic index still contributes its `lexical_matches` (with `semantic_matches: []`); none are skipped.',
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
        // Fan out over every registered vault, not just semantically-available
        // ones — a vault without a corpus still contributes lexical matches.
        return await runFanOut(registry, (entry) => runSearchForEntry(entry, input, entryDeps));
      }
      const entry = resolveVault(input, registry, { tool: 'search_notes' });
      return runSearchForEntry(entry, input, entryDeps);
    },
  };
}
