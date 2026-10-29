import {
  CorpusNotReadyError,
  type BackendState,
  type BackendStatus,
} from '../../lib/obsidian/semantic-backend.js';
import type { LexicalLegOutcome, SemanticLegOutcome } from './retrieval-pipeline.js';

/**
 * Describes the vault's semantic INDEX, not this request — required on every
 * `search_notes` payload (design D5), including `mode: "lexical"` and a filter
 * that matched no notes, so a client never has to read an omitted field as
 * "healthy". `indexed`/`total` ride along only while `state === "indexing"`.
 * `reason` (present on `BackendStatus` for `unavailable`) is deliberately NOT
 * exposed here — it belongs on error payloads, not on a successful search result.
 */
export interface SemanticStatusField {
  state: BackendState;
  indexed?: number;
  total?: number;
  /** Present for every state but `ready` — see `DEGRADED_NOTES`. */
  note?: string;
}

/**
 * Pre-cap hit counts for one array-query variant. `semantic` is `null` when
 * the semantic leg did not run (lexical mode, no corpus, a failed leg, a filter
 * that matched no notes) — a number always means the leg ran and counted (0 =
 * ran, found nothing). `lexical` counts over the leg's candidate set pre
 * `noteCap` (0 when the leg did not run). `lexical_tokens` rides along only
 * where it explains a zero: a multi-token query with `lexical: 0` maps each
 * normalized token to how many notes it matches alone. Counts are taken before
 * the cross-query merge and before the final `matches[]` cap.
 */
export interface QueryStatsEntry {
  semantic: number | null;
  lexical: number;
  lexical_tokens?: Record<string, number>;
  semantic_fallback?: true;
  /** Present only for an entry worth acting on — see `queryStatsNote`. */
  note?: string;
}

/** What the retrieval pipeline reports: one record per leg, plus the merged cap's cut. */
export interface LegOutcomes {
  semantic: SemanticLegOutcome;
  lexical: LexicalLegOutcome;
  truncated: boolean;
}

export interface ObservabilityContext {
  /**
   * The vault's backend status, read once before the legs ran, so a background
   * reconcile cannot make the payload contradict itself; absent when the
   * semantic module is off server-wide.
   */
  pinnedStatus: BackendStatus | undefined;
  /** Normalized queries, in input order. */
  queries: string[];
  /** Whether the caller passed an array — `query_stats` is array-query-only. */
  isMulti: boolean;
  /**
   * The active profile's fallback-retry threshold, named in the fallback note. Absent when
   * the profile has no fallback; the retry then never fires.
   */
  fallbackThreshold?: number;
  /** The vault's name, for the stderr warning only. */
  vault: string;
}

/** Every observability field of one vault's `search_notes` payload. */
export interface Observability {
  truncated: boolean;
  semantic_status: SemanticStatusField;
  query_stats?: Record<string, QueryStatsEntry>;
  /** For stderr when the semantic leg failed and degraded; never on the payload. */
  warning?: string;
}

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
    'The semantic leg did not run — semantic search is turned off (for this vault, or server-wide), so these matches are lexical-only.',
  unavailable:
    'The semantic leg did not run — this vault has no usable semantic index, so these matches are lexical-only.',
};

// An absent backend means the semantic module is globally off for this
// server (`--no-semantic`), which is the same `disabled` state a vault's own
// `"semantic": false` reports — the response is lexical-only for the same
// reason, and a caller needs no second vocabulary for it.
function toStatusField(status: BackendStatus | undefined): SemanticStatusField {
  const state = status?.state ?? 'disabled';
  return {
    state,
    ...(status?.state === 'indexing'
      ? { indexed: status.indexed ?? 0, total: status.total ?? 0 }
      : {}),
    ...(state === 'ready' ? {} : { note: DEGRADED_NOTES[state] }),
  };
}

// A corpus that stopped serving between the status read and the leg says what
// it is now (`indexing` after a daemon respawn, say); any other failure is the
// vault's semantic index being unusable for this call.
function semanticStatus(
  semantic: SemanticLegOutcome,
  pinned: BackendStatus | undefined,
): SemanticStatusField {
  if (semantic.status !== 'failed') return toStatusField(pinned);
  if (semantic.error instanceof CorpusNotReadyError) return toStatusField(semantic.error.status);
  return toStatusField({ state: 'unavailable' });
}

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
  fallbackThreshold: number | undefined;
}): string | undefined {
  const { semantic, lexical, tokenCounts, fallback, fallbackThreshold } = args;
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
  if (fallback && fallbackThreshold !== undefined) {
    return `Semantic hits came from the ${fallbackThreshold} fallback retry, so they are weaker than a normal result.`;
  }
  return undefined;
}

function queryStatsEntry(
  query: string,
  { semantic, lexical }: Omit<LegOutcomes, 'truncated'>,
  fallbackThreshold: number | undefined,
): QueryStatsEntry {
  const ran = semantic.status === 'ran' ? semantic : undefined;
  const tokenCounts = lexical.status === 'ran' ? lexical.perQueryTokenCounts[query] : undefined;
  const semanticCount = ran !== undefined ? (ran.perQueryHits[query] ?? 0) : null;
  const lexicalCount = lexical.status === 'ran' ? (lexical.perQueryCounts[query] ?? 0) : 0;
  const fallback = ran?.perQueryFallback[query] === true;
  // A zero where neither leg ran says the filter matched no notes, not that the
  // variant is dead — diagnosing it as dead would send the caller to rewrite a
  // query that was never tried.
  const note =
    ran !== undefined || lexical.status === 'ran'
      ? queryStatsNote({
          semantic: semanticCount,
          lexical: lexicalCount,
          tokenCounts,
          fallback,
          fallbackThreshold,
        })
      : undefined;
  return {
    semantic: semanticCount,
    lexical: lexicalCount,
    ...(tokenCounts !== undefined ? { lexical_tokens: tokenCounts } : {}),
    ...(fallback ? { semantic_fallback: true as const } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * Every observability field of one vault's `search_notes` payload, from what
 * the retrieval pipeline reports about each leg and the status pinned before
 * the legs ran. Pure: a scenario is a set of records, not a code path.
 */
export function deriveObservability(
  outcomes: LegOutcomes,
  context: ObservabilityContext,
): Observability {
  const { semantic, lexical } = outcomes;
  const query_stats = context.isMulti
    ? Object.fromEntries(
        context.queries.map((q) => [q, queryStatsEntry(q, outcomes, context.fallbackThreshold)]),
      )
    : undefined;
  const legTruncated =
    (semantic.status === 'ran' && semantic.truncated) ||
    (lexical.status === 'ran' && lexical.truncated);
  // Key order is the payload's: `truncated`, `semantic_status`, `query_stats`.
  return {
    truncated: outcomes.truncated || legTruncated,
    semantic_status: semanticStatus(semantic, context.pinnedStatus),
    ...(query_stats !== undefined ? { query_stats } : {}),
    ...(semantic.status === 'failed'
      ? {
          warning: `neuro-vault semantic: search_notes fell back to its lexical leg for vault "${context.vault}": ${String(semantic.error)}`,
        }
      : {}),
  };
}
