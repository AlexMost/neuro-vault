import {
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import {
  asRecord,
  type DaemonErrorCode,
  DaemonRpcError,
  errorResponse,
  ServiceRegistry,
} from '../../src/daemon/protocol.js';
import { testCtx } from './_ctx.js';

function req(method: string, params?: unknown, id = 1): JSONRPCRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  };
}

describe('ServiceRegistry.dispatch', () => {
  it('routes <service>.<method> and wraps the result', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async (params) => ({ got: params }) });
    const response = await registry.dispatch(req('echo.say', { a: 1 }, 7), testCtx());
    expect(isJSONRPCResponse(response)).toBe(true);
    expect(response).toMatchObject({ id: 7, result: { got: { a: 1 } } });
  });

  it('answers UNKNOWN_METHOD for an unregistered namespace or method', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({}) });
    for (const method of ['graph.links', 'echo.shout', 'nodot', 'embed.', '.query', '']) {
      const response = await registry.dispatch(req(method), testCtx());
      expect(isJSONRPCErrorResponse(response)).toBe(true);
      expect(response).toMatchObject({ error: { code: -32601, data: { code: 'UNKNOWN_METHOD' } } });
    }
  });

  it('answers UNKNOWN_METHOD for Object.prototype names on a registered namespace', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({}) });
    for (const method of [
      'echo.toString',
      'echo.__proto__',
      'echo.constructor',
      'echo.hasOwnProperty',
    ]) {
      const response = await registry.dispatch(req(method), testCtx());
      expect(response).toMatchObject({ error: { code: -32601, data: { code: 'UNKNOWN_METHOD' } } });
    }
  });

  it('maps DaemonRpcError codes and keeps the message', async () => {
    const registry = new ServiceRegistry();
    registry.register('embed', {
      query: async () => {
        throw new DaemonRpcError('EMBED_FAILED', 'model exploded');
      },
    });
    const response = await registry.dispatch(req('embed.query'), testCtx());
    expect(response).toMatchObject({
      error: { code: -32603, message: 'model exploded', data: { code: 'EMBED_FAILED' } },
    });
  });

  it('turns any other throw into INTERNAL', async () => {
    const registry = new ServiceRegistry();
    registry.register('x', {
      y: async () => {
        throw new TypeError('boom');
      },
    });
    const response = await registry.dispatch(req('x.y'), testCtx());
    expect(response).toMatchObject({
      error: { code: -32603, message: 'boom', data: { code: 'INTERNAL' } },
    });
  });

  it('turns a handler that throws a non-Error value into INTERNAL with that string', async () => {
    const registry = new ServiceRegistry();
    registry.register('x', {
      y: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point is a non-Error throw
        throw 'plain string failure';
      },
    });
    const response = await registry.dispatch(req('x.y'), testCtx());
    expect(response).toMatchObject({
      error: { code: -32603, message: 'plain string failure', data: { code: 'INTERNAL' } },
    });
  });

  it('passes the connection context to the handler', async () => {
    const registry = new ServiceRegistry();
    const ctx = testCtx(7);
    const seen: unknown[] = [];
    registry.register('echo', {
      say: async (_params, c) => {
        seen.push(c);
        return {};
      },
    });
    await registry.dispatch(req('echo.say'), ctx);
    expect(seen).toEqual([ctx]);
    expect(seen[0]).toBe(ctx);
  });

  it("carries a DaemonRpcError's data into the response, beside code", async () => {
    const registry = new ServiceRegistry();
    registry.register('vault', {
      status: async () => {
        throw new DaemonRpcError('NOT_ATTACHED', 'attach first', { key: '/v' });
      },
    });
    const response = await registry.dispatch(req('vault.status'), testCtx());
    expect(response).toMatchObject({
      error: {
        code: -32602,
        message: 'attach first',
        data: { code: 'NOT_ATTACHED', key: '/v' },
      },
    });
  });

  it('replaces the handlers when a namespace is registered twice', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({ v: 'first' }), only_first: async () => ({}) });
    registry.register('echo', { say: async () => ({ v: 'second' }) });
    const response = await registry.dispatch(req('echo.say'), testCtx());
    expect(response).toMatchObject({ result: { v: 'second' } });
    const gone = await registry.dispatch(req('echo.only_first'), testCtx());
    expect(gone).toMatchObject({ error: { data: { code: 'UNKNOWN_METHOD' } } });
  });
});

describe('errorResponse', () => {
  const expected: Record<DaemonErrorCode, number> = {
    UNKNOWN_METHOD: -32601,
    INVALID_PARAMS: -32602,
    UNKNOWN_PROFILE: -32602,
    EMBED_FAILED: -32603,
    SHUTTING_DOWN: -32000,
    INTERNAL: -32603,
    NOT_ATTACHED: -32602,
    VAULT_UNAVAILABLE: -32602,
    CORPUS_NOT_READY: -32603,
    CORPUS_FAILED: -32603,
    LEXICAL_FAILED: -32603,
  };

  it.each(Object.entries(expected) as [DaemonErrorCode, number][])(
    'maps %s to JSON-RPC code %i',
    (code, numeric) => {
      expect(errorResponse(5, code, 'msg')).toEqual({
        jsonrpc: '2.0',
        id: 5,
        error: { code: numeric, message: 'msg', data: { code } },
      });
    },
  );
});

describe('errorResponse data', () => {
  it('merges data beside code', () => {
    const response = errorResponse(5, 'NOT_ATTACHED', 'msg', { extra: 1 });
    expect(response).toMatchObject({ error: { data: { code: 'NOT_ATTACHED', extra: 1 } } });
    expect((response as { error: { data: unknown } }).error.data).toEqual({
      code: 'NOT_ATTACHED',
      extra: 1,
    });
  });

  it('lets code win over a data.code key', () => {
    const response = errorResponse(5, 'INTERNAL', 'msg', { code: 'NOT_ATTACHED' });
    expect((response as { error: { data: unknown } }).error.data).toEqual({ code: 'INTERNAL' });
  });
});

describe('asRecord', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'x'],
  ])('throws INVALID_PARAMS for %s', (_label, value) => {
    let thrown: unknown;
    try {
      asRecord(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DaemonRpcError);
    expect((thrown as DaemonRpcError).code).toBe('INVALID_PARAMS');
  });

  it('returns the object unchanged', () => {
    const params = { profile: 'default', text: 'hi' };
    expect(asRecord(params)).toBe(params);
  });
});
