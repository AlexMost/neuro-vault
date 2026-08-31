import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';
import { EFFORT_PROFILES } from '../effort-profiles.js';
import { runRetrievalPipeline } from '../retrieval-pipeline.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import type {
  BlockMatch,
  EmbeddingProvider,
  NoteFilter,
  SearchChannelMode,
  SearchEffort,
  SearchEngine,
} from '../types.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';
import { LexicalIndex, type LexicalMatch } from '../../../lib/obsidian/lexical/index.js';
import type { BackendState, BackendStatus } from '../../../lib/obsidian/semantic-backend.js';

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

/**
 * Describes the vault's semantic INDEX, not this request — required on every
 * `search_notes` payload (design D5), including `mode: "lexical"` and the
 * empty-filter early return, so a client never has to read an omitted field
 * as "healthy". `indexed`/`total` ride along only while `state ===
 * "indexing"`. `reason` (present on `BackendStatus` for `unavailable`) is
 * deliberately NOT exposed here — it belongs on error payloads, not on a
 * successful search result.
 */
export interface SemanticStatusField {
  state: BackendState;
  indexed?: number;
  total?: number;
  /** Present for every state but `ready` — see `DEGRADED_NOTES`. */
  note?: string;
}

export type SearchNotesOutput = {
  matches: UnifiedMatch[];
  truncated: boolean;
  semantic_status: SemanticStatusField;
  query_stats?: Record<
    string,
    {
      semantic: number | null;
      lexical: number;
      lexical_tokens?: Record<string, number>;
      semantic_fallback?: true;
      /** Present only for an entry worth acting on — see `queryStatsNote`. */
      note?: string;
    }
  >;
};

// What a non-`ready` state did to THIS response, in one sentence per state.
// It rides on the payload rather than in the tool's description because a
// description is paid for on every `tools/list` while this is read only on
// the responses it applies to — the response channel of ADR-0010. Not the
// backend's `reason`: that is why the backend is in this state, it travels on
// error payloads, and it is deliberately not exposed here.
const DEGRADED_NOTES: Record<Exclude<BackendState, 'ready'>, string> = {
  indexing:
    'The semantic leg did not run — the index is still building, so these matches are lexical-only.',
  disabled:
    'The semantic leg did not run — semantic search is turned off for this vault, so these matches are lexical-only.',
  unavailable:
    'The semantic leg did not run — this vault has no usable semantic index, so these matches are lexical-only.',
};

// An absent backend means the semantic module is globally off for this
// server; it is reported as `unavailable` (same branch `resolveSemanticVault`
// uses for a backend that reports its own failure reason), just without the
// `reason` string — that detail belongs on error payloads, not here.
function toStatusField(status: BackendStatus | undefined): SemanticStatusField {
  const state = status?.state ?? 'unavailable';
  return {
    state,
    ...(status?.state === 'indexing'
      ? { indexed: status.indexed ?? 0, total: status.total ?? 0 }
      : {}),
    ...(state === 'ready' ? {} : { note: DEGRADED_NOTES[state] }),
  };
}

