import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

export interface ISkippedVault {
  vault: string;
  reason: string;
}

export interface IFanOutResult<T extends Record<string, unknown>> {
  results_by_vault: Array<{ vault: string } & T>;
  skipped_vaults: ISkippedVault[];
}

/**
 * Run `fn` once per registered vault and group results.
 *
 * Use when the operation does not depend on a semantic index (e.g. structural
 * queries that read the disk directly). No vault is skipped; `skipped_vaults`
 * is always an empty array.
 */
export async function runFanOut<T extends Record<string, unknown>>(
  registry: IVaultRegistry,
  fn: (entry: IVaultEntry) => Promise<T>,
): Promise<IFanOutResult<T>> {
  const entries = registry.list();
  const results = await Promise.all(
    entries.map(async (entry) => ({ vault: entry.name, ...(await fn(entry)) })),
  );
  return { results_by_vault: results, skipped_vaults: [] };
}

/**
 * Run `fn` once per vault that has an available Smart Connections corpus.
 *
 * Vaults without a usable `.smart-env/multi/` are skipped silently and
 * surfaced in `skipped_vaults` with `reason: 'SEMANTIC_INDEX_NOT_FOUND'`.
 * The caller is responsible for the per-entry semantic invariant
 * (`entry.corpus` is defined when `entry.semanticAvailable === true`).
 */
export async function runSemanticFanOut<T extends Record<string, unknown>>(
  registry: IVaultRegistry,
  fn: (entry: IVaultEntry) => Promise<T>,
): Promise<IFanOutResult<T>> {
  const eligible = registry.semanticAvailableEntries();
  const skipped: ISkippedVault[] = registry
    .list()
    .filter((e) => !e.semanticAvailable)
    .map((e) => ({ vault: e.name, reason: 'SEMANTIC_INDEX_NOT_FOUND' }));
  const results = await Promise.all(
    eligible.map(async (entry) => ({ vault: entry.name, ...(await fn(entry)) })),
  );
  return { results_by_vault: results, skipped_vaults: skipped };
}
