import {
  isControl,
  LANGS,
  QUERY_CLASSES,
  type GoldenEntry,
  type Lang,
  type QueryClass,
} from './golden.js';
import type { Leg, RankedPath } from './pipelines.js';

export const RECALL_K = 10;

export interface QueryScore {
  id: string;
  query: string | string[];
  class: QueryClass;
  lang: Lang;
  top: string[];
  /** The score each `top` path was ranked by: cosine for `semantic`, the fused RRF score otherwise. */
  top_scores: number[];
  /** The legs behind each `top` path, parallel to `top`; absent on `semantic`. */
  top_found_in?: Leg[][];
  /** How many notes the call returned — for a control entry, all of them are noise. */
  result_count: number;
  /** 1-based ranks of every relevant path inside `top`. */
  relevant_ranks: number[];
  /** Best cosine between the query and any relevant note, ranked or not; null when none has a note vector. */
  best_relevant_similarity: number | null;
  /** 1-based rank of the first relevant hit within the top list, or null. */
  first_relevant_rank: number | null;
  /** The answerable metrics; null on a control entry, which has nothing to find. */
  reciprocal_rank: number | null;
  hit_at_3: boolean | null;
  /** `|relevant ∩ top-10| / |relevant|`. */
  recall_at_10: number | null;
}

export function scoreQuery(
  entry: GoldenEntry,
  ranked: RankedPath[],
  bestRelevantSimilarity: number | null,
): QueryScore {
  const relevant = new Set(entry.relevant);
  const top = ranked.map((r) => r.path);
  const relevant_ranks = top.flatMap((p, i) => (relevant.has(p) ? [i + 1] : []));
  const first_relevant_rank = relevant_ranks[0] ?? null;
  const control = isControl(entry);
  const foundIn = ranked.map((r) => r.found_in);
  return {
    id: entry.id,
    query: entry.query,
    class: entry.class,
    lang: entry.lang,
    top,
    top_scores: ranked.map((r) => r.score),
    ...(foundIn.every((f): f is Leg[] => f !== undefined) && foundIn.length > 0
      ? { top_found_in: foundIn }
      : {}),
    result_count: top.length,
    relevant_ranks,
    best_relevant_similarity: bestRelevantSimilarity,
    first_relevant_rank,
    reciprocal_rank: control ? null : first_relevant_rank === null ? 0 : 1 / first_relevant_rank,
    hit_at_3: control ? null : relevant_ranks.some((r) => r <= 3),
    recall_at_10: control
      ? null
      : relevant_ranks.filter((r) => r <= RECALL_K).length / relevant.size,
  };
}

/**
 * One slice of the set. Answerable entries carry the ranking metrics; control entries
 * carry the noise metrics. A metric whose population is empty in the slice is null.
 */
export interface SliceMetrics {
  n: number;
  answerable: number;
  mrr: number | null;
  hit_at_3: number | null;
  recall_at_10: number | null;
  controls: number;
  /** Share of control entries that returned at least one note. */
  control_hit_rate: number | null;
  /** Mean number of notes a control entry returned. */
  control_mean_results: number | null;
}

