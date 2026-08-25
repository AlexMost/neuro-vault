import { ToolHandlerError } from './tool-response.js';
import type { ToolName } from './tool-names.js';
import type { SemanticBackend } from './obsidian/semantic-backend.js';
import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

export interface IResolveVaultOpts {
  tool: ToolName;
}

export function resolveVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: IResolveVaultOpts,
): IVaultEntry {
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

export function resolveSemanticVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: IResolveVaultOpts,
): IVaultEntry & { backend: SemanticBackend } {
  const entry = resolveVault(input, registry, opts);
  // An absent backend means the semantic module is globally off for this
  // server; it is reported through the same `unavailable` branch as a
  // backend that reports its own failure reason.
  const status = entry.backend?.status() ?? {
    state: 'unavailable' as const,
    reason: 'the semantic module is disabled for this server',
  };
  switch (status.state) {
    case 'ready':
      // The switch above proves `entry.backend` is defined and ready; the
      // cast bridges what TS cannot narrow through the optional-chained
      // `.status()` call used to compute `status`.
      return entry as IVaultEntry & { backend: SemanticBackend };
    case 'indexing':
      throw new ToolHandlerError(
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
      throw new ToolHandlerError(
        'SEMANTIC_DISABLED',
        `Semantic search is disabled for vault "${entry.name}"`,
        {
          details: {
            vault: entry.name,
            hint: 'set "semantic": true in the vault\'s .neuro-vault/config.json',
          },
        },
      );
    default:
      throw new ToolHandlerError(
        'SEMANTIC_INDEX_NOT_FOUND',
        `Semantic index for vault "${entry.name}" is unavailable: ${status.reason ?? 'unknown reason'}`,
        {
          details: {
            vault: entry.name,
            hint: `build it with: neuro-vault-mcp index --vault ${entry.path}`,
          },
        },
      );
  }
}
