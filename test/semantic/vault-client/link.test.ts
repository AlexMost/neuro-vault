import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import type { IConnectionContext, ServiceHandlers } from '../../../src/daemon/protocol.js';
import { createInProcessLink } from '../../../src/modules/semantic/vault-client/link.js';
import {
  timeoutOf,
  VAULT_CALL_TIMEOUTS,
} from '../../../src/modules/semantic/vault-client/timeouts.js';

describe('createInProcessLink', () => {
  it('calls the handler with a context carrying the link id, distinct per link', async () => {
    const seen: number[] = [];
    const services: Record<string, ServiceHandlers> = {
      vault: {
        probe: async (_params, ctx) => {
          seen.push(ctx.id);
          return {};
        },
      },
    };
    const a = createInProcessLink(services);
    const b = createInProcessLink(services);
    await a.request('vault.probe', {}, 1);
    await a.request('vault.probe', {}, 1);
    await b.request('vault.probe', {}, 1);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it('passes the params through and resolves with the handler result', async () => {
    const link = createInProcessLink({ vault: { echo: async (params) => ({ got: params }) } });
    await expect(link.request('vault.echo', { a: 1 }, 1)).resolves.toEqual({ got: { a: 1 } });
  });

  it('unknown methods and prototype names answer UNKNOWN_METHOD', async () => {
    const link = createInProcessLink({ vault: { known: async () => ({}) } });
    for (const method of ['nope.x', 'vault.toString', 'vault']) {
      await expect(link.request(method, {}, 1)).rejects.toMatchObject({
        name: 'DaemonRpcError',
        code: 'UNKNOWN_METHOD',
      });
    }
  });

  it('a DaemonRpcError passes through; any other throw is INTERNAL with its message', async () => {
    const link = createInProcessLink({
      vault: {
        refused: async () => {
          throw new DaemonRpcError('NOT_ATTACHED', 'attach first', { vault: '/v' });
        },
        broken: async () => {
          throw new Error('boom');
        },
      },
    });
    const refused = await link.request('vault.refused', {}, 1).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DaemonRpcError);
    expect(refused).toMatchObject({ code: 'NOT_ATTACHED', message: 'attach first' });
    expect((refused as DaemonRpcError).data).toEqual({ vault: '/v' });
    const broken = await link.request('vault.broken', {}, 1).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(DaemonRpcError);
    expect(broken).toMatchObject({ code: 'INTERNAL', message: 'boom' });
  });

  it('close runs each onClose callback once, and later requests reject', async () => {
    const spy = vi.fn();
    const link = createInProcessLink({
      vault: { watch: async (_params, ctx) => (ctx.onClose(spy), {}) },
    });
    await link.request('vault.watch', {}, 1);
    await link.request('vault.watch', {}, 1);
    expect(spy).not.toHaveBeenCalled();
    link.close();
    expect(spy).toHaveBeenCalledTimes(2);
    link.close();
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(link.request('vault.watch', {}, 1)).rejects.toThrow(/closed/);
  });

  it('an onClose registered after close runs at once', async () => {
    let ctx: IConnectionContext | undefined;
    const link = createInProcessLink({
      vault: {
        grab: async (_params, c) => {
          ctx = c;
          return {};
        },
      },
    });
    await link.request('vault.grab', {}, 1);
    link.close();
    const late = vi.fn();
    ctx?.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('epoch is constant', async () => {
    const link = createInProcessLink({ vault: { x: async () => ({}) } });
    const first = link.epoch;
    await link.request('vault.x', {}, 1);
    link.close();
    expect(link.epoch).toBe(first);
    expect(first).toBe(0);
  });
});

describe('timeoutOf', () => {
  it('answers the method entry, or the default for any other method', () => {
    expect(timeoutOf('vault.attach')).toBe(10_000);
    expect(timeoutOf('vault.status')).toBe(10_000);
    expect(timeoutOf('corpus.nearest')).toBe(30_000);
    expect(timeoutOf('toString')).toBe(VAULT_CALL_TIMEOUTS.default);
  });
});
