import type { IVaultGraph, NoteLinks } from './wikilink-graph.js';

/**
 * A vault's wikilink graph as a session reads it: each read answers from a
 * build at most the graph's TTL old, so a caller never refreshes it itself.
 * Every read is batched — one call answers every path or target a tool needs —
 * because the graph usually lives in the vault entry, a call away.
 */
export interface IGraphReader {
  /** The note's incoming and outgoing links; none for a note the graph does not hold. */
  noteLinks(notePath: string): Promise<NoteLinks>;
  /** One count per path, in order; 0 for a note the graph does not hold. */
  backlinkCounts(paths: readonly string[]): Promise<number[]>;
  /**
   * One answer per target, in order: the vault path it resolves to, or `null`.
   * Each target is already normalized (`normalizeWikilinkTarget`).
   */
  resolve(targets: readonly string[]): Promise<(string | null)[]>;
}

/** A read of the graph failed: the one error a session-side view's caller sees. */
export class GraphReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GraphReadError';
  }
}

/**
 * The reader over an in-memory graph — the vault entry's, or a `--no-semantic`
 * session's own. Each call reads `current()` once and awaits its
 * `ensureFresh()`, so it answers every path or target from one build; a graph
 * swapped in meanwhile (a scope change) answers the next call. No error is
 * wrapped: the host decides what a failed build reads as.
 */
export function createGraphReader(current: () => IVaultGraph): IGraphReader {
  async function fresh(): Promise<IVaultGraph> {
    const graph = current();
    await graph.ensureFresh();
    return graph;
  }

  return {
    noteLinks: async (notePath) => (await fresh()).getNoteLinks(notePath),
    backlinkCounts: async (paths) => {
      const graph = await fresh();
      return paths.map((p) => graph.getBacklinkCount(p));
    },
    resolve: async (targets) => {
      const graph = await fresh();
      return targets.map((target) => graph.resolve(target));
    },
  };
}
