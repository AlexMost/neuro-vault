import { z } from 'zod';

import { graphForTool } from '../../../lib/tool-graph.js';
import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';
import { EFFORT_PROFILES } from '../effort-profiles.js';
import type { SimilarityDefaults } from '../../../lib/model-profiles.js';
import { runRetrievalPipeline } from '../retrieval-pipeline.js';
import {
  deriveObservability,
  type QueryStatsEntry,
  type SemanticStatusField,
} from '../search-observability.js';
import { normalizeQuery, normalizeQueryArray, wrapDependencyError } from '../tool-helpers.js';
import type {
  BlockMatch,
  QueryEmbedder,
  NoteFilter,
  SearchChannelMode,
  SearchEffort,
} from '../types.js';
import type { IRegisteredVault, IVaultRegistry } from '../../../lib/vault-registry.js';
import { LexicalSearchError, type LexicalMatch } from '../../../lib/obsidian/lexical/index.js';

const prefixSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const filterSchema = z.object({
  path_prefix: prefixSchema.optional(),
  exclude_path_prefix: prefixSchema.optional(),
  tags: z.array(z.string()).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
});

export interface SearchNotesInput {
  vault?: string;
  query: string | string[];
  mode?: SearchChannelMode;
  effort?: SearchEffort;
  limit?: number;
  threshold?: number;
  expansion_floor?: number;
  filter?: {
    path_prefix?: string | string[];
    exclude_path_prefix?: string | string[];
    tags?: string[];
    frontmatter?: Record<string, unknown>;
  };
}

export interface UnifiedMatch {
  path: string;
  vault: string;
  backlink_count: number;
  // Ordered: "semantic", then distinct lexical kinds in title→heading→body
  // order, then "expansion". Always non-empty.
  found_in: string[];
  similarity?: number;
  blocks?: BlockMatch[];
  lexical?: LexicalMatch[];
  expansion_similarity?: number;
  matched_queries?: string[];
}

export type { SemanticStatusField };

export type SearchNotesOutput = {
  matches: UnifiedMatch[];
  truncated: boolean;
  semantic_status: SemanticStatusField;
  query_stats?: Record<string, QueryStatsEntry>;
};

