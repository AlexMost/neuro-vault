import {
  DaemonRpcError,
  type CorpusAnchorParam,
  type CorpusNearestBlocksParams,
  type CorpusNearestParams,
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
  type BackendStatus,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';
import { DaemonTimeoutError } from '../daemon-connection.js';
import type { ISharedServices } from '../shared-services.js';

export const CORPUS_TIMEOUTS = {
  attach: 10_000,
  status: 10_000,
  /** `corpus.nearest` and `corpus.nearestBlocks`. */
  read: 30_000,
} as const;

/** What a vault reads until its first attach answers (spec: sessions attach in the background). */
const ATTACHING: BackendStatus = { state: 'indexing', indexed: 0, total: 0 };

export interface IDaemonSemanticBackendOptions {
  /** The process's connection and one-way switch, shared with the embedding facade. */
  services: ISharedServices;
  vaultRoot: string;
  /** The model profile this session serves. */
  profile: string;
  /** The in-process backend, built once, on the first call after the switch went `local`. */
  local: () => ISemanticBackend;
}

interface IAttach {
  epoch: number;
  answer: Promise<BackendStatus>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a status could not be read: one call's answer, never a lasting state. */
function unreadable(error: unknown): BackendStatus {
  if (error instanceof DaemonTimeoutError) {
    return { state: 'unavailable', reason: 'daemon did not answer' };
  }
  return { state: 'unavailable', reason: messageOf(error) };
}

function isStatus(value: unknown): value is BackendStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'string'
  );
}

/** Plain JSON for the wire: a `Float32Array` would serialize as an object of indices. */
function anchorParam(anchor: CorpusAnchor): CorpusAnchorParam {
  return 'vector' in anchor ? { vector: Array.from(anchor.vector) } : { path: anchor.path };
}

/**
 * The session's semantic backend over the shared daemon (design D11, D12): the
 * vault's status is `vault.status`, its reads `corpus.nearest` and
 * `corpus.nearestBlocks`. No vector of the corpus ever reaches the session.
 *
 * Per connection epoch, `vault.attach` goes out before the first call on it —
 * concurrent callers share one attach, and a reconnect (a new epoch) attaches
 * again — and every later call carries the realpath key the daemon answered
 * with. While an attach is in flight the vault reads `indexing` 0/0. A status
 * the daemon does not give in time reads `unavailable` ("daemon did not
 * answer") for that call only, as does a dropped connection: the next call
 * reconnects through `services`. A vault the daemon cannot attach
 * (`VAULT_UNAVAILABLE`) reads `unavailable` with its reason and is attached
 * again on the next call.
 *
 * A read the corpus cannot serve yet (`CORPUS_NOT_READY`) rejects with
 * {@link CorpusNotReadyError} carrying the daemon's status; any other failure
 * (`CORPUS_FAILED`, `NOT_ATTACHED`, a timeout) rejects as itself, and a
 * `NOT_ATTACHED` also forgets the attach so the next call makes a new one.
 *
 * Once `services.ensure()` answers `local` — the daemon could not be located
 * or started — every call goes to the in-process backend instead.
 */
