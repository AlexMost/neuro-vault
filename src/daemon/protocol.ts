import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { EmbeddingIdentity } from '../lib/obsidian/corpus/types.js';
import type { VaultInfo } from '../lib/vault-entry/index.js';

// ---- method shapes (the wire contract; see design D2) ----
export interface EmbedInitializeParams {
  profile: string;
}
export interface EmbedInitializeResult {
  identity: EmbeddingIdentity;
  max_batch_size: number;
}
export interface EmbedQueryParams {
  profile: string;
  text: string;
}
export interface EmbedQueryResult {
  vector: number[];
}
export interface EmbedDocumentsParams {
  profile: string;
  texts: string[];
}
export interface EmbedDocumentsResult {
  vectors: number[][];
}
export interface DaemonInfoResult {
  name: string;
  version: string;
  pid: number;
  started_at: string;
  idle_timeout_min: number;
  clients: number;
  services: { embed: { loaded: string[] }; vault: VaultInfo[] };
}

export type DaemonErrorCode =
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'UNKNOWN_PROFILE'
  | 'EMBED_FAILED'
  | 'SHUTTING_DOWN'
  | 'NOT_ATTACHED'
  | 'VAULT_UNAVAILABLE'
  | 'INTERNAL';

// `ErrorCode.ConnectionClosed` (-32000) is the SDK's JSON-RPC server-error slot for a closed connection.
const JSON_RPC_CODE: Record<DaemonErrorCode, number> = {
  UNKNOWN_METHOD: ErrorCode.MethodNotFound,
  INVALID_PARAMS: ErrorCode.InvalidParams,
  UNKNOWN_PROFILE: ErrorCode.InvalidParams,
  EMBED_FAILED: ErrorCode.InternalError,
  SHUTTING_DOWN: ErrorCode.ConnectionClosed,
  NOT_ATTACHED: ErrorCode.InvalidParams,
  VAULT_UNAVAILABLE: ErrorCode.InvalidParams,
  INTERNAL: ErrorCode.InternalError,
};

export class DaemonRpcError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
    /** Extra fields for the response's `error.data`, beside `code`. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DaemonRpcError';
  }
}

/** What a handler knows of the connection its request arrived on. */
export interface ConnectionContext {
  /** Unique per connection for the life of the server. */
  readonly id: number;
  /**
   * Runs `fn` once when this connection closes, however it closes. A callback
   * registered after the connection already closed runs at once.
   */
  onClose(fn: () => void): void;
}

export type MethodHandler = (params: unknown, ctx: ConnectionContext) => Promise<unknown>;
export type ServiceHandlers = Record<string, MethodHandler>;

export function errorResponse(
  id: RequestId,
  code: DaemonErrorCode,
  message: string,
  data?: Record<string, unknown>,
): JSONRPCMessage {
  // `code` is spread last: the stable name is the contract, `data` only adds to it.
  return {
    jsonrpc: '2.0',
    id,
    error: { code: JSON_RPC_CODE[code], message, data: { ...data, code } },
  };
}

export function resultResponse(id: RequestId, result: unknown): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result: result as Record<string, unknown> };
}

/** Params as an object, or `INVALID_PARAMS`. */
export function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new DaemonRpcError('INVALID_PARAMS', 'params must be an object');
  }
  return params as Record<string, unknown>;
}

/**
 * `namespace → { method: handler }`. A later service (`lexical`, `watch`)
 * is one more `register` call; framing, discovery and lifecycle do not move.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, ServiceHandlers>();

  register(namespace: string, handlers: ServiceHandlers): void {
    this.services.set(namespace, handlers);
  }

  async dispatch(request: JSONRPCRequest, ctx: ConnectionContext): Promise<JSONRPCMessage> {
    const handler = this.lookup(request.method);
    if (handler === undefined) {
      return errorResponse(request.id, 'UNKNOWN_METHOD', `unknown method "${request.method}"`);
    }
    try {
      return resultResponse(request.id, await handler(request.params, ctx));
    } catch (error) {
      if (error instanceof DaemonRpcError)
        return errorResponse(request.id, error.code, error.message, error.data);
      return errorResponse(
        request.id,
        'INTERNAL',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** `<namespace>.<method>` → handler. Own properties only, so `toString` etc. never resolve. */
  private lookup(method: string): MethodHandler | undefined {
    const dot = method.indexOf('.');
    if (dot <= 0 || dot === method.length - 1) return undefined;
    const handlers = this.services.get(method.slice(0, dot));
    const name = method.slice(dot + 1);
    return handlers !== undefined && Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  }
}
