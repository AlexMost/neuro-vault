import { ToolHandlerError } from './tool-response.js';
import type { ToolName } from './tool-names.js';
import type { SmartConnectionsCorpusIndex } from './obsidian/smart-connections-corpus-index.js';
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
): IVaultEntry & { corpus: SmartConnectionsCorpusIndex } {
  const entry = resolveVault(input, registry, opts);
  if (!entry.semanticAvailable) {
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_NOT_FOUND',
      `Semantic index for vault "${entry.name}" is unavailable: ` +
        `${entry.semanticUnavailableReason ?? 'unknown reason'}`,
      {
        details: {
          vault: entry.name,
          hint: `open vault "${entry.name}" in Obsidian with Smart Connections installed`,
        },
      },
    );
  }
  // `semanticAvailable === true` is set in VaultRegistry.create only after a
  // successful corpus snapshot, so corpus is defined at this point. The cast
  // bridges what TS cannot prove (the flag and field are independent decls).
  return entry as IVaultEntry & { corpus: SmartConnectionsCorpusIndex };
}