export interface SearchNotesDeps {
  registry: IVaultRegistry;
  embeddingProvider: QueryEmbedder;
  modelKey: string;
  /** The active model profile's default thresholds. */
  similarity: SimilarityDefaults;
  /** Defaults to console.error — diagnostics must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

/** The `threshold` description's retry clause: the active profile's fallback, or none. */
function retryClause(fallback: number | undefined): string {
  return fallback === undefined
    ? 'with no retry — zero hits are honest'
    : `with one retry at ${fallback}`;
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

async function runSearchForEntry(
  entry: IRegisteredVault,
  input: SearchNotesInput,
  deps: Pick<SearchNotesDeps, 'embeddingProvider' | 'modelKey' | 'similarity'> & {
    warn: (message: string) => void;
  },
): Promise<SearchNotesOutput> {
  const { listMatchingPaths } = entry;
  const { embeddingProvider, modelKey, similarity, warn } = deps;

  // Read once, up front — it describes the vault's index, not this
  // request, so the payload carries the value the call started from (design
  // D5) whichever legs run, and the semantic leg's go/no-go below is decided
  // from it rather than from a second read.
  const pinnedStatus = await entry.backend?.status();

  // `channel` picks which retrieval leg(s) run. `effort` maps onto the
  // internal quick|deep retrieval-policy vocabulary. `threshold` is
  // semantic-only; the lexical leg has no similarity score to threshold.
  // Every numeric bound is the schema's to enforce (ADR-0015).
  const channel = input.mode ?? 'hybrid';
  const effort = input.effort ?? 'quick';
  const { threshold, expansion_floor: expansionFloor, limit } = input;

  let allowed: Set<string> | undefined;

  // Filter-shape validation runs before query normalization, unchanged from
  // before `query_stats` existed — a malformed filter must still win over a
  // malformed query.
  if (input.filter !== undefined && isFilterEmpty(input.filter)) {
    throw new ToolHandlerError(
      'INVALID_ARGUMENT',
      'filter must specify at least one of: path_prefix, exclude_path_prefix, tags, frontmatter',
    );
  }

  // Normalized after filter-shape validation above.
  let isMulti: boolean;
  let queries: string[];
  if (Array.isArray(input.query)) {
    isMulti = true;
    queries = normalizeQueryArray(input.query);
  } else {
    isMulti = false;
    queries = [normalizeQuery(input.query)];
  }

  if (input.filter !== undefined) {
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
  }

  const cap = limit ?? EFFORT_PROFILES[effort].mergedCap;

  const backend = entry.backend;
  // The pipeline owns leg wiring, narrowing (a filter matching no notes reads
  // neither leg), existence filtering, fusion and the degrade-on-semantic-failure
  // policy, and reports what each leg did; this handler decides only WHETHER the
  // semantic leg should run — from the channel and the status pinned above,
  // never a fresh status() read.
  let result: Awaited<ReturnType<typeof runRetrievalPipeline>>;
  try {
    result = await runRetrievalPipeline(
      {
        queries,
        effort,
        semantic: channel !== 'lexical' && backend !== undefined && pinnedStatus?.state === 'ready',
        threshold,
        expansionFloor,
        cap,
        allowed,
      },
      {
        ...(backend !== undefined ? { corpus: backend } : {}),
        lexical: entry.lexical,
        filterExisting: (paths) => entry.filterExisting(paths),
        embeddingProvider,
        similarity,
      },
    );
  } catch (cause) {
    // The lexical leg is the one the semantic leg degrades to, so its failure
    // fails the vault's search outright; it never reads as a semantic failure.
    // Anything else keeps propagating as it always has.
    if (cause instanceof LexicalSearchError) {
      // The client gets the generic message; the cause (timeout, dropped
      // connection, daemon reason) is only ever written to stderr.
      warn(`neuro-vault lexical: search_notes failed for vault "${entry.name}": ${cause.message}`);
      throw new ToolHandlerError('DEPENDENCY_ERROR', 'Lexical search failed', {
        details: { vault: entry.name, operation: 'search_notes' },
        cause,
      });
    }
    throw cause;
  }

  const { warning, ...observability } = deriveObservability(result, {
    pinnedStatus,
    queries,
    isMulti,
    fallbackThreshold: similarity.fallback,
    vault: entry.name,
  });
  if (warning !== undefined) warn(warning);

  // Every match's `backlink_count` from one graph read; no match reads no graph.
  const backlinks =
    result.candidates.length === 0
      ? []
      : await graphForTool(entry, 'search_notes', warn).backlinkCounts(
          result.candidates.map((c) => c.path),
        );
  const kindOrder = ['title', 'heading', 'body'] as const;
  const matches: UnifiedMatch[] = result.candidates.map((c, i) => {
    const { semantic: sem, lexical: lex, expansion: exp } = c;
    const found_in: string[] = [
      ...(sem ? ['semantic'] : []),
      ...(lex
        ? kindOrder
            .filter((k) => lex.matches.some((m) => m.matched_in === k))
            .map((k) => `lexical:${k}`)
        : []),
      ...(exp ? ['expansion'] : []),
    ];
    const matchedQueries = isMulti
      ? [...new Set([...(sem?.matched_queries ?? []), ...(lex?.matchedQueries ?? [])])]
      : undefined;
    return {
      path: c.path,
      vault: entry.name,
      backlink_count: backlinks[i] ?? 0,
      found_in,
      ...(sem
        ? { similarity: sem.similarity, ...(sem.blocks.length > 0 ? { blocks: sem.blocks } : {}) }
        : {}),
      ...(lex ? { lexical: lex.matches } : {}),
      ...(exp ? { expansion_similarity: exp.expansion_similarity } : {}),
      ...(matchedQueries !== undefined ? { matched_queries: matchedQueries } : {}),
    };
  });

  return { matches, ...observability };
}

export function buildSearchNotesTool(
  deps: SearchNotesDeps,
): ITool<SearchNotesInput, SearchNotesOutput | IFanOutResult<SearchNotesOutput>> {
  const { registry, embeddingProvider, modelKey, similarity } = deps;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const entryDeps = { embeddingProvider, modelKey, similarity, warn };
  const SEARCH_NOTES_DESCRIPTION = [
    'Hybrid search over notes: fuses a semantic leg (embedding similarity — fuzzy recall, topic exploration, cross-language), a lexical leg (exact text over titles, headings and body — names, codes, terms) and, at deep effort, an expansion leg (neighbours of the semantic hits) into ONE reciprocal-rank-fused list. Pass short keyword queries (1-4 words), not sentences.',
    '',
    'QUERY WRITING:',
    '- Build the query from the core nouns and concepts in the user\'s message; drop filler words and verbs. "remind me what I wanted to build with LLM agents" → "LLM agents".',
    '- For synonyms, reformulations, or translations, pass all variants as ONE array (1-8 strings) in a SINGLE call rather than issuing separate searches.',
    '- A vault may hold notes in more than one language. When you have evidence of which languages are in use (earlier results, note titles, file names), add translations of the key concepts into each of those languages to the same array.',
    '',
    'AXES:',
    '- mode: "hybrid" (default) runs all legs; "lexical" runs ONLY exact text matching — works even when no embedding corpus exists.',
    `- effort: "quick" (default) — compact lookup (${EFFORT_PROFILES.quick.semanticPool} semantic notes, ~${EFFORT_PROFILES.quick.lexicalNoteCap} lexical, no expansion, merged cap ${EFFORT_PROFILES.quick.mergedCap}); "deep" — exploration (${EFFORT_PROFILES.deep.semanticPool} semantic, ~${EFFORT_PROFILES.deep.lexicalNoteCap} lexical, expansion on, merged cap ${EFFORT_PROFILES.deep.mergedCap}).`,
    '',
    'PARAMETERS:',
    '- query (required): string, or array of 1-8 strings for synonyms/translations — merged into one ranked list per leg; each result carries `matched_queries`.',
    '- limit: caps `matches[]` in every mode, overriding the effort default merged-list cap.',
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
    '',
    'RESPONSE SHAPE:',
    '- `matches[]` — one fused, ranked list; each note appears at most once. `found_in` names the leg(s) that surfaced it, and each leg that hit attaches its own evidence field. More than one leg on a note is the strongest relevance signal there is.',
    '- `truncated` — top-level, always present; true when candidates were dropped, either by the merged cap (recover by raising `limit`) or by a leg\'s internal pool cap (`limit` will NOT help — raise `effort` to "deep", or narrow `query`/`filter`).',
    '- `semantic_status` — top-level, always present: `{ state, indexed?, total? }` describing the VAULT\'s index, not this call. Every state but "ready" carries a `note` saying what it did to this response.',
    '- `expansion_similarity` (deep): note-to-note similarity to a semantic hit, not the query; not comparable with `similarity`.',
    '- `query_stats` — array queries only: per input query, PRE-cap hit counts `{ semantic, lexical }`. `semantic` is `null` when the semantic leg did not run at all; a number always means it ran. An entry worth acting on carries its own `note` diagnosing it.',
    '',
    'LEXICAL MATCHING: accent- and case-insensitive substring; a multiword query needs ALL tokens (AND), and a contiguous phrase ranks higher.',
    '',
    'EXAMPLES:',
    '- "where did I write about X?" → search_notes({query: "X"}).',
    '- exact name/code/term → search_notes({query: "PARAM_DICT", mode: "lexical"}).',
    '- "what do I know about Y?" → search_notes({query: "Y", effort: "deep"}).',
    '- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).',
    '',
    'PRE-FILTER (`filter`) — applies to every leg identically; at least one field required. `path_prefix`/`exclude_path_prefix` scope to / drop folder subtrees (string or array); `tags` matches ANY listed tag (no leading "#"); `frontmatter` is a sift filter, same operator allow-list as query_notes.',
  ].join('\n');

  return buildMultiVaultTool(registry, {
    name: 'search_notes',
    title: 'Search Notes',
    description: SEARCH_NOTES_DESCRIPTION,
    multiVaultNote:
      'A vault without a semantic index still contributes lexically-sourced matches; none are skipped.',
    inputShape: {
      query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
      mode: z.enum(['hybrid', 'lexical']).optional(),
      effort: z.enum(['quick', 'deep']).optional(),
      limit: z.number().int().positive().optional(),
      // Documented here rather than in the tool description: both are expert
      // floors, rarely the right reach, and their prose was mostly a warning
      // against using them — so it belongs next to the field being filled.
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          `Min semantic similarity 0-1 on the semantic leg's note scores. An explicit value is a hard filter with no fallback — zero hits are honest. Omitted: effort defaults (${similarity.quick} quick / ${similarity.deep} deep) ${retryClause(similarity.fallback)}. Never affects the lexical or expansion leg.`,
        ),
      expansion_floor: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          `Min seed↔note similarity 0-1 for the expansion leg (deep effort only); distinct from the query-to-note \`threshold\`. Default ${similarity.expansionFloor}, and \`threshold\` never affects it. On harrier-270m neighbour similarities sit at 0.75-0.95, so the default does not bind.`,
        ),
      filter: filterSchema.optional(),
    },
    runForEntry: (entry, input: SearchNotesInput) => runSearchForEntry(entry, input, entryDeps),
    single: payloadOnly,
  });
}
