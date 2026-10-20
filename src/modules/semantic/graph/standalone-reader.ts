import {
  createGraphReader,
  GraphReadError,
  type IGraphReader,
} from '../../../lib/obsidian/graph-reader.js';
import type { IVaultGraph } from '../../../lib/obsidian/wikilink-graph.js';

function failure(error: unknown): GraphReadError {
  if (error instanceof GraphReadError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GraphReadError(`graph read failed: ${message}`, { cause: error });
}

/**
 * The session's own graph reader, over a graph the session builds: what a
 * `--no-semantic` session reads, with no daemon to ask. Any failure of a read
 * — a build that threw — surfaces as a {@link GraphReadError}, the one error a
 * tool maps to a failed graph read, as the view's failures do.
 */
export function createStandaloneGraphReader(graph: IVaultGraph): IGraphReader {
  const reader = createGraphReader(() => graph);
  const mapped = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      throw failure(error);
    }
  };
  return {
    noteLinks: (notePath) => mapped(() => reader.noteLinks(notePath)),
    backlinkCounts: (paths) => mapped(() => reader.backlinkCounts(paths)),
    resolve: (targets) => mapped(() => reader.resolve(targets)),
  };
}
