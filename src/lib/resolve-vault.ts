import { ToolHandlerError } from './tool-response.js';
import type { ToolName } from './tool-names.js';
import type { BackendStatus, ISemanticBackend } from './obsidian/semantic-backend.js';
import type { IRegisteredVault, IVaultRegistry } from './vault-registry.js';

export interface IResolveVaultOpts {
  tool: ToolName;
}

export function resolveVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: IResolveVaultOpts,
): IRegisteredVault {
  if (input.vault !== undefined && input.vault !== '') {
    return registry.require(input.vault);
  }
  if (!registry.isMulti()) {
    return registry.list()[0];
  }
  throw new ToolHandlerError(
    'VAULT_REQUIRED',
    `Tool "${opts.tool}" requires a vault: parameter in multi-vault mode`,
    { details: { tool: opts.tool, registered_vaults: registry.names() } },
  );
}

/**
 * The error the readiness gate reports for a vault whose corpus cannot serve
 * in `status` — from the status read up front, or from a read the corpus
 * refused afterwards (`CorpusNotReadyError`): one vocabulary for both.
 */
export function semanticReadinessError(
  entry: IRegisteredVault,
  status: BackendStatus,
): ToolHandlerError {
  switch (status.state) {
    case 'indexing':
      return new ToolHandlerError(
        'SEMANTIC_INDEX_BUILDING',
        `Semantic index for vault "${entry.name}" is still building`,
        {
          details: {
            vault: entry.name,
            indexed: status.indexed ?? 0,
            total: status.total ?? 0,
          },
        },
      );
    case 'disabled':
      return new ToolHandlerError(
        'SEMANTIC_DISABLED',
        `Semantic search is disabled for vault "${entry.name}"`,
        {
          details: {
            vault: entry.name,
            hint: 'set "semantic": true in the vault\'s .neuro-vault/config.json',
          },
        },
      );
    default: {
      // The reason belongs in `details` as its own field, not only
      // interpolated into the message: a client reads `details`
      // structurally, and prose is not a channel it can parse.
      const reason = status.reason ?? 'unknown reason';
      return new ToolHandlerError(
        'SEMANTIC_INDEX_NOT_FOUND',
        `Semantic index for vault "${entry.name}" is unavailable: ${reason}`,
        {
          details: {
            vault: entry.name,
            reason,
            hint: `build it with: neuro-vault-mcp index --vault ${entry.path}`,
          },
        },
      );
    }
  }
}

/**
 * The vault, once its backend reports `ready` — read once, here, for the
 * whole tool call (spec: the status is read once per semantic tool call).
 */
export async function resolveSemanticVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: IResolveVaultOpts,
): Promise<IRegisteredVault & { backend: ISemanticBackend }> {
  const entry = resolveVault(input, registry, opts);
  const backend = entry.backend;
  // An absent backend means the semantic module is globally off for this
  // server; it is reported through the same `unavailable` branch as a
  // backend that reports its own failure reason.
  const status: BackendStatus =
    backend === undefined
      ? { state: 'unavailable', reason: 'the semantic module is disabled for this server' }
      : await backend.status();
  if (backend === undefined || status.state !== 'ready') {
    throw semanticReadinessError(entry, status);
  }
  // The check above proves `entry.backend` is defined and ready; the cast
  // bridges what TS cannot narrow through the `backend` local.
  return entry as IRegisteredVault & { backend: ISemanticBackend };
}
