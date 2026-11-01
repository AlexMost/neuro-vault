/**
 * PROTOTYPE (spike for #132): which within-leg ordering `rankNotes` uses.
 *
 * - `tiers`      — the shipped order: `(tier, density, backlinks, path)`.
 * - `bm25f`      — a BM25F-style score at scan time: `(score, backlinks, path)` (Shape 2).
 * - `bm25-tiers` — the same score inside the tiers: `(tier, score, backlinks, path)` (Shape 1).
 *
 * Read from the environment so a baseline and a prototype run share one build
 * and one process. Throwaway: the switch goes when the decision is made.
 */
export type LexicalScorer = 'tiers' | 'bm25f' | 'bm25-tiers';

export interface Bm25fParams {
  k1: number;
  b: number;
  wTitle: number;
  wHeading: number;
  wBody: number;
  /** Multiplier `1 + p` when some unit holds the query as a phrase. */
  phraseBonus: number;
}

export interface ScorerConfig {
  scorer: LexicalScorer;
  bm25f: Bm25fParams;
}

export const DEFAULT_BM25F: Bm25fParams = {
  k1: 1.2,
  b: 0.75,
  wTitle: 4,
  wHeading: 2,
  wBody: 1,
  phraseBonus: 0.5,
};

const num = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export function resolveScorerConfig(env: NodeJS.ProcessEnv = process.env): ScorerConfig {
  const raw = env.NEURO_VAULT_LEXICAL_SCORER;
  const scorer: LexicalScorer = raw === 'bm25f' || raw === 'bm25-tiers' ? raw : 'tiers';
  return {
    scorer,
    bm25f: {
      k1: num(env.NEURO_VAULT_BM25_K1, DEFAULT_BM25F.k1),
      b: num(env.NEURO_VAULT_BM25_B, DEFAULT_BM25F.b),
      wTitle: num(env.NEURO_VAULT_BM25_W_TITLE, DEFAULT_BM25F.wTitle),
      wHeading: num(env.NEURO_VAULT_BM25_W_HEADING, DEFAULT_BM25F.wHeading),
      wBody: num(env.NEURO_VAULT_BM25_W_BODY, DEFAULT_BM25F.wBody),
      phraseBonus: num(env.NEURO_VAULT_BM25_PHRASE, DEFAULT_BM25F.phraseBonus),
    },
  };
}
