import type { ICorpusReader } from '../../lib/obsidian/corpus/corpus.js';
import type { ILexicalReader, RankedNote } from '../../lib/obsidian/lexical/index.js';
import { EFFORT_PROFILES, LEXICAL_PER_NOTE_CAP } from './effort-profiles.js';
import { flattenExpansion, fuseRanks, type ExpansionCandidate } from './rank-fusion.js';
import type { SimilarityDefaults } from '../../lib/model-profiles.js';
import { executeRetrieval } from './retrieval-policy.js';
import type { QueryEmbedder, NoteResultNode, SearchEffort } from './types.js';

/**
 * What `runRetrievalPipeline` needs to run a search: the semantic corpus
 * (absent when there is no backend), the lexical reader (which owns its own
 * backlink tie-break), an existence filter for post-retrieval survivor checks, and the embedding
 * provider `executeRetrieval` drives.
 */
export interface RetrievalPipelineDeps {
  corpus?: ICorpusReader;
  lexical: ILexicalReader;
  filterExisting: (paths: string[]) => Promise<Set<string>>;
  embeddingProvider: QueryEmbedder;
  /** The active model profile's default thresholds. */
  similarity: SimilarityDefaults;
}

/** One caller's retrieval request: queries, effort profile, and per-leg overrides. */
export interface RetrievalPipelineInput {
  queries: string[];
  effort: SearchEffort;
  semantic: boolean;
  threshold?: number;
  expansionFloor?: number;
  cap?: number;
  allowed?: Set<string>;
}

/** One fused candidate, tagged with whichever leg(s) produced it. */
export interface PipelineCandidate {
  path: string;
  /** The candidate's fused `fuseRanks` score; candidates arrive best first. */
  score: number;
  semantic?: NoteResultNode;
  lexical?: RankedNote;
  expansion?: ExpansionCandidate;
}

/**
 * What happened to the semantic leg: never ran, threw, or ran — with its pre-cap per-query
 * counts and whether its own pool cap dropped candidates (`truncated`).
 */
export type SemanticLegOutcome =
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown }
  | {
      status: 'ran';
      perQueryHits: Record<string, number>;
      perQueryFallback: Record<string, boolean>;
      truncated: boolean;
    };

/**
 * What happened to the lexical leg: never ran (a filter that matched no notes), or ran — with
 * its pre-cap per-query counts and whether its note cap dropped candidates (`truncated`). It
 * has no `failed` variant: the lexical leg is what a semantic failure degrades to, so its
 * failure fails the search, and `runRetrievalPipeline` throws `LexicalSearchError` instead.
 */
export type LexicalLegOutcome =
  | { status: 'skipped' }
  | {
      status: 'ran';
      perQueryCounts: Record<string, number>;
      perQueryTokenCounts: Record<string, Record<string, number>>;
      totalNotes: number;
      truncated: boolean;
    };

/**
 * The fused candidate list and one outcome record per leg — the single account of which legs
 * ran and what survived. `truncated` is the merged cap's cut only; each leg's pool cut lives
 * on its own record.
 */
export interface RetrievalPipelineResult {
  candidates: PipelineCandidate[];
  truncated: boolean;
  semantic: SemanticLegOutcome;
  lexical: LexicalLegOutcome;
}

export async function runRetrievalPipeline(
  input: RetrievalPipelineInput,
  deps: RetrievalPipelineDeps,
): Promise<RetrievalPipelineResult> {
  const profile = EFFORT_PROFILES[input.effort];
  const cap = input.cap ?? profile.mergedCap;

  // A filter that matched no notes leaves neither leg anything to read.
  if (input.allowed?.size === 0) {
    return {
      candidates: [],
      truncated: false,
      semantic: { status: 'skipped' },
      lexical: { status: 'skipped' },
    };
  }

  // The lexical leg always runs — it is what a semantic failure degrades to.
  const lexical = await deps.lexical.search({
    queries: input.queries,
    allowed: input.allowed,
    noteCap: profile.lexicalNoteCap,
    perNoteCap: LEXICAL_PER_NOTE_CAP,
  });

  let semanticNodes: NoteResultNode[] = [];
  let semantic: SemanticLegOutcome = { status: 'skipped' };
  if (input.semantic && deps.corpus !== undefined) {
    try {
      // `cap`/`input.cap` bounds ONLY the final fused list (the `.slice(0,
      // cap)` below) — it is deliberately NOT forwarded here, so it never
      // steers either leg's internal pool volume. A caller raising `limit`
      // recovers a merged-cap truncation but cannot recover a leg's own pool
      // truncation; only `effort` controls that.
      const leg = await executeRetrieval({
        queries: input.queries,
        mode: input.effort,
        threshold: input.threshold,
        expansionFloor: input.expansionFloor,
        corpus: deps.corpus,
        // The corpus applies the filter to every candidate it ranks.
        ...(input.allowed !== undefined ? { allowed: [...input.allowed] } : {}),
        embeddingProvider: deps.embeddingProvider,
        similarity: deps.similarity,
      });
      // Existence check covers seeds AND their flattened expansion targets;
      // expansion is recomputed below from the survivors so it reflects only
      // surviving seeds/paths. Lexical notes are existence-safe by
      // construction — they were read from disk this request.
      const rawExpansion = flattenExpansion(leg.results);
      const existing = await deps.filterExisting([
        ...leg.results.map((n) => n.path),
        ...rawExpansion.map((e) => e.path),
      ]);
      semanticNodes = leg.results
        .filter((n) => existing.has(n.path))
        .map((n) => ({ ...n, related: n.related.filter((rel) => existing.has(rel.path)) }));
      semantic = {
        status: 'ran',
        perQueryHits: leg.per_query_hits,
        perQueryFallback: leg.per_query_fallback,
        truncated: leg.truncated,
      };
    } catch (error) {
      semanticNodes = [];
      semantic = { status: 'failed', error };
    }
  }

  const expansion = flattenExpansion(semanticNodes);
  const semanticByPath = new Map(semanticNodes.map((n) => [n.path, n]));
  const lexicalByPath = new Map(lexical.notes.map((n) => [n.path, n]));
  const expansionByPath = new Map(expansion.map((e) => [e.path, e]));
  const fused = fuseRanks({
    sources: {
      semantic: semanticNodes.map((n) => n.path),
      lexical: lexical.notes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes: lexical.totalNotes,
  });
  const candidates: PipelineCandidate[] = fused.slice(0, cap).map((c) => {
    const sem = semanticByPath.get(c.path);
    const lex = lexicalByPath.get(c.path);
    const exp = expansionByPath.get(c.path);
    return {
      path: c.path,
      score: c.score,
      ...(sem !== undefined ? { semantic: sem } : {}),
      ...(lex !== undefined ? { lexical: lex } : {}),
      ...(exp !== undefined ? { expansion: exp } : {}),
    };
  });

  return {
    candidates,
    truncated: fused.length > cap,
    semantic,
    lexical: {
      status: 'ran',
      perQueryCounts: lexical.perQueryCounts,
      perQueryTokenCounts: lexical.perQueryTokenCounts,
      totalNotes: lexical.totalNotes,
      truncated: lexical.truncated,
    },
  };
}