export interface SearchNotesDeps {
  registry: IVaultRegistry;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  /** Defaults to console.error — diagnostics must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
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

// Pre-cap per-query hit counts for array queries. `semantic` is `null` when
// the semantic leg never executed (lexical mode, no corpus, empty-filter
// early return) — a number always means the leg ran and counted (0 = ran,
// found nothing). `lexical` counts over the leg's candidate set pre
// `noteCap` (0 over an empty filter set). `lexical_tokens` rides along only
// where it explains a zero: a multi-token query with `lexical: 0` maps each
// normalized token to how many notes it matches alone. Counts are taken
// before the cross-query merge and before the final `matches[]` cap.
// `undefined` for a single string query — `query_stats` is array-query-only.
// What to do about a query variant that misfired, decided per entry and
// emitted only when there is something to do. This is the response channel of
// ADR-0010: the same guidance in the tool's description would be paid for on
// every `tools/list`, in every session, while a dead variant is rare — and a
// caller reading one of these entries is holding the numbers the advice is
// about. Ordered by what a caller acts on first: a variant that hit nothing
// anywhere is dropped before its tokens are worth diagnosing, and a token
// diagnosis outranks a note about the quality of hits that did come back.
function queryStatsNote(args: {
  semantic: number | null;
  lexical: number;
  tokenCounts: Record<string, number> | undefined;
  fallback: boolean;
}): string | undefined {
  const { semantic, lexical, tokenCounts, fallback } = args;
  if (lexical === 0 && (semantic === null || semantic === 0)) {
    if (tokenCounts === undefined) {
      return 'No hits in any leg that ran — rephrase or drop this variant.';
    }
    const dead = Object.keys(tokenCounts).filter((token) => tokenCounts[token] === 0);
    if (dead.length > 0) {
      return `No hits: ${dead.map((t) => `"${t}"`).join(', ')} match no note alone, which kills the AND match — drop or replace ${dead.length > 1 ? 'them' : 'it'}.`;
    }
    return 'No hits: every token matches on its own but they never co-occur in one title, heading or paragraph — split this variant into separate array entries.';
  }
  if (fallback) {
    return 'Semantic hits came from the 0.3 fallback retry, so they are weaker than a normal result.';
  }
  return undefined;
}

function buildQueryStats(args: {
  isMulti: boolean;
  queries: string[];
  lexicalPerQueryCounts: Record<string, number>;
  lexicalPerQueryTokenCounts: Record<string, Record<string, number>>;
  semanticPerQueryHits: Record<string, number>;
  semanticPerQueryFallback: Record<string, boolean>;
  semanticRan: boolean;
  /**
   * False on the empty-filter early return, where neither leg executed. A
   * zero there says the filter matched no notes, not that the variant is
   * dead — diagnosing it as dead would send the caller to rewrite a query
   * that was never tried.
   */
  lexicalRan: boolean;
}): SearchNotesOutput['query_stats'] {
  const {
    isMulti,
    queries,
    lexicalPerQueryCounts,
    lexicalPerQueryTokenCounts,
    semanticPerQueryHits,
    semanticPerQueryFallback,
    semanticRan,
    lexicalRan,
  } = args;
  if (!isMulti) return undefined;
  return Object.fromEntries(
    queries.map((q) => {
      const tokenCounts = lexicalPerQueryTokenCounts[q];
      const semantic = semanticRan ? (semanticPerQueryHits[q] ?? 0) : null;
      const lexical = lexicalPerQueryCounts[q] ?? 0;
      const fallback = semanticRan && semanticPerQueryFallback[q] === true;
      const note =
        semanticRan || lexicalRan
          ? queryStatsNote({ semantic, lexical, tokenCounts, fallback })
          : undefined;
      return [
        q,
        {
          semantic,
          lexical,
          ...(tokenCounts !== undefined ? { lexical_tokens: tokenCounts } : {}),
          ...(fallback ? { semantic_fallback: true as const } : {}),
          ...(note !== undefined ? { note } : {}),
        },
      ];
    }),
  );
}

