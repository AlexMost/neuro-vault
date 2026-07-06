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
 * No vault is skipped — a vault without a semantic index still runs `fn`
 * (e.g. hybrid `search_notes` returns lexical-only results there), so
 * `skipped_vaults` is always an empty array; the field stays in the response
 * shape for contract stability. Per-vault rejections are captured into
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
