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
    const response = await registry.dispatch(req('echo.say', { a: 1 }, 7));
    expect(isJSONRPCResponse(response)).toBe(true);
    expect(response).toMatchObject({ id: 7, result: { got: { a: 1 } } });
  });

  it('answers UNKNOWN_METHOD for an unregistered namespace or method', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({}) });
    for (const method of ['lexical.search', 'echo.shout', 'nodot', 'embed.', '.query', '']) {
      const response = await registry.dispatch(req(method));
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
      const response = await registry.dispatch(req(method));
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
    const response = await registry.dispatch(req('embed.query'));
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
    const response = await registry.dispatch(req('x.y'));
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
    const response = await registry.dispatch(req('x.y'));
    expect(response).toMatchObject({
      error: { code: -32603, message: 'plain string failure', data: { code: 'INTERNAL' } },
    });
  });

  it('replaces the handlers when a namespace is registered twice', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({ v: 'first' }), only_first: async () => ({}) });
    registry.register('echo', { say: async () => ({ v: 'second' }) });
    const response = await registry.dispatch(req('echo.say'));
    expect(response).toMatchObject({ result: { v: 'second' } });
    const gone = await registry.dispatch(req('echo.only_first'));
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
