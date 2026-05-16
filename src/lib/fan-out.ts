import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';
import { ToolHandlerError, isFatalToolError } from './tool-response.js';

export interface ISkippedVault {
  vault: string;
  reason: string;
}

export interface IFailedVault {
  vault: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface IFanOutResult<T extends Record<string, unknown>> {
  results_by_vault: Array<{ vault: string } & T>;
  skipped_vaults: ISkippedVault[];
  failed_vaults: IFailedVault[];
}

// If any per-vault rejection carries a fatal-class code (see
// FATAL_TOOL_ERROR_CODES in tool-response.ts), re-throw it instead of
// capturing into failed_vaults. The whole tool call should fail — these
// errors apply uniformly across vaults and surfacing one per vault would be
// misleading. The classification lives next to ToolHandlerError so it's not
// fan-out-specific implementation knowledge.
function findFatalRejection(
  settled: ReadonlyArray<PromiseSettledResult<unknown>>,
): ToolHandlerError | undefined {
  for (const outcome of settled) {
    if (outcome.status === 'rejected' && isFatalToolError(outcome.reason)) {
      return outcome.reason;
    }
  }
  return undefined;
}

function mapRejectionToFailedVault(vault: string, reason: unknown): IFailedVault {
  if (reason instanceof ToolHandlerError) {
    return {
      vault,
      error: {
        code: reason.code,
        message: reason.message,
        ...(reason.details ? { details: reason.details } : {}),
      },
    };
  }
  return {
    vault,
    error: {
      code: 'INTERNAL_ERROR',
      message: reason instanceof Error ? reason.message : String(reason),
    },
  };
}

/**
 * Run `fn` once per registered vault and group results.
 *
 * Use when the operation does not depend on a semantic index (e.g. structural
 * queries that read the disk directly). No vault is skipped; `skipped_vaults`
 * is always an empty array. Per-vault rejections are captured into
 * `failed_vaults` rather than propagated, so one failing vault does not abort
 * the whole multi-vault response. The one exception is errors carrying a
 * fatal-class code (see `FATAL_TOOL_ERROR_CODES` in tool-response.ts): those
 * apply uniformly across vaults and are re-thrown as a single fatal error.
 */
export async function runFanOut<T extends Record<string, unknown>>(
  registry: IVaultRegistry,
  fn: (entry: IVaultEntry) => Promise<T>,
): Promise<IFanOutResult<T>> {
  const entries = registry.list();
  const settled = await Promise.allSettled(entries.map((entry) => fn(entry)));

  const fatalError = findFatalRejection(settled);
  if (fatalError) {
    throw fatalError;
  }

  const results: Array<{ vault: string } & T> = [];
  const failed: IFailedVault[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const vault = entries[i].name;
    if (outcome.status === 'fulfilled') {
      results.push({ vault, ...outcome.value });
    } else {
      failed.push(mapRejectionToFailedVault(vault, outcome.reason));
    }
  }
  return { results_by_vault: results, skipped_vaults: [], failed_vaults: failed };
}

/**
 * Run `fn` once per vault that has an available Smart Connections corpus.
 *
 * Vaults without a usable `.smart-env/multi/` are skipped silently and
 * surfaced in `skipped_vaults` with `reason: 'SEMANTIC_INDEX_NOT_FOUND'`.
 * Per-vault rejections from eligible entries are captured into `failed_vaults`
 * rather than propagated, except for fatal-class codes (see
 * `FATAL_TOOL_ERROR_CODES` in tool-response.ts), which are re-thrown as a
 * single fatal error.
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

  const settled = await Promise.allSettled(eligible.map((entry) => fn(entry)));

  const fatalError = findFatalRejection(settled);
  if (fatalError) {
    throw fatalError;
  }

  const results: Array<{ vault: string } & T> = [];
  const failed: IFailedVault[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const vault = eligible[i].name;
    if (outcome.status === 'fulfilled') {
      results.push({ vault, ...outcome.value });
    } else {
      failed.push(mapRejectionToFailedVault(vault, outcome.reason));
    }
  }
  return { results_by_vault: results, skipped_vaults: skipped, failed_vaults: failed };
}
