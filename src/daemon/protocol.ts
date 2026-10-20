import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { z } from 'zod';

import type { IBlockHit, INoteHit } from '../lib/obsidian/corpus/corpus.js';
import type { LexicalMatch } from '../lib/obsidian/lexical/rank.js';
import type { BackendStatus } from '../lib/obsidian/semantic-backend.js';
import type { NoteLinks } from '../lib/obsidian/wikilink-graph.js';
import type { EmbeddingIdentity } from '../lib/obsidian/corpus/types.js';
import type { IVaultInfo } from '../lib/vault-entry/index.js';
import { formatZodError } from '../lib/zod-issues.js';

// ---- method shapes (the wire contract; see design D2) ----
// Each method's params are one closed zod object, the single owner of every constraint a schema
// can express (ADR-0015, one layer down); the wire param types are inferred from it. A check that
// needs runtime state (a known profile, a vector's width, the batch size) stays in the handler.

// Refinement messages leave out the field: the issue's path names it (`texts.1: must not be blank`).
const nonBlank = z.string().refine((text) => text.trim() !== '', 'must not be blank');
const strings = z.array(z.string());

export const embedInitializeParams = z.strictObject({ profile: z.string() });
export type EmbedInitializeParams = z.infer<typeof embedInitializeParams>;
export interface EmbedInitializeResult {
  identity: EmbeddingIdentity;
  max_batch_size: number;
}
export const embedQueryParams = z.strictObject({ profile: z.string(), text: nonBlank });
export type EmbedQueryParams = z.infer<typeof embedQueryParams>;
export interface EmbedQueryResult {
  vector: number[];
}
export const embedDocumentsParams = z.strictObject({
  profile: z.string(),
  texts: z.array(nonBlank).min(1, 'must not be empty'),
});
export type EmbedDocumentsParams = z.infer<typeof embedDocumentsParams>;
export interface EmbedDocumentsResult {
  vectors: number[][];
}
/**
 * What a `corpus.*` read is anchored on: a query vector, or a note already in the corpus.
 * zod 4's `z.number()` refuses `NaN` and ±Infinity, so a vector is finite numbers.
 */
const corpusAnchorParam = z.union([
  z.strictObject({ vector: z.array(z.number()) }),
  z.strictObject({ path: z.string() }),
]);
export type CorpusAnchorParam = z.infer<typeof corpusAnchorParam>;
/** What every `corpus.*` call carries. */
const corpusCall = {
  vault: z.string(),
  profile: z.string(),
  anchors: z.array(corpusAnchorParam),
  threshold: z.number(),
  limit: z.number().int().nonnegative().optional(),
};
export const corpusNearestParams = z.strictObject({
  ...corpusCall,
  allowed: strings.optional(),
  exclude: strings.optional(),
});
export type CorpusNearestParams = z.infer<typeof corpusNearestParams>;
/** One list per anchor, in order; `null` for a path anchor whose note has no vector. */
export interface CorpusNearestResult {
  hits: (INoteHit[] | null)[];
}
export const corpusNearestBlocksParams = z.strictObject({ ...corpusCall, paths: strings });
export type CorpusNearestBlocksParams = z.infer<typeof corpusNearestBlocksParams>;
export interface CorpusNearestBlocksResult {
  hits: (IBlockHit[] | null)[];
}
/** Blank queries pass: the session already normalised them (it never sends fewer than one). */
export const lexicalSearchParams = z.strictObject({
  vault: z.string(),
  queries: strings.min(1, 'must not be empty'),
  /** Absent: no filter. An empty list is a filter that matches nothing. */
  allowed: strings.optional(),
  note_cap: z.number().int().positive(),
  per_note_cap: z.number().int().positive(),
});
export type LexicalSearchParams = z.infer<typeof lexicalSearchParams>;
export interface LexicalSearchResult {
  notes: Array<{ path: string; matches: LexicalMatch[]; matched_queries: string[] }>;
  truncated: boolean;
  per_query_counts: Record<string, number>;
  per_query_token_counts: Record<string, Record<string, number>>;
  total_notes: number;
}
export const graphNoteLinksParams = z.strictObject({ vault: z.string(), path: z.string() });
export type GraphNoteLinksParams = z.infer<typeof graphNoteLinksParams>;
/** Empty `incoming` and `outgoing` for a note the graph does not hold. */
export type GraphNoteLinksResult = NoteLinks;
/** An empty list passes: it answers an empty list. */
export const graphBacklinkCountsParams = z.strictObject({ vault: z.string(), paths: strings });
export type GraphBacklinkCountsParams = z.infer<typeof graphBacklinkCountsParams>;
/** One count per path, in order; 0 for a note the graph does not hold. */
export interface GraphBacklinkCountsResult {
  counts: number[];
}
/** Each target already normalized; an empty list passes and answers an empty list. */
export const graphResolveParams = z.strictObject({ vault: z.string(), targets: strings });
export type GraphResolveParams = z.infer<typeof graphResolveParams>;
/** One vault path or `null` per target, in order. */
export interface GraphResolveResult {
  paths: (string | null)[];
}
/**
 * No scope, no exclusions, no corpus identity: the daemon reads those from the vault (spec). A
 * relative `vault` is a malformed param, not an unavailable vault: the daemon has no cwd to
 * resolve it against.
 */
