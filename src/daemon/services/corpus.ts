import { isProfileKey } from '../../lib/model-profiles.js';
import type { CorpusAnchor, ICorpusReader } from '../../lib/obsidian/corpus/corpus.js';
import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  corpusNearestBlocksParams,
  corpusNearestParams,
  DaemonRpcError,
  defineMethod,
  type CorpusNearestBlocksResult,
  type CorpusNearestParams,
  type CorpusNearestResult,
  type IConnectionContext,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

/** The slice of the registry the service uses. */
export type CorpusEntriesPort = Pick<VaultEntries, 'reader'>;

/** What every `corpus.*` call carries. */
type ICall = Pick<CorpusNearestParams, 'vault' | 'profile' | 'anchors' | 'threshold' | 'limit'>;

/**
 * The reader of a call, once the corpus can serve it. The checks run in the order the answers
 * are documented: the profile is one the daemon knows (`UNKNOWN_PROFILE`), the connection
 * attached the pair (`NOT_ATTACHED`), the profile is `ready` (`CORPUS_NOT_READY`, with the
 * status), and each vector anchor is as wide as the corpus (`INVALID_PARAMS`).
 */
function readerFor(
  entries: CorpusEntriesPort,
  ctx: IConnectionContext,
  call: ICall,
): Promise<ICorpusReader> {
  return wired(() => {
    if (!isProfileKey(call.profile)) {
      throw new DaemonRpcError('UNKNOWN_PROFILE', `unknown profile "${call.profile}"`);
    }
    const { reader, status, dims } = entries.reader(ctx.id, call.vault, call.profile);
    if (status.state !== 'ready') {
      throw new DaemonRpcError(
        'CORPUS_NOT_READY',
        `the corpus of profile "${call.profile}" is ${status.state}`,
        { status },
      );
    }
    call.anchors.forEach((anchor, index) => {
      if ('vector' in anchor && anchor.vector.length !== dims) {
        throw new DaemonRpcError(
          'INVALID_PARAMS',
          `anchors[${index}].vector has ${anchor.vector.length} dimensions, the corpus has ${dims}`,
        );
      }
    });
    return reader;
  });
}

/** A read that throws inside the corpus is `CORPUS_FAILED` with the reason. */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DaemonRpcError(
      'CORPUS_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `corpus.nearest` and `corpus.nearestBlocks` over the daemon's vault entries (design D9, Q10).
 * Retrieval policy stays in the session: the daemon answers one similarity read per call and
 * never a vector. The corpus yields to the event loop between the anchors of one call.
 */
export function createCorpusService(entries: CorpusEntriesPort): ServiceHandlers {
  return {
    nearest: defineMethod({
      params: corpusNearestParams,
      handler: async (call, ctx): Promise<CorpusNearestResult> => {
        const reader = await readerFor(entries, ctx, call);
        const anchors: CorpusAnchor[] = call.anchors;
        const hits = await reading(() =>
          reader.nearest(anchors, {
            threshold: call.threshold,
            ...(call.limit === undefined ? {} : { limit: call.limit }),
            ...(call.allowed === undefined ? {} : { allowed: call.allowed }),
            ...(call.exclude === undefined ? {} : { exclude: call.exclude }),
          }),
        );
        return { hits };
      },
    }),
    nearestBlocks: defineMethod({
      params: corpusNearestBlocksParams,
      handler: async (call, ctx): Promise<CorpusNearestBlocksResult> => {
        const reader = await readerFor(entries, ctx, call);
        const anchors: CorpusAnchor[] = call.anchors;
        const hits = await reading(() =>
          reader.nearestBlocks(anchors, {
            paths: call.paths,
            threshold: call.threshold,
            ...(call.limit === undefined ? {} : { limit: call.limit }),
          }),
        );
        return { hits };
      },
    }),
  };
}
