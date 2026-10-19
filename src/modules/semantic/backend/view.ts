import {
  DaemonRpcError,
  type CorpusAnchorParam,
  type VaultCallResult,
} from '../../../daemon/protocol.js';
import type {
  CorpusAnchor,
  IBlockHit,
  INearestBlocksOptions,
  INearestOptions,
  INoteHit,
} from '../../../lib/obsidian/corpus/corpus.js';
import {
  CorpusNotReadyError,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';
import type { IVaultClient } from '../vault-client/index.js';
import { isStatus } from './corpus-wire.js';

/** Plain JSON for the wire: a `Float32Array` would serialize as an object of indices. */
function anchorParam(anchor: CorpusAnchor): CorpusAnchorParam {
  return 'vector' in anchor ? { vector: Array.from(anchor.vector) } : { path: anchor.path };
}

/**
 * The session's semantic backend over the vault's client, whichever side serves the vault:
 * the status is the client's, the reads are `corpus.nearest` / `corpus.nearestBlocks` calls.
 *
 * The client does no domain mapping, so the readiness mapping lives here, the one
 * per-interface mapping: a read the corpus cannot serve yet (`CORPUS_NOT_READY`) or a vault
 * the entry cannot open (`VAULT_UNAVAILABLE`) rejects with {@link CorpusNotReadyError}, the
 * error the tools render as a status. Any other failure reaches the caller as itself.
 */
export function createSemanticBackendView(client: IVaultClient, profile: string): ISemanticBackend {
  /** The answer's lists, checked to hold one per anchor; readiness refusals mapped. */
  async function hitsOf<T extends 'corpus.nearest' | 'corpus.nearestBlocks'>(
    method: T,
    pending: Promise<VaultCallResult<T>>,
    count: number,
  ): Promise<VaultCallResult<T>['hits']> {
    try {
      const result = await pending;
      if (!Array.isArray(result?.hits) || result.hits.length !== count) {
        throw new Error(`daemon answered ${method} without one list per anchor`);
      }
      return result.hits;
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === 'CORPUS_NOT_READY') {
        const status = error.data?.status;
        throw new CorpusNotReadyError(
          isStatus(status) ? status : { state: 'unavailable', reason: error.message },
          error.message,
        );
      }
      if (error instanceof DaemonRpcError && error.code === 'VAULT_UNAVAILABLE') {
        throw new CorpusNotReadyError({ state: 'unavailable', reason: error.message });
      }
      throw error;
    }
  }

  return {
    status: () => client.status(profile),

    nearest(
      anchors: readonly CorpusAnchor[],
      opts: INearestOptions,
    ): Promise<(INoteHit[] | null)[]> {
      return hitsOf(
        'corpus.nearest',
        client.call('corpus.nearest', {
          profile,
          anchors: anchors.map(anchorParam),
          threshold: opts.threshold,
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts.allowed === undefined ? {} : { allowed: [...opts.allowed] }),
          ...(opts.exclude === undefined ? {} : { exclude: [...opts.exclude] }),
        }),
        anchors.length,
      );
    },

    nearestBlocks(
      anchors: readonly CorpusAnchor[],
      opts: INearestBlocksOptions,
    ): Promise<(IBlockHit[] | null)[]> {
      return hitsOf(
        'corpus.nearestBlocks',
        client.call('corpus.nearestBlocks', {
          profile,
          anchors: anchors.map(anchorParam),
          paths: [...opts.paths],
          threshold: opts.threshold,
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        }),
        anchors.length,
      );
    },

    dispose: () => client.dispose(),
  };
}
