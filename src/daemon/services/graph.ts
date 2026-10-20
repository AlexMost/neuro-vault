import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  DaemonRpcError,
  defineMethod,
  graphBacklinkCountsParams,
  graphNoteLinksParams,
  graphResolveParams,
  type GraphBacklinkCountsResult,
  type GraphNoteLinksResult,
  type GraphResolveResult,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

/** The slice of the registry the service uses. */
export type GraphEntriesPort = Pick<VaultEntries, 'graph'>;

/** A read that throws inside the graph — a failed scan or build — is `GRAPH_FAILED`. */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DaemonRpcError(
      'GRAPH_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `graph.noteLinks`, `graph.backlinkCounts` and `graph.resolve` over the vault entry's one
 * wikilink graph. The calls carry no profile: the graph belongs to the entry, so any connection
 * attached to the vault may read it. Each read answers from a build at most the graph's TTL old;
 * composing the answers — top by backlinks, filters, forward links — stays in the session.
 */
export function createGraphService(entries: GraphEntriesPort): ServiceHandlers {
  return {
    noteLinks: defineMethod({
      params: graphNoteLinksParams,
      handler: async (call, ctx): Promise<GraphNoteLinksResult> => {
        const graph = await wired(() => entries.graph(ctx.id, call.vault));
        return reading(() => graph.noteLinks(call.path));
      },
    }),
    backlinkCounts: defineMethod({
      params: graphBacklinkCountsParams,
      handler: async (call, ctx): Promise<GraphBacklinkCountsResult> => {
        const graph = await wired(() => entries.graph(ctx.id, call.vault));
        return { counts: await reading(() => graph.backlinkCounts(call.paths)) };
      },
    }),
    resolve: defineMethod({
      params: graphResolveParams,
      handler: async (call, ctx): Promise<GraphResolveResult> => {
        const graph = await wired(() => entries.graph(ctx.id, call.vault));
        return { paths: await reading(() => graph.resolve(call.targets)) };
      },
    }),
  };
}
