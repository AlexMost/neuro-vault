import type { DaemonCliOptions } from './types.js';

/** Injected I/O for the `daemon` command; filled in when the command is implemented. */
export type DaemonCommandDeps = Record<string, never>;

/** Placeholder entry point for `neuro-vault-mcp daemon [status|stop]`. */
export function runDaemonCommand(
  _options: DaemonCliOptions,
  _deps?: DaemonCommandDeps,
): Promise<number> {
  return Promise.resolve(0);
}
