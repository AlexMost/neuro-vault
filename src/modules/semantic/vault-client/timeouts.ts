/**
 * What a session waits for on each daemon call (ms): the lifecycle calls answer from memory,
 * so they get a short wait; every other method gets `default`. A new method row needs no entry.
 */
export const VAULT_CALL_TIMEOUTS = {
  default: 30_000,
  'vault.attach': 10_000,
  'vault.status': 10_000,
} as const;

const OVERRIDES: Readonly<Record<string, number>> = VAULT_CALL_TIMEOUTS;

/** The wait for `method`: its entry in {@link VAULT_CALL_TIMEOUTS}, else the default. */
export function timeoutOf(method: string): number {
  return method !== 'default' && Object.hasOwn(OVERRIDES, method)
    ? (OVERRIDES[method] ?? VAULT_CALL_TIMEOUTS.default)
    : VAULT_CALL_TIMEOUTS.default;
}
