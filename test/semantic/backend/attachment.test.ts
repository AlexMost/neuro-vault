import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import type { VaultEntries } from '../../../src/lib/vault-entry/index.js';
import {
  createDaemonAttachment,
  createLocalAttachment,
} from '../../../src/modules/semantic/backend/attachment.js';
import type { IDaemonLink } from '../../../src/modules/semantic/daemon-connection.js';
import type { ISharedServices } from '../../../src/modules/semantic/shared-services.js';

const VAULT = '/vaults/notes';
const REAL = '/private/vaults/notes';
const PROFILE = 'granite-97m';

type Handler = (params: Record<string, unknown>) => unknown;

function fakeServices(attach?: Handler) {
  const link = {
    epoch: 1,
    ensure: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>, _timeoutMs: number) => {
      if (method !== 'vault.attach') throw new Error(`unexpected ${method}`);
      return (attach ?? (() => ({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } })))(
        params,
      );
    }),
  };
  const services = {
    mode: 'daemon',
    connection: link as unknown as IDaemonLink,
    ensure: vi.fn(async () => 'daemon' as const),
    close: vi.fn(),
  } as ISharedServices;
  return { services, link };
}

describe('createDaemonAttachment', () => {
  it('attaches once per epoch and shares concurrent callers', async () => {
    const { services, link } = fakeServices();
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });

    const keys = await Promise.all([attachment.key(), attachment.key()]);
    expect(keys).toEqual([REAL, REAL]);
    expect(await attachment.key()).toBe(REAL);

    expect(link.request).toHaveBeenCalledTimes(1);
    expect(link.request).toHaveBeenCalledWith(
      'vault.attach',
      { vault: VAULT, profiles: [PROFILE] },
      10_000,
    );
    expect(attachment.statusOf(PROFILE)).toEqual({ state: 'ready' });
    expect(attachment.statusOf('other')).toBeUndefined();
  });

  it('reports attaching only while an attach is in flight on the current epoch', async () => {
    let answer: (value: unknown) => void = () => {};
    const { services, link } = fakeServices(() => new Promise((resolve) => (answer = resolve)));
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });
    expect(attachment.attaching).toBe(false);

    const key = attachment.key();
    expect(attachment.attaching).toBe(true);
    expect(attachment.attached).toBe(false);
    link.epoch = 2;
    expect(attachment.attaching).toBe(false);
    link.epoch = 1;

    answer({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } });
    await key;
    expect(attachment.attaching).toBe(false);
    expect(attachment.attached).toBe(true);
    link.epoch = 2;
    expect(attachment.attached).toBe(false);
    link.epoch = 1;
    attachment.forget();
    expect(attachment.attached).toBe(false);
  });

  it('re-attaches after a new epoch', async () => {
    const { services, link } = fakeServices();
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });
    await attachment.key();

    link.epoch = 2;
    await attachment.key();

    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('forget makes the next key attach again', async () => {
    const { services, link } = fakeServices();
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });
    await attachment.key();

    attachment.forget();
    await attachment.key();

    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('profiles [] is sent for an opted-out vault', async () => {
    const { services, link } = fakeServices(() => ({ vault: REAL, profiles: {} }));
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [] });

    expect(await attachment.key()).toBe(REAL);

    expect(link.request.mock.calls[0]?.[1]).toEqual({ vault: VAULT, profiles: [] });
    expect(attachment.statusOf(PROFILE)).toBeUndefined();
  });

  it('an answer from a replaced epoch records nothing', async () => {
    let calls = 0;
    let answerStale: (value: unknown) => void = () => {};
    const { services, link } = fakeServices(() => {
      calls += 1;
      if (calls > 1) return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
      return new Promise((resolve) => (answerStale = resolve));
    });
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });

    const stale = attachment.key();
    link.epoch = 2;
    expect(await attachment.key()).toBe(REAL);
    answerStale({
      vault: '/stale/key',
      profiles: { [PROFILE]: { state: 'indexing', indexed: 0, total: 1 } },
    });
    await stale;

    expect(await attachment.key()).toBe(REAL);
    expect(attachment.statusOf(PROFILE)).toEqual({ state: 'ready' });
    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('rejects an answer without a vault key and attaches again next time', async () => {
    let calls = 0;
    const { services, link } = fakeServices(() => {
      calls += 1;
      return calls === 1 ? { profiles: {} } : { vault: REAL, profiles: {} };
    });
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [] });

    await expect(attachment.key()).rejects.toThrow('without a vault key');
    expect(await attachment.key()).toBe(REAL);
    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('rejects VAULT_UNAVAILABLE as the daemon error itself', async () => {
    const { services } = fakeServices(() => {
      throw new DaemonRpcError('VAULT_UNAVAILABLE', 'cannot resolve vault');
    });
    const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });

    const error = await attachment.key().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as DaemonRpcError).code).toBe('VAULT_UNAVAILABLE');
  });
});

describe('createLocalAttachment', () => {
  it('attaches once under the fixed connection id', async () => {
    const attach = vi.fn(async () => ({
      vault: REAL,
      profiles: { [PROFILE]: { state: 'ready' as const } },
    }));
    const entries = { attach } as unknown as VaultEntries;
    const attachment = createLocalAttachment({
      entries,
      connectionId: 0,
      vaultRoot: VAULT,
      profiles: [PROFILE],
    });

    const keys = await Promise.all([attachment.key(), attachment.key()]);
    expect(keys).toEqual([REAL, REAL]);
    expect(await attachment.key()).toBe(REAL);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(0, VAULT, [PROFILE]);
    expect(attachment.statusOf(PROFILE)).toEqual({ state: 'ready' });

    attachment.forget();
    await attachment.key();
    expect(attach).toHaveBeenCalledTimes(2);
  });
});
