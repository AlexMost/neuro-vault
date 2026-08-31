import type { LexicalIndex, RankedNote } from '../../lib/obsidian/lexical/index.js';
import { EFFORT_PROFILES, LEXICAL_PER_NOTE_CAP } from './effort-profiles.js';
import { flattenExpansion, fuseRanks, type ExpansionCandidate } from './rank-fusion.js';
import { executeRetrieval } from './retrieval-policy.js';
import type {
  EmbeddingProvider,
  NoteResultNode,
  SearchEffort,
  SearchEngine,
  SmartSource,
} from './types.js';

/**
 * What `runRetrievalPipeline` needs to run a search: a snapshot of the
 * semantic corpus (absent when there is no backend), the lexical index,
 * backlink lookup, an existence filter for post-retrieval survivor checks,
 * and the embedding provider / search engine `executeRetrieval` drives.
 */
export interface RetrievalPipelineDeps {
  snapshot?: () => Promise<{ sources: Map<string, SmartSource> }>;
  lexical: Pick<LexicalIndex, 'search'>;
  getBacklinkCount: (path: string) => number;
  filterExisting: (paths: string[]) => Promise<Set<string>>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
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
  semantic?: NoteResultNode;
  lexical?: RankedNote;
  expansion?: ExpansionCandidate;
}

/** What happened to the semantic leg: never ran, ran and produced hits, or threw. */
export type SemanticLegOutcome =
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown }
  | {
      status: 'ran';
      perQueryHits: Record<string, number>;
      perQueryFallback: Record<string, boolean>;
    };

/** The fused candidate list plus enough per-leg provenance to build a caller-facing response. */
export interface RetrievalPipelineResult {
  candidates: PipelineCandidate[];
  truncated: boolean;
  semantic: SemanticLegOutcome;
  lexical: {
    perQueryCounts: Record<string, number>;
    perQueryTokenCounts: Record<string, Record<string, number>>;
    totalNotes: number;
  };
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

export async function runRetrievalPipeline(
  input: RetrievalPipelineInput,
  deps: RetrievalPipelineDeps,
): Promise<RetrievalPipelineResult> {
  const profile = EFFORT_PROFILES[input.effort];
  const cap = input.cap ?? profile.mergedCap;

  // The lexical leg always runs — it is what a semantic failure degrades to.
  const lexical = await deps.lexical.search({
    queries: input.queries,
    allowed: input.allowed,
    noteCap: profile.lexicalNoteCap,
    perNoteCap: LEXICAL_PER_NOTE_CAP,
    getBacklinkCount: deps.getBacklinkCount,
  });

  let semanticNodes: NoteResultNode[] = [];
  let semanticTruncated = false;
  let semantic: SemanticLegOutcome = { status: 'skipped' };
  if (input.semantic && deps.snapshot !== undefined) {
    try {
      const { sources } = await deps.snapshot();
      const effectiveSources =
        input.allowed !== undefined ? narrowSources(sources, input.allowed) : sources;
      const leg = await executeRetrieval({
        queries: input.queries,
        mode: input.effort,
        threshold: input.threshold,
        expansionFloor: input.expansionFloor,
        sources: effectiveSources,
        embeddingProvider: deps.embeddingProvider,
        searchEngine: deps.searchEngine,
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
      semanticTruncated = leg.truncated;
      semantic = {
        status: 'ran',
        perQueryHits: leg.per_query_hits,
        perQueryFallback: leg.per_query_fallback,
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
      ...(sem !== undefined ? { semantic: sem } : {}),
      ...(lex !== undefined ? { lexical: lex } : {}),
      ...(exp !== undefined ? { expansion: exp } : {}),
    };
  });

  return {
    candidates,
    truncated: fused.length > cap || lexical.truncated || semanticTruncated,
    semantic,
    lexical: {
      perQueryCounts: lexical.perQueryCounts,
      perQueryTokenCounts: lexical.perQueryTokenCounts,
      totalNotes: lexical.totalNotes,
    },
  };
}