async function runSearchForEntry(
  entry: IVaultEntry,
  input: SearchNotesInput,
  deps: Pick<SearchNotesDeps, 'embeddingProvider' | 'searchEngine' | 'modelKey'> & {
    lexicalFor: (entry: IVaultEntry) => LexicalIndex;
    warn: (message: string) => void;
  },
): Promise<SearchNotesOutput> {
  const { graph, listMatchingPaths } = entry;
  const { embeddingProvider, searchEngine, modelKey, lexicalFor, warn } = deps;

  // Read once, up front — it describes the vault's index, not this
  // request, so every return path below (including the empty-filter early
  // return and `mode: "lexical"`, which never touch the backend otherwise)
  // carries the same value (design D5).
  const semantic_status = toStatusField(entry.backend?.status());

  // `channel` picks which retrieval leg(s) run. `effort` maps onto the
  // internal quick|deep retrieval-policy vocabulary. `threshold` is
  // semantic-only; the lexical leg has no similarity score to threshold.
  const channel = input.mode ?? 'hybrid';
  const effort = input.effort ?? 'quick';
  const threshold =
    input.threshold !== undefined
      ? readThreshold(input.threshold, input.threshold, 'threshold')
      : undefined;
  const expansionFloor =
    input.expansion_floor !== undefined
      ? readThreshold(input.expansion_floor, input.expansion_floor, 'expansion_floor')
      : undefined;
  const limit =
    input.limit !== undefined ? readPositiveInteger(input.limit, input.limit, 'limit') : undefined;

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

  // Normalized after filter-shape validation above but before the
  // empty-filter early return below, which needs `queries` to attach
  // `query_stats` (array queries only).
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

    if (allowed.size === 0) {
      const query_stats = buildQueryStats({
        isMulti,
        queries,
        lexicalPerQueryCounts: {},
        lexicalPerQueryTokenCounts: {},
        semanticPerQueryHits: {},
        semanticPerQueryFallback: {},
        semanticRan: false,
        lexicalRan: false,
      });
      return {
        matches: [],
        truncated: false,
        semantic_status,
        ...(query_stats !== undefined ? { query_stats } : {}),
      };
    }
  }

  const cap = limit ?? EFFORT_PROFILES[effort].mergedCap;

  await graph.ensureFresh();
  const backend = entry.backend;
  // The pipeline owns leg wiring, narrowing, existence filtering, fusion and
  // the degrade-on-semantic-failure policy; this handler decides only WHETHER
  // the semantic leg should run — from the channel and the status pinned
  // above, never a fresh status() read — and how to word the outcome.
  const result = await runRetrievalPipeline(
    {
      queries,
      effort,
      semantic: channel !== 'lexical' && backend !== undefined && semantic_status.state === 'ready',
      threshold,
      expansionFloor,
      cap,
      allowed,
    },
    {
      ...(backend !== undefined ? { snapshot: () => backend.snapshot() } : {}),
      lexical: lexicalFor(entry),
      getBacklinkCount: (p) => graph.getBacklinkCount(p),
      filterExisting: (paths) => entry.filterExisting(paths),
      embeddingProvider,
      searchEngine,
    },
  );

  if (result.semantic.status === 'failed') {
    warn(
      `neuro-vault semantic: search_notes fell back to its lexical leg for vault "${entry.name}": ${String(result.semantic.error)}`,
    );
  }
  const status =
    result.semantic.status === 'failed'
      ? { state: 'unavailable' as const, note: DEGRADED_NOTES.unavailable }
      : semantic_status;

  const semanticOutcome = result.semantic;
  const semanticRan = semanticOutcome.status === 'ran';
  const query_stats = buildQueryStats({
    isMulti,
    queries,
    lexicalPerQueryCounts: result.lexical.perQueryCounts,
    lexicalPerQueryTokenCounts: result.lexical.perQueryTokenCounts,
    semanticPerQueryHits: semanticRan ? semanticOutcome.perQueryHits : {},
    semanticPerQueryFallback: semanticRan ? semanticOutcome.perQueryFallback : {},
    semanticRan,
    lexicalRan: true,
  });

  const kindOrder = ['title', 'heading', 'body'] as const;
  const matches: UnifiedMatch[] = result.candidates.map((c) => {
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
      backlink_count: entry.graph.getBacklinkCount(c.path),
      found_in,
      ...(sem
        ? { similarity: sem.similarity, ...(sem.blocks.length > 0 ? { blocks: sem.blocks } : {}) }
        : {}),
      ...(lex ? { lexical: lex.matches } : {}),
      ...(exp ? { expansion_similarity: exp.expansion_similarity } : {}),
      ...(matchedQueries !== undefined ? { matched_queries: matchedQueries } : {}),
    };
  });

  return {
    matches,
    truncated: result.truncated,
    semantic_status: status,
    ...(query_stats !== undefined ? { query_stats } : {}),
  };
}

export function buildSearchNotesTool(
  deps: SearchNotesDeps,
): ITool<SearchNotesInput, SearchNotesOutput | IFanOutResult<SearchNotesOutput>> {
  const { registry, embeddingProvider, searchEngine, modelKey } = deps;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  // Per-vault lexical indexes, created lazily; the Map lives for the tool's
  // lifetime. Never touches the embedding corpus — it's a read-through
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

  const entryDeps = { embeddingProvider, searchEngine, modelKey, lexicalFor, warn };
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
    '- effort: "quick" (default) — compact lookup (3 semantic notes, ~5 lexical, no expansion, merged cap 5); "deep" — exploration (8 semantic, ~10 lexical, expansion on, merged cap 12).',
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
          "Min semantic similarity 0-1 on the semantic leg's note scores. An explicit value is a hard filter with no fallback — zero hits are honest. Omitted: effort defaults (0.5 quick / 0.35 deep) with one retry at 0.3. Never affects the lexical or expansion leg.",
        ),
      expansion_floor: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Min seed↔note similarity 0-1 for the expansion leg (deep effort only). A note-to-note scale that runs far higher than query scores — 0.9+ is typical. Default 0.35, and `threshold` never affects it.',
        ),
      filter: filterSchema.optional(),
    },
    runForEntry: (entry, input: SearchNotesInput) => runSearchForEntry(entry, input, entryDeps),
    single: payloadOnly,
  });
}
