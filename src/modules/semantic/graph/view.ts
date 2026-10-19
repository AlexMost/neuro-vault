import type { VaultMethod } from '../../../daemon/protocol.js';
import { GraphReadError, type IGraphReader } from '../../../lib/obsidian/graph-reader.js';
import type { NoteLinks } from '../../../lib/obsidian/wikilink-graph.js';
import { DaemonConnectionError, DaemonTimeoutError } from '../daemon-connection.js';
import type { IVaultClient } from '../vault-client/index.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a failed read of `method` reads as, for the caller that logs or reports it. */
function failure(method: VaultMethod, error: unknown): GraphReadError {
  if (error instanceof GraphReadError) return error;
  if (error instanceof DaemonTimeoutError) {
    return new GraphReadError(`daemon did not answer ${method} in time`, { cause: error });
  }
  if (error instanceof DaemonConnectionError) {
    return new GraphReadError(`daemon connection lost during ${method}: ${error.message}`, {
      cause: error,
    });
  }
  return new GraphReadError(`${method} failed: ${messageOf(error)}`, { cause: error });
}

/** One answer per item asked, or the read fails: a short list must never read as zeros. */
function listOf<T>(method: VaultMethod, list: unknown, length: number): T[] {
  if (!Array.isArray(list) || list.length !== length) {
    throw new GraphReadError(`daemon answered ${method} without one answer per item asked`);
  }
  return list as T[];
}

function linksOf(answer: NoteLinks | undefined): NoteLinks {
  if (!Array.isArray(answer?.incoming) || !Array.isArray(answer.outgoing)) {
    throw new GraphReadError('daemon answered graph.noteLinks without incoming and outgoing lists');
  }
  return answer;
}

/**
 * The session's read of a vault's wikilink graph over the vault's client, whichever side serves
 * the vault: each read is one `graph.*` call, and an empty list asked answers at once.
 *
 * The client does no domain mapping, so the view owns the one this interface needs: every
 * failure of a read — the entry's (`GRAPH_FAILED`), a vault that cannot be attached, a timeout,
 * a dropped connection, closed services, an answer of the wrong shape — is a
 * {@link GraphReadError} for that call only. None of them flips the switch, and a
 * `NOT_ATTACHED` has already made the client forget its attach, so the next read attaches again.
 */
export function createGraphReaderView(client: IVaultClient): IGraphReader {
  async function reading<T>(method: VaultMethod, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw failure(method, error);
    }
  }

  return {
    noteLinks: (notePath) =>
      reading('graph.noteLinks', async () =>
        linksOf(await client.call('graph.noteLinks', { path: notePath })),
      ),

    backlinkCounts: async (paths) => {
      if (paths.length === 0) return [];
      return reading('graph.backlinkCounts', async () => {
        const answer = await client.call('graph.backlinkCounts', { paths: [...paths] });
        return listOf<number>('graph.backlinkCounts', answer?.counts, paths.length);
      });
    },

    resolve: async (targets) => {
      if (targets.length === 0) return [];
      return reading('graph.resolve', async () => {
        const answer = await client.call('graph.resolve', { targets: [...targets] });
        return listOf<string | null>('graph.resolve', answer?.paths, targets.length);
      });
    },
  };
}
