import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';
import { executeMultiRetrieval, executeRetrieval } from '../retrieval-policy.js';
import { fuseRanks, flattenExpansion } from '../rank-fusion.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  pathExistsForEntry,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import type {
  BlockMatch,
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
import {
  LexicalIndex,
  type LexicalMatch,
  type RankedNote,
} from '../../../lib/obsidian/lexical/index.js';

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
  expansion_floor?: number;
  filter?: {
    path_prefix?: string | string[];
    exclude_path_prefix?: string | string[];
    tags?: string[];
    frontmatter?: Record<string, unknown>;
  };
}

// Internal per-leg pool caps (semantic seeds, lexical notes, expansion) are
// independent of the merged-list cap below — `effort` alone steers pool
// volume, `limit` (falling back to MERGED_CAP[effort]) steers only how much
// of the fused, ranked list the caller sees.
const MERGED_CAP = { quick: 5, deep: 12 } as const;

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

// A type alias (not `interface`) so it picks up TS's implicit index
// signature for object literal types — required for `IFanOutResult<T extends
// Record<string, unknown>>` in the multi-vault fan-out path below.
export type SearchNotesOutput = {
  matches: UnifiedMatch[];
  truncated: boolean;
  query_stats?: Record<
    string,
    {
      semantic: number | null;
      lexical: number;
      lexical_tokens?: Record<string, number>;
      semantic_fallback?: true;
    }
  >;
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

function isMultiNode(node: NoteResultNode | MultiNoteResultNode): node is MultiNoteResultNode {
  return 'matched_queries' in node;
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
function buildQueryStats(
  isMulti: boolean,
  queries: string[],
  lexicalPerQueryCounts: Record<string, number>,
  lexicalPerQueryTokenCounts: Record<string, Record<string, number>>,
  semanticPerQueryHits: Record<string, number> | undefined,
  semanticPerQueryFallback: Record<string, boolean> | undefined,
  semanticRan: boolean,
): SearchNotesOutput['query_stats'] {
  if (!isMulti) return undefined;
  return Object.fromEntries(
    queries.map((q) => {
      const tokenCounts = lexicalPerQueryTokenCounts[q];
      return [
        q,
        {
          semantic: semanticRan ? (semanticPerQueryHits?.[q] ?? 0) : null,
          lexical: lexicalPerQueryCounts[q] ?? 0,
          ...(tokenCounts !== undefined ? { lexical_tokens: tokenCounts } : {}),
          ...(semanticRan && semanticPerQueryFallback?.[q]
            ? { semantic_fallback: true as const }
            : {}),
        },
      ];
    }),
  );
}

// Fuses the three rank sources (semantic seeds, lexical notes, flattened
// expansion) into one RRF-ranked, cap-sliced `matches[]` list. `semanticNodes`
// must already be existence-checked (both the seed itself and every path in
// its `related[]`) — lexical notes are existence-safe by construction since
// they were read from disk this request.
function assembleUnified(args: {
  semanticNodes: (NoteResultNode | MultiNoteResultNode)[];
  lexicalNotes: RankedNote[];
  entry: IVaultEntry;
  totalNotes: number;
  cap: number;
  isMulti: boolean;
  // True when a source leg's internal pool cap already dropped candidates
  // (lexical `noteCap`, or the multi-query semantic merge cap) before fusion
  // ever ran. `truncated` must reflect this even when the merged cap itself
  // isn't hit — e.g. lexical mode with more matches than `lexCap` but fewer
  // than the merged cap.
  legTruncated: boolean;
}): SearchNotesOutput {
  const { semanticNodes, lexicalNotes, entry, totalNotes, cap, isMulti, legTruncated } = args;
  const expansion = flattenExpansion(semanticNodes);
  const semanticByPath = new Map(semanticNodes.map((n) => [n.path, n]));
  const lexicalByPath = new Map(lexicalNotes.map((n) => [n.path, n]));
  const expansionByPath = new Map(expansion.map((e) => [e.path, e]));
  const fused = fuseRanks({
    sources: {
      semantic: semanticNodes.map((n) => n.path),
      lexical: lexicalNotes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes,
  });
  const kindOrder = ['title', 'heading', 'body'] as const;
  const matches: UnifiedMatch[] = fused.slice(0, cap).map((c) => {
    const sem = semanticByPath.get(c.path);
    const lex = lexicalByPath.get(c.path);
    const exp = expansionByPath.get(c.path);
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
      ? [
          ...new Set([
            ...(sem && isMultiNode(sem) ? sem.matched_queries : []),
            ...(lex?.matchedQueries ?? []),
          ]),
        ]
      : undefined;
    return {
      path: c.path,
      vault: entry.name,
      backlink_count: entry.graph.getBacklinkCount(c.path),
      found_in,
      ...(sem
        ? {
            similarity: sem.similarity,
            ...(sem.blocks.length > 0 ? { blocks: sem.blocks } : {}),
          }
        : {}),
      ...(lex ? { lexical: lex.matches } : {}),
      ...(exp ? { expansion_similarity: exp.expansion_similarity } : {}),
      ...(matchedQueries !== undefined ? { matched_queries: matchedQueries } : {}),
    };
  });
  return { matches, truncated: fused.length > cap || legTruncated };
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
      const query_stats = buildQueryStats(isMulti, queries, {}, {}, undefined, undefined, false);
      return {
        matches: [],
        truncated: false,
        ...(query_stats !== undefined ? { query_stats } : {}),
      };
    }
  }

  // Merged-list cap: `limit` overrides the effort default in every mode and
  // bounds only the final fused list — it no longer steers either leg's
  // internal pool. The lexical pool cap is the effort default alone.
  const cap = limit ?? MERGED_CAP[effort];
  const lexCap = effort === 'deep' ? 10 : 5;

  await graph.ensureFresh();
  const lexical = await lexicalFor(entry).search({
    queries,
    allowed,
    noteCap: lexCap,
    perNoteCap: 3,
    getBacklinkCount: (p) => graph.getBacklinkCount(p),
  });

  // `mode: "lexical"` never touches the corpus loader. A vault without an
  // available semantic corpus (cold/absent) also falls back to lexical-only
  // rather than throwing — an available corpus that errors mid-search still
  // throws DEPENDENCY_ERROR below, unchanged.
  if (channel === 'lexical' || !entry.semanticAvailable || entry.corpus === undefined) {
    const query_stats = buildQueryStats(
      isMulti,
      queries,
      lexical.perQueryCounts,
      lexical.perQueryTokenCounts,
      undefined,
      undefined,
      false,
    );
    return {
      ...assembleUnified({
        semanticNodes: [],
        lexicalNotes: lexical.notes,
        entry,
        totalNotes: lexical.totalNotes,
        cap,
        isMulti,
        legTruncated: lexical.truncated,
      }),
      ...(query_stats !== undefined ? { query_stats } : {}),
    };
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
    // `limit` is deliberately NOT forwarded here — it bounds only the final
    // fused list (via `cap` below), never either leg's internal pool size.
    // Both `executeRetrieval` and `executeMultiRetrieval` surface their own
    // `truncated` (a leg-level pool-cap overflow, independent of `cap`) —
    // captured below as `semanticLegTruncated` and folded into `legTruncated`
    // so every leg's pool overflow is surfaced, not just lexical's.
    let rawSemanticNodes: (NoteResultNode | MultiNoteResultNode)[];
    let semanticLegTruncated: boolean;
    let semanticPerQueryHits: Record<string, number> | undefined;
    let semanticPerQueryFallback: Record<string, boolean> | undefined;
    if (isMulti) {
      const output = await executeMultiRetrieval({
        queries,
        mode: effort,
        threshold,
        expansionFloor,
        sources: effectiveSources,
        embeddingProvider,
        searchEngine,
      });
      rawSemanticNodes = output.results;
      semanticLegTruncated = output.truncated;
      semanticPerQueryHits = output.per_query_hits;
      semanticPerQueryFallback = output.per_query_fallback;
    } else {
      const output = await executeRetrieval({
        query: queries[0],
        mode: effort,
        threshold,
        expansionFloor,
        sources: effectiveSources,
        embeddingProvider,
        searchEngine,
      });
      rawSemanticNodes = output.results;
      semanticLegTruncated = output.truncated;
    }

    // Existence check covers semantic seeds AND their flattened expansion
    // targets before fusion — lexical notes are existence-safe by
    // construction (read from disk this request). This flattening pass is
    // only to collect candidate paths to existence-check; `assembleUnified`
    // below recomputes `flattenExpansion` from the existence-filtered
    // `semanticNodes` — intentionally, since the seed set (and each seed's
    // `related[]`) narrows after the existence check, and the expansion
    // source must reflect only surviving seeds/paths.
    const rawExpansion = flattenExpansion(rawSemanticNodes);
    const candidatePaths: string[] = [
      ...rawSemanticNodes.map((n) => n.path),
      ...rawExpansion.map((e) => e.path),
    ];
    const existing = await buildExistingPathSet(entry, candidatePaths);
    const semanticNodes = rawSemanticNodes
      .filter((n) => existing.has(n.path))
      .map((n) => ({ ...n, related: n.related.filter((rel) => existing.has(rel.path)) }));

    const query_stats = buildQueryStats(
      isMulti,
      queries,
      lexical.perQueryCounts,
      lexical.perQueryTokenCounts,
      semanticPerQueryHits,
      semanticPerQueryFallback,
      true,
    );
    return {
      ...assembleUnified({
        semanticNodes,
        lexicalNotes: lexical.notes,
        entry,
        totalNotes: lexical.totalNotes,
        cap,
        isMulti,
        legTruncated: lexical.truncated || semanticLegTruncated,
      }),
      ...(query_stats !== undefined ? { query_stats } : {}),
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
  const SEARCH_NOTES_DESCRIPTION = [
    'Hybrid search over notes: fuses a semantic leg (embedding similarity — fuzzy recall, topic exploration, cross-language), a lexical leg (exact text matches over note titles, headings, and body — names, codes, terms), and (deep effort) an expansion leg (neighbours of the semantic hits) into ONE reciprocal-rank-fused list. Pass short keyword queries (1-4 words), not sentences.',
    '',
    'QUERY WRITING:',
    '- Build the query from the core nouns and concepts in the user\'s message; drop filler words and verbs. "remind me what I wanted to build with LLM agents" → "LLM agents".',
    '- For synonyms, reformulations, or translations, pass all variants as ONE array (1-8 strings) in a SINGLE call rather than issuing separate searches.',
    '- A vault may hold notes in more than one language. When you have evidence of which languages are in use (earlier results, note titles, file names), add translations of the key concepts into each of those languages to the same array.',
    '',
    'AXES:',
    '- mode: "hybrid" (default) runs all legs; "lexical" runs ONLY exact text matching — works even when no embedding corpus exists.',
    '- effort: "quick" (default) — compact lookup (up to 3 semantic notes, ~5 lexical, no expansion, merged list capped at 5); "deep" — exploration (up to 8 semantic notes, ~10 lexical, expansion leg active, merged list capped at 12).',
    '',
    'PARAMETERS:',
    '- query (required): string, or array of 1-8 strings for synonyms/translations — merged into one ranked list per leg; each result carries `matched_queries`.',
    '- mode: "hybrid" | "lexical" (default "hybrid").',
    '- effort: "quick" | "deep" (default "quick").',
    "- limit: caps `matches[]` in every mode, overriding the effort default merged-list cap. Does not change either leg's internal pool size.",
    "- threshold: min similarity 0-1, hard filter on the semantic leg's note scores — an explicit value is enforced with no fallback (zero hits are honest). When omitted, effort defaults apply (0.5 quick / 0.35 deep) with a one-shot retry at 0.3 if nothing passes, flagged per query as `semantic_fallback` in `query_stats`.",
    '- expansion_floor: min seed↔note similarity 0-1 for the expansion leg (deep effort only; this note-to-note scale runs much higher than query scores — 0.9+ is typical). Default 0.35. threshold never affects expansion.',
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
    '',
    'RESPONSE SHAPE:',
    '- `matches[]` — one fused, ranked list. Each entry: `path`, `vault`, `backlink_count`, `found_in` (which source(s) surfaced it: "semantic", "lexical:title"|"lexical:heading"|"lexical:body", "expansion" — always non-empty), plus evidence fields present only for the sources that hit: `similarity` (semantic; `blocks[]` accompanies it whenever the note has block-level evidence — non-empty when present, absent for a note without block embeddings), `lexical[]` (snippet matches, max ~3, `{ matched_in, snippet, lines?, heading? }`), `expansion_similarity` (expansion).',
    '- `truncated` — top-level, always present; true when candidates were dropped by the merged cap or the semantic or lexical leg\'s internal pool cap. The two causes need different fixes: merged-cap truncation is recovered by raising `limit`; the semantic or lexical leg\'s pool-cap truncation is NOT — raise `effort` to "deep" (or narrow `query`/`filter`) instead.',
    '- `query_stats` — array queries only (omitted for a single string `query`): `{ [query]: { semantic, lexical } }`, PRE-cap hit counts (before cross-query merging and before the `matches[]` cap) per input query. `semantic` is `null` when the semantic leg did not run (mode "lexical", no corpus, empty filter set) — a number always means the leg ran; `{ semantic: 0, lexical: 0 }` marks a dead variant worth rephrasing or dropping. When the lexical leg ran and `lexical` is 0 for a multi-word query, `lexical_tokens` maps each token to the count of notes it matches alone — a zero names the token that killed the AND match; drop or replace that token. If every token is non-zero, the tokens exist but never co-occur within one title/heading/paragraph — split the query into an array so each token can match independently. (Omitted when the leg never ran, e.g. a filter matching zero notes.) `semantic_fallback: true` marks a query whose semantic hits came from the default-threshold 0.3 retry (absent otherwise, and never present with an explicit `threshold`).',
    '',
    'LEXICAL MATCHING: case-, accent-, and apostrophe-variant-insensitive substring; multiword query = ALL tokens must appear (AND), contiguous phrase ranks higher. A note surfaced by multiple legs ranks higher via rank fusion — that is the strongest relevance signal.',
    '',
    'INVARIANTS:',
    '- `similarity` appears ONLY when `found_in` contains "semantic"; `blocks[]` only alongside `similarity` and never empty (absent when the note has no block embeddings); `lexical[]` only when `found_in` contains a "lexical:*" value; `expansion_similarity` only when it contains "expansion".',
    '- Each note appears at most once in `matches[]`, even when multiple legs surface it.',
    '',
    'EXAMPLES:',
    '- "where did I write about X?" → search_notes({query: "X"}).',
    '- exact name/code/term → search_notes({query: "PARAM_DICT", mode: "lexical"}).',
    '- "what do I know about Y?" → search_notes({query: "Y", effort: "deep"}).',
    '- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).',
    '',
    'PRE-FILTER (filter parameter) — applies to every leg identically:',
    '  Shape: { path_prefix?, exclude_path_prefix?, tags?, frontmatter? }. At least one field required.',
    '  - path_prefix / exclude_path_prefix: scope to / drop folder subtrees (string or array).',
    '  - tags: notes with ANY of these tags (no leading "#").',
    '  - frontmatter: sift filter on frontmatter keys, same operator allow-list as query_notes.',
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
      threshold: z.number().min(0).max(1).optional(),
      expansion_floor: z.number().min(0).max(1).optional(),
      filter: filterSchema.optional(),
    },
    runForEntry: (entry, input: SearchNotesInput) => runSearchForEntry(entry, input, entryDeps),
    single: payloadOnly,
  });
}
