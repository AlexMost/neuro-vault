import { DaemonRpcError } from '../../../daemon/protocol.js';
import type {
  IConnectionContext,
  MethodHandler,
  ServiceHandlers,
} from '../../../daemon/protocol.js';

/**
 * How a session reaches a vault entry: one request on a connection. The daemon socket
 * connection and the in-process loopback both are one, so the attachment and the facades
 * above never ask which they hold.
 */
export interface IVaultLink {
  /**
   * Changes on every new connection; per-connection setup (`embed.initialize`,
   * `vault.attach`) is re-sent once per value.
   */
  readonly epoch: number;
  /** One request on the current connection; never connects. */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

/** The loopback: calls the daemon's own service handlers in this process. */
export interface IInProcessLink extends IVaultLink {
  /** Run each registered `onClose` callback, then refuse further requests. */
  close(): void;
}

/** Ids for links made without a fixed one; unique per process. */
let nextClientId = 1;

/** `<namespace>.<method>` → handler; own properties only, so `toString` etc. never resolve. */
function lookup(
  services: Record<string, ServiceHandlers>,
  method: string,
): MethodHandler | undefined {
  const dot = method.indexOf('.');
  if (dot <= 0 || dot === method.length - 1) return undefined;
  const namespace = method.slice(0, dot);
  const handlers = Object.hasOwn(services, namespace) ? services[namespace] : undefined;
  const name = method.slice(dot + 1);
  return handlers !== undefined && Object.hasOwn(handlers, name) ? handlers[name] : undefined;
}

/**
 * A link that answers from `services` in this process, as the daemon's registry would for a
 * connection of its own: errors come out as the wire's `DaemonRpcError` (`UNKNOWN_METHOD`
 * for a method that does not exist, `INTERNAL` for any throw that is not already one). The
 * `timeoutMs` is ignored — a call in this process has no wire to wait on — and the epoch
 * never changes.
 */
export function createInProcessLink(
  services: Record<string, ServiceHandlers>,
  opts: { clientId?: number } = {},
): IInProcessLink {
  const id = opts.clientId ?? nextClientId++;
  const closers: Array<() => void> = [];
  let closed = false;

  const ctx: IConnectionContext = {
    id,
    onClose(fn) {
      if (closed) fn();
      else closers.push(fn);
    },
  };

  return {
    epoch: 0,
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (closed) throw new Error(`in-process link closed: cannot call "${method}"`);
      const handler = lookup(services, method);
      if (handler === undefined) {
        throw new DaemonRpcError('UNKNOWN_METHOD', `unknown method "${method}"`);
      }
      try {
        return (await handler(params, ctx)) as T;
      } catch (error) {
        if (error instanceof DaemonRpcError) throw error;
        throw new DaemonRpcError(
          'INTERNAL',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fn of closers.splice(0)) fn();
    },
  };
}