export interface Metrics {
  overall: SliceMetrics;
  lang: Record<Lang, SliceMetrics>;
  class: Record<QueryClass, SliceMetrics>;
  /** Keyed `<class>/<lang>`; only the combinations the set holds. */
  class_lang: Record<string, SliceMetrics>;
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

function slice(scores: QueryScore[]): SliceMetrics {
  const answerable = scores.filter((s) => s.class !== 'control');
  const controls = scores.filter((s) => s.class === 'control');
  return {
    n: scores.length,
    answerable: answerable.length,
    mrr: mean(answerable.map((s) => s.reciprocal_rank ?? 0)),
    hit_at_3: mean(answerable.map((s) => (s.hit_at_3 ? 1 : 0))),
    recall_at_10: mean(answerable.map((s) => s.recall_at_10 ?? 0)),
    controls: controls.length,
    control_hit_rate: mean(controls.map((s) => (s.result_count > 0 ? 1 : 0))),
    control_mean_results: mean(controls.map((s) => s.result_count)),
  };
}

export function aggregate(scores: QueryScore[]): Metrics {
  const class_lang: Record<string, SliceMetrics> = {};
  for (const c of QUERY_CLASSES) {
    for (const l of LANGS) {
      const cell = scores.filter((s) => s.class === c && s.lang === l);
      if (cell.length > 0) class_lang[`${c}/${l}`] = slice(cell);
    }
  }
  return {
    overall: slice(scores),
    lang: Object.fromEntries(
      LANGS.map((l) => [l, slice(scores.filter((s) => s.lang === l))]),
    ) as Record<Lang, SliceMetrics>,
    class: Object.fromEntries(
      QUERY_CLASSES.map((c) => [c, slice(scores.filter((s) => s.class === c))]),
    ) as Record<QueryClass, SliceMetrics>,
    class_lang,
  };
}

/** Which legs the returned notes came from — what a production floor or cap acts on. */
export interface LegSummary {
  returned: number;
  /** Returned notes no leg but semantic surfaced: the ones a semantic floor alone decides. */
  semantic_only: number;
  semantic: number;
  lexical: number;
  expansion: number;
  /** Of the returned notes, the labelled-relevant ones, and those of them only semantic found. */
  relevant: number;
  relevant_semantic_only: number;
}

export interface LegDiagnostics {
  answerable: LegSummary;
  control: LegSummary;
}

function legSummary(scores: QueryScore[]): LegSummary {
  const summary: LegSummary = {
    returned: 0,
    semantic_only: 0,
    semantic: 0,
    lexical: 0,
    expansion: 0,
    relevant: 0,
    relevant_semantic_only: 0,
  };
  for (const s of scores) {
    const relevantRanks = new Set(s.relevant_ranks);
    (s.top_found_in ?? []).forEach((legs, i) => {
      const semanticOnly = legs.length === 1 && legs[0] === 'semantic';
      summary.returned += 1;
      if (semanticOnly) summary.semantic_only += 1;
      for (const leg of legs) summary[leg] += 1;
      if (relevantRanks.has(i + 1)) {
        summary.relevant += 1;
        if (semanticOnly) summary.relevant_semantic_only += 1;
      }
    });
  }
  return summary;
}

export function legDiagnostics(scores: QueryScore[]): LegDiagnostics {
  return {
    answerable: legSummary(scores.filter((s) => s.class !== 'control')),
    control: legSummary(scores.filter((s) => s.class === 'control')),
  };
}

/** Golden-set coverage against the loaded corpus (#104): which entries can be won at all. */
export interface Coverage {
  relevant_paths_total: number;
  /** Relevant paths the corpus holds a vector for. */
  relevant_paths_indexed: number;
  /** Answerable entries none of whose relevant notes has a vector — the semantic leg cannot win them. */
  entries_unwinnable: number;
  unwinnable_ids: string[];
  /** Corpus notes that are not in the vault's scoped listing (deleted, moved or out of scope). */
  corpus_stale_paths: number;
}

export function computeCoverage(args: {
  entries: GoldenEntry[];
  /** Notes the corpus holds a vector for. */
  indexed: ReadonlySet<string>;
  /** Every note the corpus holds, vector or not. */
  corpusPaths: readonly string[];
  /** The vault's scoped note listing. */
  vaultPaths: ReadonlySet<string>;
}): Coverage {
  const relevant = args.entries.flatMap((e) => e.relevant);
  const unwinnable = args.entries.filter(
    (e) => !isControl(e) && !e.relevant.some((p) => args.indexed.has(p)),
  );
  return {
    relevant_paths_total: relevant.length,
    relevant_paths_indexed: relevant.filter((p) => args.indexed.has(p)).length,
    entries_unwinnable: unwinnable.length,
    unwinnable_ids: unwinnable.map((e) => e.id),
    corpus_stale_paths: args.corpusPaths.filter((p) => !args.vaultPaths.has(p)).length,
  };
}
