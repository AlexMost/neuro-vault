import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';
import type { VaultEntries } from '../../../lib/vault-entry/index.js';
import type { ISharedServices } from '../shared-services.js';
import { createAttachment } from '../vault-client/attachment.js';
import type { IVaultAttachment } from '../vault-client/attachment.js';

export type { IVaultAttachment } from '../vault-client/attachment.js';

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

/** The attachment over the shared daemon: `createAttachment` over the process's connection. */
export function createDaemonAttachment(opts: IDaemonAttachmentOptions): IVaultAttachment {
  return createAttachment({
    link: opts.services.connection,
    vaultRoot: opts.vaultRoot,
    profiles: opts.profiles,
  });
}

/**
 * The attachment over this process's own vault entries: the same single-flight
 * attach, with no connection to replace — a fixed connection id, no epochs.
 *
 * @deprecated PR 2 removes it: the in-process path attaches over `createInProcessLink` instead.
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
    get attached() {
      return key !== undefined;
    },
    statusOf: (profile) => statuses[profile],
  };
}
