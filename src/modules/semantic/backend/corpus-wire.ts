import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';

/** What the session waits for on each daemon call a vault's facades make. */
export const CORPUS_TIMEOUTS = {
  attach: 10_000,
  status: 10_000,
  /** `corpus.nearest` and `corpus.nearestBlocks`. */
  read: 30_000,
} as const;

/** Whether a daemon answer is a status object. */
export function isStatus(value: unknown): value is BackendStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'string'
  );
}