export const vaultAttachParams = z.strictObject({
  vault: z.string().refine((vault) => path.isAbsolute(vault), 'must be an absolute path'),
  profiles: strings,
});
export type VaultAttachParams = z.infer<typeof vaultAttachParams>;
export interface VaultAttachResult {
  vault: string;
  profiles: Record<string, BackendStatus>;
}
export const vaultStatusParams = z.strictObject({ vault: z.string(), profile: z.string() });
export type VaultStatusParams = z.infer<typeof vaultStatusParams>;

/**
 * The per-vault read methods a session calls on the daemon: one row per wire method,
 * its params and result. `vault.attach` / `vault.status` are the lifecycle, not rows.
 */
export interface VaultMethods {
  'corpus.nearest': { params: CorpusNearestParams; result: CorpusNearestResult };
  'corpus.nearestBlocks': { params: CorpusNearestBlocksParams; result: CorpusNearestBlocksResult };
  'lexical.search': { params: LexicalSearchParams; result: LexicalSearchResult };
  'graph.noteLinks': { params: GraphNoteLinksParams; result: GraphNoteLinksResult };
  'graph.backlinkCounts': { params: GraphBacklinkCountsParams; result: GraphBacklinkCountsResult };
  'graph.resolve': { params: GraphResolveParams; result: GraphResolveResult };
}
export type VaultMethod = keyof VaultMethods;
/** What a caller passes: the wire params without `vault`, which the client fills in. */
export type VaultCallParams<M extends VaultMethod> = Omit<VaultMethods[M]['params'], 'vault'>;
export type VaultCallResult<M extends VaultMethod> = VaultMethods[M]['result'];
export interface DaemonInfoResult {
  name: string;
  version: string;
  pid: number;
  started_at: string;
  idle_timeout_min: number;
  clients: number;
  services: { embed: { loaded: string[] }; vault: IVaultInfo[] };
}

export type DaemonErrorCode =
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'UNKNOWN_PROFILE'
  | 'EMBED_FAILED'
  | 'SHUTTING_DOWN'
  | 'NOT_ATTACHED'
  | 'VAULT_UNAVAILABLE'
  | 'CORPUS_NOT_READY'
  | 'CORPUS_FAILED'
  | 'LEXICAL_FAILED'
  | 'GRAPH_FAILED'
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
  CORPUS_NOT_READY: ErrorCode.InternalError,
  CORPUS_FAILED: ErrorCode.InternalError,
  LEXICAL_FAILED: ErrorCode.InternalError,
  GRAPH_FAILED: ErrorCode.InternalError,
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
export interface IConnectionContext {
  /** Unique per connection for the life of the server. */
  readonly id: number;
  /**
   * Runs `fn` once when this connection closes, however it closes. A callback
   * registered after the connection already closed runs at once.
   */
  onClose(fn: () => void): void;
}

export type MethodHandler = (params: unknown, ctx: IConnectionContext) => Promise<unknown>;
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

/** One method of a service: its closed params schema, and the handler of the parsed params. */
export interface IMethodDefinition<S extends z.ZodObject<z.ZodRawShape, z.core.$strict>, R> {
  params: S;
  handler: (params: z.infer<S>, ctx: IConnectionContext) => Promise<R>;
}

/**
 * A handler that parses its params against `params` before `handler` sees them. A mismatch is
 * `INVALID_PARAMS`: the message names each issue (`<path>: <message>; …`) and `data.issues`
 * lists them. The check lives in the handler, not in `ServiceRegistry.dispatch`, so the socket
 * and the in-process loopback, which call the same handlers, validate alike.
 */
export function defineMethod<S extends z.ZodObject<z.ZodRawShape, z.core.$strict>, R>(
  method: IMethodDefinition<S, R>,
): MethodHandler {
  return async (params, ctx) => {
    const parsed = method.params.safeParse(params);
    if (!parsed.success) {
      const { message, issues } = formatZodError(parsed.error);
      throw new DaemonRpcError('INVALID_PARAMS', message, { issues });
    }
    return method.handler(parsed.data, ctx);
  };
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

  async dispatch(request: JSONRPCRequest, ctx: IConnectionContext): Promise<JSONRPCMessage> {
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
