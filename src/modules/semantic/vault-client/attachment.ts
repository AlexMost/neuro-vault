import type { VaultAttachParams, VaultAttachResult } from '../../../daemon/protocol.js';
import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';
import { isStatus } from '../backend/corpus-wire.js';
import { createEpochGate } from './epoch-gate.js';
import type { IVaultLink } from './link.js';
import { timeoutOf } from './timeouts.js';

/**
 * One vault's attachment on one link (design D4): the vault's client asks for the key before
 * every call, and the first call on an epoch — whichever view made it — makes the one
 * `vault.attach`.
 */
export interface IVaultAttachment {
  /** The realpath key on the current epoch; attaches first when needed. Rejects as the attach does. */
  key(): Promise<string>;
  /** Forget the attach so the next key() attaches again (after NOT_ATTACHED). */
  forget(): void;
  /** `true` while an attach is in flight on the current epoch. */
  readonly attaching: boolean;
  /** `true` once attached on the current epoch (and not forgotten since). */
  readonly attached: boolean;
  /** The last answered attach's status for `profile`, or undefined. */
  statusOf(profile: string): BackendStatus | undefined;
}

export interface IAttachmentOptions {
  /** The connection to attach on: the daemon's socket, or the in-process loopback. */
  link: IVaultLink;
  vaultRoot: string;
  /** The profiles to attach; `[]` attaches the vault for its lexical leg only. */
  profiles: string[];
}

/** How often key() re-attaches when each answer lands on a connection already replaced. */
const MAX_ATTACH_ATTEMPTS = 3;

/**
 * The attachment over a link. Per connection epoch, `vault.attach` goes out before the first
 * key is handed out — concurrent callers share one attach, and a reconnect (a new epoch)
 * attaches again. An answer from a connection already replaced records nothing on the new one.
 * A refused attach rejects as the daemon's own error (`VAULT_UNAVAILABLE` included), and the
 * next call attaches again. key() never returns a key the current connection did not attach:
 * it asks again on the current epoch, and rejects once a few answers in a row land on a
 * replaced one.
 */
export function createAttachment(opts: IAttachmentOptions): IVaultAttachment {
  const { link, vaultRoot, profiles } = opts;
  let key = vaultRoot;
  let statuses: Record<string, unknown> = {};

  const gate = createEpochGate<VaultAttachResult>(
    link,
    async () => {
      const params: VaultAttachParams = { vault: vaultRoot, profiles };
      const result = await link.request<VaultAttachResult | undefined>(
        'vault.attach',
        { ...params },
        timeoutOf('vault.attach'),
      );
      if (typeof result?.vault !== 'string') {
        throw new Error('daemon answered vault.attach without a vault key');
      }
      return result;
    },
    (result) => {
      key = result.vault;
      statuses = result.profiles ?? {};
    },
  );

  return {
    async key() {
      // An answer that lands on a replaced epoch attached nothing here: ask again on the current
      // one rather than hand out a key this connection never attached.
      for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt++) {
        if (!gate.done) await gate.pass();
        if (gate.done) return key;
      }
      throw new Error(`vault "${vaultRoot}" could not attach: the daemon connection changed`);
    },
    forget() {
      gate.forget();
    },
    get attaching() {
      return gate.running;
    },
    get attached() {
      return gate.done;
    },
    statusOf(profile) {
      const status = statuses[profile];
      return isStatus(status) ? status : undefined;
    },
  };
}