export function createDaemonSemanticBackend(opts: IDaemonSemanticBackendOptions): ISemanticBackend {
  const { services, vaultRoot, profile } = opts;
  let localBackend: ISemanticBackend | undefined;
  /** The epoch the vault is attached on, and the key the daemon answered with. */
  let attachedEpoch = -1;
  let key = vaultRoot;
  let attaching: IAttach | undefined;

  function local(): ISemanticBackend {
    localBackend ??= opts.local();
    return localBackend;
  }

  /** `vault.attach` on the current epoch; concurrent callers share it. */
  function attach(): Promise<BackendStatus> {
    const epoch = services.connection.epoch;
    if (attaching?.epoch === epoch) return attaching.answer;
    const answer = services.connection
      .request<{ vault?: unknown; profiles?: Record<string, unknown> }>(
        'vault.attach',
        { vault: vaultRoot, profiles: [profile] },
        CORPUS_TIMEOUTS.attach,
      )
      .then((result): BackendStatus => {
        if (typeof result?.vault !== 'string') {
          throw new Error('daemon answered vault.attach without a vault key');
        }
        key = result.vault;
        attachedEpoch = epoch;
        const status = result.profiles?.[profile];
        return isStatus(status)
          ? status
          : { state: 'unavailable', reason: `daemon answered vault.attach without "${profile}"` };
      })
      .finally(() => {
        if (attaching?.answer === answer) attaching = undefined;
      });
    attaching = { epoch, answer };
    return answer;
  }

  /** The key of a vault attached on the current epoch, attaching first when it is not. */
  async function attachedKey(): Promise<string> {
    if (attachedEpoch !== services.connection.epoch) {
      try {
        await attach();
      } catch (error) {
        // Refused with the status a caller would have read: the daemon cannot open the vault.
        if (error instanceof DaemonRpcError && error.code === 'VAULT_UNAVAILABLE') {
          throw new CorpusNotReadyError({ state: 'unavailable', reason: error.message });
        }
        throw error;
      }
    }
    return key;
  }

  /** A `corpus.*` call's own params; the vault key and profile are added here. */
  type ReadParams =
    | Omit<CorpusNearestParams, 'vault' | 'profile'>
    | Omit<CorpusNearestBlocksParams, 'vault' | 'profile'>;

  async function read<T>(method: string, params: ReadParams): Promise<T> {
    const vault = await attachedKey();
    try {
      const result = await services.connection.request<{ hits?: unknown }>(
        method,
        { vault, profile, ...params },
        CORPUS_TIMEOUTS.read,
      );
      if (!Array.isArray(result?.hits) || result.hits.length !== params.anchors.length) {
        throw new Error(`daemon answered ${method} without one list per anchor`);
      }
      return result.hits as T;
    } catch (error) {
      if (error instanceof DaemonRpcError && error.code === 'CORPUS_NOT_READY') {
        const status = error.data?.status;
        throw new CorpusNotReadyError(
          isStatus(status) ? status : { state: 'unavailable', reason: error.message },
          error.message,
        );
      }
      if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') attachedEpoch = -1;
      throw error;
    }
  }

  return {
    async status() {
      try {
        if ((await services.ensure()) === 'local') return await local().status();
        if (attaching?.epoch === services.connection.epoch) return ATTACHING;
        if (attachedEpoch !== services.connection.epoch) return await attach();
        const status = await services.connection.request<unknown>(
          'vault.status',
          { vault: key, profile },
          CORPUS_TIMEOUTS.status,
        );
        if (!isStatus(status)) throw new Error('daemon answered vault.status without a state');
        return status;
      } catch (error) {
        if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') attachedEpoch = -1;
        return unreadable(error);
      }
    },

    async nearest(anchors: readonly CorpusAnchor[], readOpts: INearestOptions) {
      if ((await services.ensure()) === 'local') return local().nearest(anchors, readOpts);
      return read<(INoteHit[] | null)[]>('corpus.nearest', {
        anchors: anchors.map(anchorParam),
        threshold: readOpts.threshold,
        ...(readOpts.limit === undefined ? {} : { limit: readOpts.limit }),
        ...(readOpts.allowed === undefined ? {} : { allowed: [...readOpts.allowed] }),
        ...(readOpts.exclude === undefined ? {} : { exclude: [...readOpts.exclude] }),
      });
    },

    async nearestBlocks(anchors: readonly CorpusAnchor[], readOpts: INearestBlocksOptions) {
      if ((await services.ensure()) === 'local') return local().nearestBlocks(anchors, readOpts);
      return read<(IBlockHit[] | null)[]>('corpus.nearestBlocks', {
        anchors: anchors.map(anchorParam),
        paths: [...readOpts.paths],
        threshold: readOpts.threshold,
        ...(readOpts.limit === undefined ? {} : { limit: readOpts.limit }),
      });
    },

    async dispose() {
      // The connection is the process's; closing it (which detaches every vault) is the server's.
      await localBackend?.dispose();
    },
  };
}
