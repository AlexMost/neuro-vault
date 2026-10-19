import {
  LexicalIndex,
  LexicalSearchError,
  type ILexicalReader,
  type ILexicalResult,
  type ILexicalSearchOptions,
} from '../../../lib/obsidian/lexical/index.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { IVaultGraph } from '../../../lib/obsidian/wikilink-graph.js';

/**
 * The session's own lexical leg: a {@link LexicalIndex} over the session's
 * reader, tie-broken by the session's wikilink graph. This is the behaviour
 * every vault had before the cache moved into the shared daemon, and what a
 * session falls back to when it has no daemon to ask.
 *
 * The graph is refreshed before every search because its backlink counts are
 * the ranking's tie-break. Any failure of the refresh or the search surfaces as
 * a {@link LexicalSearchError}, the one error the pipeline's caller maps to a
 * lexical failure.
 */
export function createStandaloneLexicalReader(opts: {
  vaultRoot: string;
  reader: VaultReader;
  graph: Pick<IVaultGraph, 'ensureFresh' | 'getBacklinkCount'>;
}): ILexicalReader {
  const { graph } = opts;
  const index = new LexicalIndex({ vaultRoot: opts.vaultRoot, reader: opts.reader });
  return {
    async search(search: ILexicalSearchOptions): Promise<ILexicalResult> {
      try {
        await graph.ensureFresh();
        return await index.search({
          ...search,
          getBacklinkCount: (path) => graph.getBacklinkCount(path),
        });
      } catch (cause) {
        throw new LexicalSearchError(
          `lexical search failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },
    // The index parses lazily on the first search; nothing to start early.
    warm: () => Promise.resolve(),
  };
}
