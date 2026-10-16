import type { ConnectionContext } from '../../src/daemon/protocol.js';

/** A connection context for calling a handler or `dispatch` outside a socket; `onClose` callbacks are kept, never run. */
export function testCtx(id = 1): ConnectionContext {
  return { id, onClose: () => undefined };
}
