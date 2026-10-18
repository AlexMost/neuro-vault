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
import { SharedServicesClosedError, type ISharedServices } from '../shared-services.js';
import type { IVaultAttachment } from './attachment.js';
import { CORPUS_TIMEOUTS, isStatus } from './corpus-wire.js';

export { CORPUS_TIMEOUTS } from './corpus-wire.js';

/** What a vault reads until its first attach answers (spec: sessions attach in the background). */
const ATTACHING: BackendStatus = { state: 'indexing', indexed: 0, total: 0 };

export interface IDaemonSemanticBackendOptions {
  /** The process's connection and one-way switch, shared with the embedding facade. */
  services: ISharedServices;
  /** The vault's one attachment on the connection, shared with every other facade of it. */
  attachment: IVaultAttachment;
  /** The model profile this session serves. */
  profile: string;
  /** The in-process backend, built once, on the first call after the switch went `local`. */
  local: () => ISemanticBackend;
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
 * with. While an attach is in flight the vault reads `indexing` 0/0, and so it
 * does while the switch is still undecided (`services.mode` is `pending`, the
 * daemon being located or started): such a status does not wait for the
 * connect, it starts the attach — or the in-process backend, if the switch
 * goes `local` — in the background. A later reconnect is waited for. A status
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
  const { services, attachment, profile } = opts;
  let localBackend: ISemanticBackend | undefined;
  /** The background connect-then-attach a status started while the switch was undecided. */
  let starting: Promise<void> | undefined;
  /** Set when a background connect met the closed services: the session is gone. */
  let closed: SharedServicesClosedError | undefined;

  function local(): ISemanticBackend {
    localBackend ??= opts.local();
    return localBackend;
  }

  /** The key of the vault attached on the current epoch, attaching first when it is not. */
  async function attachedKey(): Promise<string> {
    try {
      return await attachment.key();
    } catch (error) {
      // Refused with the status a caller would have read: the daemon cannot open the vault.
      if (error instanceof DaemonRpcError && error.code === 'VAULT_UNAVAILABLE') {
        throw new CorpusNotReadyError({ state: 'unavailable', reason: error.message });
      }
      throw error;
    }
  }

  /**
   * Connect, then attach (or attach the in-process backend), in the background.
   * Concurrent statuses share it, and it never rejects. A connect that cannot
   * be made flips the switch, and a failed attach leaves it decided: either
   * way the next status reads through the decided path. The one failure that
   * leaves the switch undecided is the services closing under the connect;
   * it is remembered, so a later status reads `unavailable` with its reason.
   */
  function startInBackground(): void {
    starting ??= (async () => {
      try {
        if ((await services.ensure()) === 'local') await local().status();
        else if (!attachment.attached) await attachment.key();
      } catch (error) {
        if (error instanceof SharedServicesClosedError) closed = error;
      } finally {
        starting = undefined;
      }
    })();
  }

  /** The daemon no longer knows the vault: the next call attaches again. */
  function forgetAttach(): void {
    attachment.forget();
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
      if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') forgetAttach();
      throw error;
    }
  }

  return {
    async status() {
      // The first connect may take the whole spawn-and-poll: read the vault as attaching.
      if (services.mode === 'pending') {
        if (closed) return unreadable(closed);
        startInBackground();
        return ATTACHING;
      }
      try {
        if ((await services.ensure()) === 'local') return await local().status();
        if (attachment.attaching) return ATTACHING;
        if (!attachment.attached) {
          // This call starts the attach or joins it: it reads the attach's own answer.
          await attachment.key();
          // Defensive: key() re-attaches on the current epoch, so this only guards a race in the
          // microtask gap.
          if (!attachment.attached) return ATTACHING;
          return (
            attachment.statusOf(profile) ?? {
              state: 'unavailable',
              reason: `daemon answered vault.attach without "${profile}"`,
            }
          );
        }
        const status = await services.connection.request<unknown>(
          'vault.status',
          { vault: await attachment.key(), profile },
          CORPUS_TIMEOUTS.status,
        );
        if (!isStatus(status)) throw new Error('daemon answered vault.status without a state');
        return status;
      } catch (error) {
        if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') forgetAttach();
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
