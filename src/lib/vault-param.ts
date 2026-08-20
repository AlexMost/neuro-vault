import { z } from 'zod';

import type { IVaultRegistry } from './vault-registry.js';

/**
 * Returns a partial zod-object shape that contributes the optional `vault`
 * parameter — but only when the registry holds more than one vault. In
 * single-vault mode the parameter is omitted entirely so the LLM doesn't see
 * a field it can't usefully fill.
 *
 * Spread it into the tool's input schema:
 *
 *   const inputSchema = z.object({
 *     ...vaultParamShape(registry),
 *     name: z.string().optional(),
 *   });
 */
export function vaultParamShape(
  registry: IVaultRegistry,
): { vault: z.ZodOptional<z.ZodString> } | Record<string, never> {
  return registry.isMulti() ? { vault: z.string().optional() } : {};
}

/**
 * Returns the multi-vault description suffix for a tool — or an empty string
 * in single-vault mode. Wraps the suffix with a leading space so callers can
 * always concatenate:
 *
 *   description: 'Base description.' + describeMultiVault(registry, 'Pass `vault:` to...'),
 *
 * Every suffix is prefixed with the registered vault names. `vaultParamShape`
 * contributes a bare optional string with no enum, so this is the only place a
 * model learns which names are valid — without it the names are discoverable
 * only reactively, by fanning out or by eating a `VAULT_REQUIRED` error.
 */
export function describeMultiVault(registry: IVaultRegistry, suffix: string): string {
  if (!registry.isMulti()) return '';
  const names = registry
    .names()
    .map((n) => `"${n}"`)
    .join(', ');
  return ` Registered vaults: ${names}. ${suffix}`;
}

/**
 * The shared suffix for tools that cannot fan out — reads of a specific path,
 * writes, single-vault diagnostics. Pass it to `describeMultiVault`. It names
 * the error code because this contract has no other delivery channel: the
 * server `instructions` string is truncated by the client and withheld from
 * sub-agents entirely, so the tool's own description is the only place a model
 * reliably reads it.
 */
export const EXPLICIT_VAULT_SUFFIX =
  'Pass `vault: "<name>"` to target a specific vault when multiple are registered — ' +
  'omitting it returns `VAULT_REQUIRED`.';

/**
 * The shared suffix for tools that CAN fan out — the mirror of
 * `EXPLICIT_VAULT_SUFFIX`. Pass it to `describeMultiVault`, which prefixes the
 * registered vault names.
 *
 * It deliberately says nothing about `skipped_vaults`. That field is always
 * `[]` — `runFanOut` hard-codes it and no helper populates it since
 * `runSemanticFanOut` was removed — so describing it would spend the
 * per-`tools/list` description budget on a promise no code path keeps. The
 * field stays in the response shape for contract stability; see
 * `docs/architecture/fan-out.md`.
 *
 * This constant exists so the contract has exactly one copy. Five tool
 * descriptions previously carried three drifted variants of it.
 */
export const FAN_OUT_SUFFIX =
  'Omit `vault:` to fan out across all registered vaults — the response shape switches to ' +
  '`results_by_vault: [...]` with `failed_vaults: [...]` (per-vault runtime errors); one ' +
  'failing vault never aborts the call. Pass `vault: "<name>"` to target a specific vault.';
