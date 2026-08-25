import { LexicalIndex } from '../src/lib/obsidian/lexical/index.js';
import type { SmartSource } from '../src/lib/obsidian/smart-connections-types.js';
import { FsVaultReader } from '../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../src/lib/obsidian/vault-scope-config.js';
import { WikilinkGraphIndex } from '../src/lib/obsidian/wikilink-graph.js';
import {
  EXPANSION_WEIGHT,
  flattenExpansion,
  fuseRanks,
} from '../src/modules/semantic/rank-fusion.js';
import { executeRetrieval } from '../src/modules/semantic/retrieval-policy.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../src/modules/semantic/search-engine.js';

export type PipelineId = 'semantic' | 'fused';
export type EmbedFn = (text: string) => Promise<number[]>;

export const EVAL_TOP_K = 10;

// Every knob in effect, echoed verbatim into the report's `config` (design
// D5/D7): a run with different knobs must be distinguishable. Semantic legs
// run at threshold 0 — production thresholds are model-scale-bound and eval
// counts positions only. Everything else mirrors production deep effort.
export const EVAL_CONFIG = {
  top_k: EVAL_TOP_K,
  semantic_threshold: 0,
  semantic_pool: 8,
  expansion_limit: 3,
  expansion_floor: 0.35,
  lexical_note_cap: 10,
  lexical_per_note_cap: 3,
  expansion_weight: EXPANSION_WEIGHT,
  k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
} as const;

export interface FusedContext {
  lexical: LexicalIndex;
  graph: WikilinkGraphIndex;
}

export async function createFusedContext(vaultRoot: string): Promise<FusedContext> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const graph = new WikilinkGraphIndex({ reader });
  await graph.ensureFresh();
  return { lexical: new LexicalIndex({ vaultRoot, reader }), graph };
}

async function rankSemantic(
  query: string,
  sources: Map<string, SmartSource>,
  embed: EmbedFn,
): Promise<string[]> {
  const queryVector = await embed(query);
  return findNeighbors({
    queryVector,
    sources: sources.values(),
    threshold: EVAL_CONFIG.semantic_threshold,
    limit: EVAL_TOP_K,
  }).map((r) => r.path);
}

async function rankFused(
  query: string,
  sources: Map<string, SmartSource>,
  embed: EmbedFn,
  context: FusedContext,
): Promise<string[]> {
  // The production legs, verbatim (design D5): executeRetrieval at deep
  // effort (pool 8, expansion on) with an explicit threshold 0, the lexical
  // index with the real wikilink graph for its backlink tie-break, then the
  // exact fusion `assembleUnified` performs — flattenExpansion + fuseRanks.
  const semantic = await executeRetrieval({
    queries: [query],
    mode: 'deep',
    threshold: EVAL_CONFIG.semantic_threshold,
    expansionFloor: EVAL_CONFIG.expansion_floor,
    sources,
    embeddingProvider: { initialize: () => Promise.resolve(), embed },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
  });
  const lexical = await context.lexical.search({
    queries: [query],
    noteCap: EVAL_CONFIG.lexical_note_cap,
    perNoteCap: EVAL_CONFIG.lexical_per_note_cap,
    getBacklinkCount: (p) => context.graph.getBacklinkCount(p),
  });
  const expansion = flattenExpansion(semantic.results);
  return fuseRanks({
    sources: {
      semantic: semantic.results.map((n) => n.path),
      lexical: lexical.notes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes: lexical.totalNotes,
  })
    .slice(0, EVAL_TOP_K)
    .map((c) => c.path);
}

export async function rankQuery(args: {
  pipeline: PipelineId;
  query: string;
  sources: Map<string, SmartSource>;
  embed: EmbedFn;
  fusedContext?: FusedContext;
}): Promise<string[]> {
  if (args.pipeline === 'semantic') {
    return rankSemantic(args.query, args.sources, args.embed);
  }
  if (!args.fusedContext) {
    throw new Error('fused pipeline requires a FusedContext');
  }
  return rankFused(args.query, args.sources, args.embed, args.fusedContext);
}
