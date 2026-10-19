import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import {
  createAttachment,
  type IVaultLink,
} from '../../../src/modules/semantic/vault-client/index.js';

const VAULT = '/vaults/notes';
const REAL = '/private/vaults/notes';
const PROFILE = 'granite-97m';

type Handler = (params: Record<string, unknown>) => unknown;

/** A link that answers `vault.attach` only; the test moves its epoch to model a reconnect. */
function fakeLink(attach?: Handler) {
  return {
    epoch: 1,
    request: vi.fn(async (method: string, params: Record<string, unknown>, _timeoutMs: number) => {
      if (method !== 'vault.attach') throw new Error(`unexpected ${method}`);
      return (attach ?? (() => ({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } })))(
        params,
      );
    }),
  };
}

/** The fake's `request` is not generic; the attachment only reads what it asked for. */
const attachmentOver = (link: ReturnType<typeof fakeLink>, profiles: string[] = [PROFILE]) =>
  createAttachment({ link: link as unknown as IVaultLink, vaultRoot: VAULT, profiles });

describe('createAttachment', () => {
  it('attaches once per epoch and shares concurrent callers', async () => {
    const link = fakeLink();
    const attachment = attachmentOver(link);

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
    const link = fakeLink(() => new Promise((resolve) => (answer = resolve)));
    const attachment = attachmentOver(link);
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
    const link = fakeLink();
    const attachment = attachmentOver(link);
    await attachment.key();

    link.epoch = 2;
    await attachment.key();

    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('forget makes the next key attach again', async () => {
    const link = fakeLink();
    const attachment = attachmentOver(link);
    await attachment.key();

    attachment.forget();
    await attachment.key();

    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('profiles [] is sent for an opted-out vault', async () => {
    const link = fakeLink(() => ({ vault: REAL, profiles: {} }));
    const attachment = attachmentOver(link, []);

    expect(await attachment.key()).toBe(REAL);

    expect(link.request.mock.calls[0]?.[1]).toEqual({ vault: VAULT, profiles: [] });
    expect(attachment.statusOf(PROFILE)).toBeUndefined();
  });

  it('an answer from a replaced epoch records nothing', async () => {
    let calls = 0;
    let answerStale: (value: unknown) => void = () => {};
    const link = fakeLink(() => {
      calls += 1;
      if (calls > 1) return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
      return new Promise((resolve) => (answerStale = resolve));
    });
    const attachment = attachmentOver(link);

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

  it('key() asked on a replaced epoch never resolves with the key it started with', async () => {
    let calls = 0;
    let answerStale: (value: unknown) => void = () => {};
    const link = fakeLink(() => {
      calls += 1;
      if (calls > 1) return { vault: REAL, profiles: {} };
      return new Promise((resolve) => (answerStale = resolve));
    });
    const attachment = attachmentOver(link, []);

    const stale = attachment.key();
    link.epoch = 2;
    answerStale({ vault: '/stale/key', profiles: {} });

    // The answer landed on a replaced epoch: key() attaches again on the current one.
    expect(await stale).toBe(REAL);
    expect(attachment.attached).toBe(true);
    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('key() rejects when every attach lands on a replaced epoch', async () => {
    const link = fakeLink(() => {
      link.epoch += 1;
      return { vault: '/stale/key', profiles: {} };
    });
    const attachment = attachmentOver(link, []);

    await expect(attachment.key()).rejects.toThrow(/connection changed/);
    expect(attachment.attached).toBe(false);
  });

  it('rejects an answer without a vault key and attaches again next time', async () => {
    let calls = 0;
    const link = fakeLink(() => {
      calls += 1;
      return calls === 1 ? { profiles: {} } : { vault: REAL, profiles: {} };
    });
    const attachment = attachmentOver(link, []);

    await expect(attachment.key()).rejects.toThrow('without a vault key');
    expect(await attachment.key()).toBe(REAL);
    expect(link.request).toHaveBeenCalledTimes(2);
  });

  it('rejects VAULT_UNAVAILABLE as the daemon error itself', async () => {
    const link = fakeLink(() => {
      throw new DaemonRpcError('VAULT_UNAVAILABLE', 'cannot resolve vault');
    });
    const attachment = attachmentOver(link);

    const error = await attachment.key().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as DaemonRpcError).code).toBe('VAULT_UNAVAILABLE');
  });
});
