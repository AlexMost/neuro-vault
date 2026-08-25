import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { IFanOutResult } from '../../../lib/fan-out.js';
import { buildMultiVaultTool, payloadOnly } from '../../../lib/multi-vault-tool.js';
import { executeRetrieval } from '../retrieval-policy.js';
import { fuseRanks, flattenExpansion } from '../rank-fusion.js';
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
  NoteResultNode,
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
  semanticPerQueryHits: Record<string, number>,
  semanticPerQueryFallback: Record<string, boolean>,
  semanticRan: boolean,
): SearchNotesOutput['query_stats'] {
  if (!isMulti) return undefined;
  return Object.fromEntries(
    queries.map((q) => {
      const tokenCounts = lexicalPerQueryTokenCounts[q];
      return [
        q,
        {
          semantic: semanticRan ? (semanticPerQueryHits[q] ?? 0) : null,
          lexical: lexicalPerQueryCounts[q] ?? 0,
          ...(tokenCounts !== undefined ? { lexical_tokens: tokenCounts } : {}),
          ...(semanticRan && semanticPerQueryFallback[q]
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
  semanticNodes: NoteResultNode[];
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
}): Pick<SearchNotesOutput, 'matches' | 'truncated'> {
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
      ? [...new Set([...(sem?.matched_queries ?? []), ...(lex?.matchedQueries ?? [])])]
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
      const query_stats = buildQueryStats(isMulti, queries, {}, {}, {}, {}, false);
      return {
        matches: [],
        truncated: false,
        semantic_status,
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

  /**
   * The lexical-only payload, under whatever `semantic_status` describes the
   * response being built. Shared by the three ways a search ends up here: the
   * `mode: "lexical"` request, the not-`ready` backend, and the semantic leg
   * that failed after the lexical matches were already in hand.
   */
  const lexicalOnly = (status: SemanticStatusField): SearchNotesOutput => {
    const query_stats = buildQueryStats(
      isMulti,
      queries,
      lexical.perQueryCounts,
      lexical.perQueryTokenCounts,
      {},
      {},
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
      semantic_status: status,
      ...(query_stats !== undefined ? { query_stats } : {}),
    };
  };

  // `mode: "lexical"` never touches the backend. A vault without a ready
  // semantic backend (absent, indexing, disabled, unavailable) also falls
  // back to lexical-only rather than throwing. Branches on
  // the `semantic_status` captured once above, NOT a fresh `status()` call —
  // `status()` reads a mutable value a background pass can flip (e.g.
  // indexing -> ready) across the `await`s above (graph.ensureFresh, lexical
  // search); re-reading here could let the semantic leg run below while this
  // check still saw the old state, producing a payload whose `semantic_status`
  // contradicts which leg actually ran. `entry.backend === undefined` stays
  // as its own disjunct because TS needs it to narrow `entry.backend` for the
  // semantic leg below, independent of what `semantic_status` says.
  if (channel === 'lexical' || entry.backend === undefined || semantic_status.state !== 'ready') {
    return lexicalOnly(semantic_status);
  }

  const backend = entry.backend;

  try {
    const { sources } = await backend.snapshot();
    const effectiveSources = allowed !== undefined ? narrowSources(sources, allowed) : sources;
    // `limit` is deliberately NOT forwarded here — it bounds only the final
    // fused list (via `cap` below), never either leg's internal pool size.
    // `executeRetrieval` surfaces its own `truncated` (a leg-level pool-cap
    // overflow, independent of `cap`), folded into `legTruncated` below so
    // every leg's pool overflow is surfaced, not just lexical's.
    const semantic = await executeRetrieval({
      queries,
      mode: effort,
      threshold,
      expansionFloor,
      sources: effectiveSources,
      embeddingProvider,
      searchEngine,
    });
    const rawSemanticNodes = semantic.results;

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
    const existing = await entry.filterExisting(candidatePaths);
    const semanticNodes = rawSemanticNodes
      .filter((n) => existing.has(n.path))
      .map((n) => ({ ...n, related: n.related.filter((rel) => existing.has(rel.path)) }));

    const query_stats = buildQueryStats(
      isMulti,
      queries,
      lexical.perQueryCounts,
      lexical.perQueryTokenCounts,
      semantic.per_query_hits,
      semantic.per_query_fallback,
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
        legTruncated: lexical.truncated || semantic.truncated,
      }),
      semantic_status,
      ...(query_stats !== undefined ? { query_stats } : {}),
    };
  } catch (error) {
    // The semantic leg is the only thing inside this `try`, and the lexical
    // matches above are already computed — so a failure here degrades rather
    // than throwing them away. The spec is explicit: the lexical leg works
    // whatever state the corpus is in, "absent, still building, disabled, or
    // unreadable", and semantic-leg failure SHALL NOT fail it. This is the
    // path a rejected query embedding takes (no model on disk, an unwritable
    // cache, an ONNX load failure) on a backend that reported `ready`.
    //
    // The reported state is `unavailable`, not the pinned `ready`: the field
    // has to describe the response the client is holding, and a lexical-only
    // payload labelled `ready` is exactly the contradiction the pinning above
    // exists to prevent. The failure itself goes to stderr — degrading is not
    // swallowing, and stdout is the MCP transport.
    warn(
      `neuro-vault semantic: search_notes fell back to its lexical leg for vault "${entry.name}": ${String(error)}`,
    );
    return lexicalOnly({ state: 'unavailable', note: DEGRADED_NOTES.unavailable });
  }
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
    "- limit: caps `matches[]` in every mode, overriding the effort default merged-list cap. Does not change either leg's internal pool size.",
    "- threshold: min similarity 0-1 on the semantic leg's note scores. An explicit value is a hard filter with no fallback (zero hits are honest). Omitted → effort defaults (0.5 quick / 0.35 deep) plus one retry at 0.3, flagged as `semantic_fallback` in `query_stats`.",
    '- expansion_floor: min seed↔note similarity 0-1 for the expansion leg (deep only). This note-to-note scale runs far higher than query scores — 0.9+ is typical. Default 0.35; threshold never affects it.',
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
    '',
    'RESPONSE SHAPE:',
    '- `matches[]` — one fused, ranked list; each note appears at most once. `found_in` names the leg(s) that surfaced it ("semantic", "lexical:title"|"lexical:heading"|"lexical:body", "expansion") and is never empty; each leg that hit attaches its own evidence field. More than one leg on a note is the strongest relevance signal there is.',
    '- `truncated` — top-level, always present; true when candidates were dropped, either by the merged cap (recover by raising `limit`) or by a leg\'s internal pool cap (`limit` will NOT help — raise `effort` to "deep", or narrow `query`/`filter`).',
    '- `semantic_status` — top-level, always present: `{ state: "ready"|"indexing"|"disabled"|"unavailable", indexed?, total? }`, describing the VAULT\'s index, not this request. Every state but "ready" carries a `note` saying what it did to this response. "ready" is about the index, not this call — the semantic leg never runs under `mode: "lexical"` or on an empty-filter result; read `query_stats.semantic` for that.',
    '- `query_stats` — array queries only: per input query, PRE-cap hit counts `{ semantic, lexical }` (before cross-query merging and before the `matches[]` cap). `semantic` is `null` when the semantic leg did not run (mode "lexical", no index, empty filter set); a number always means it ran, so `{ semantic: 0, lexical: 0 }` marks a dead variant worth rephrasing or dropping. When the lexical leg ran and `lexical` is 0 on a multi-word query, `lexical_tokens` counts the notes each token matches alone: a zero names the token that killed the AND match — drop or replace it; all non-zero means the tokens never co-occur in one title/heading/paragraph — split the query into an array.',
    '',
    'LEXICAL MATCHING: case-, accent-, and apostrophe-variant-insensitive substring; multiword query = ALL tokens must appear (AND), contiguous phrase ranks higher.',
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
      threshold: z.number().min(0).max(1).optional(),
      expansion_floor: z.number().min(0).max(1).optional(),
      filter: filterSchema.optional(),
    },
    runForEntry: (entry, input: SearchNotesInput) => runSearchForEntry(entry, input, entryDeps),
    single: payloadOnly,
  });
}
