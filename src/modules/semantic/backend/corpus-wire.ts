import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';

/** Whether a daemon answer is a status object. */
export function isStatus(value: unknown): value is BackendStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'string'
  );
}
