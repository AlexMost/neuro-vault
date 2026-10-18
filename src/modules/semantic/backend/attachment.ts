import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';
import type { VaultEntries } from '../../../lib/vault-entry/index.js';
import type { ISharedServices } from '../shared-services.js';
import { CORPUS_TIMEOUTS, isStatus } from './daemon-backend.js';

/**
 * One vault's attachment on one connection (design D7): the facades that read
 * the vault — the semantic backend, and the lexical reader after it — each
 * ask for the key, and the first to ask makes the one `vault.attach`.
 */
export interface IVaultAttachment {
  /** The realpath key on the current epoch; attaches first when needed. Rejects as the attach does. */
  key(): Promise<string>;
  /** Forget the attach so the next key() attaches again (after NOT_ATTACHED). */
  forget(): void;
  /** `true` while an attach is in flight on the current epoch. */
  readonly attaching: boolean;
  /** The last answered attach's status for `profile`, or undefined. */
  statusOf(profile: string): BackendStatus | undefined;
}

export interface IDaemonAttachmentOptions {
  /** The process's connection and one-way switch. The caller has ensured it. */
  services: ISharedServices;
  vaultRoot: string;
  /** The profiles to attach; `[]` attaches the vault for its lexical leg only. */
  profiles: string[];
}

export interface ILocalAttachmentOptions {
  /** The process's in-process vault entries. */
  entries: VaultEntries;
  /** The fixed connection id this process attaches under. */
  connectionId: number;
  vaultRoot: string;
  profiles: string[];
}

interface IInFlight {
  epoch: number;
  answer: Promise<void>;
}

/**
 * The attachment over the shared daemon. Per connection epoch, `vault.attach`
 * goes out before the first key is handed out — concurrent callers share one
 * attach, and a reconnect (a new epoch) attaches again. An answer from a
 * connection already replaced records nothing on the new one. A refused
 * attach rejects as the daemon's own error (`VAULT_UNAVAILABLE` included),
 * and the next call attaches again.
 */
export function createDaemonAttachment(opts: IDaemonAttachmentOptions): IVaultAttachment {
  const { services, vaultRoot, profiles } = opts;
  /** The epoch the vault is attached on, and the key the daemon answered with. */
  let attachedEpoch = -1;
  let key = vaultRoot;
  let statuses: Record<string, unknown> = {};
  let inFlight: IInFlight | undefined;

  /** `vault.attach` on the current epoch; concurrent callers share it. */
  function attach(): Promise<void> {
    const epoch = services.connection.epoch;
    if (inFlight?.epoch === epoch) return inFlight.answer;
    const answer = services.connection
      .request<{ vault?: unknown; profiles?: Record<string, unknown> }>(
        'vault.attach',
        { vault: vaultRoot, profiles },
        CORPUS_TIMEOUTS.attach,
      )
      .then((result) => {
        if (typeof result?.vault !== 'string') {
          throw new Error('daemon answered vault.attach without a vault key');
        }
        // An answer from a connection already replaced attaches nothing on the new one.
        if (epoch === services.connection.epoch) {
          key = result.vault;
          statuses = result.profiles ?? {};
          attachedEpoch = epoch;
        }
      })
      .finally(() => {
        if (inFlight?.answer === answer) inFlight = undefined;
      });
    inFlight = { epoch, answer };
    return answer;
  }

  return {
    async key() {
      if (attachedEpoch !== services.connection.epoch) await attach();
      return key;
    },
    forget() {
      attachedEpoch = -1;
    },
    get attaching() {
      return inFlight?.epoch === services.connection.epoch;
    },
    statusOf(profile) {
      const status = statuses[profile];
      return isStatus(status) ? status : undefined;
    },
  };
}

/**
 * The attachment over this process's own vault entries: the same single-flight
 * attach, with no connection to replace — a fixed connection id, no epochs.
 */
export function createLocalAttachment(opts: ILocalAttachmentOptions): IVaultAttachment {
  const { entries, connectionId, vaultRoot, profiles } = opts;
  let key: string | undefined;
  let statuses: Record<string, BackendStatus> = {};
  let inFlight: Promise<void> | undefined;

  function attach(): Promise<void> {
    inFlight ??= entries
      .attach(connectionId, vaultRoot, profiles)
      .then((result) => {
        key = result.vault;
        statuses = result.profiles;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    async key() {
      if (key === undefined) await attach();
      if (key === undefined) throw new Error(`vault "${vaultRoot}" attached without a key`);
      return key;
    },
    forget() {
      key = undefined;
    },
    get attaching() {
      return inFlight !== undefined;
    },
    statusOf: (profile) => statuses[profile],
  };
}
