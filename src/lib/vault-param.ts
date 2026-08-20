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
 */
export function describeMultiVault(registry: IVaultRegistry, suffix: string): string {
  return registry.isMulti() ? ' ' + suffix : '';
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
