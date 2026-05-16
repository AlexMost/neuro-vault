import { ToolHandlerError } from './tool-response.js';
import type { ToolName } from './tool-names.js';
import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

export interface IResolveVaultOpts {
  tool: ToolName;
  requireSemantic?: boolean;
}

export function resolveVault(
  input: { vault?: string },
  registry: IVaultRegistry,
  opts: IResolveVaultOpts,
): IVaultEntry {
  let entry: IVaultEntry;
  if (input.vault !== undefined && input.vault !== '') {
    entry = registry.require(input.vault);
  } else if (!registry.isMulti()) {
    entry = registry.list()[0];
  } else {
    throw new ToolHandlerError(
      'VAULT_REQUIRED',
      `Tool "${opts.tool}" requires a vault: parameter in multi-vault mode`,
      { details: { tool: opts.tool, registered_vaults: registry.names() } },
    );
  }
  if (opts.requireSemantic && !entry.semanticAvailable) {
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_NOT_FOUND',
      `Semantic index for vault "${entry.name}" is unavailable: ${
        entry.semanticUnavailableReason ?? 'unknown reason'
      }`,
      {
        details: {
          vault: entry.name,
          hint: `open vault "${entry.name}" in Obsidian with Smart Connections installed`,
        },
      },
    );
  }
  return entry;
}
