import { GraphReadError, type IGraphReader } from './obsidian/graph-reader.js';
import { ToolHandlerError } from './tool-response.js';
import type { IRegisteredVault } from './vault-registry.js';

/**
 * The vault's graph as a tool reads it: every read of `entry.graph`, with a failed one
 * (a {@link GraphReadError}) mapped the way `search_notes` maps a failed lexical leg — to
 * `DEPENDENCY_ERROR` with a generic message and `details: { vault, operation }`. The cause
 * (a timeout, a dropped connection, the daemon's reason) is only ever written to `warn`,
 * stderr by default. Any other error is a bug, not a dependency failure, and passes through.
 * `operation` is the tool's name, or the resource's URI.
 */
export function graphForTool(
  entry: Pick<IRegisteredVault, 'name' | 'graph'>,
  operation: string,
  warn: (message: string) => void = (message) => console.error(message),
): IGraphReader {
  const { name: vault, graph } = entry;

  async function mapped<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      if (!(cause instanceof GraphReadError)) throw cause;
      warn(`neuro-vault graph: ${operation} failed for vault "${vault}": ${cause.message}`);
      throw new ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', {
        details: { vault, operation },
        cause,
      });
    }
  }

  return {
    noteLinks: (notePath) => mapped(() => graph.noteLinks(notePath)),
    backlinkCounts: (paths) => mapped(() => graph.backlinkCounts(paths)),
    resolve: (targets) => mapped(() => graph.resolve(targets)),
  };
}
