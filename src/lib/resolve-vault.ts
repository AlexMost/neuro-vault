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
  // Any non-`ready` state (absent backend, `indexing`, `disabled`,
  // `unavailable`) reports the same SEMANTIC_INDEX_NOT_FOUND today; splitting
  // those into their own error codes is a later change, not this one.
  if (entry.backend === undefined || entry.backend.status().state !== 'ready') {
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_NOT_FOUND',
      `Semantic index for vault "${entry.name}" is unavailable: ` +
        `${entry.backend?.status().reason ?? 'unknown reason'}`,
      {
        details: {
          vault: entry.name,
          hint: `open vault "${entry.name}" in Obsidian with Smart Connections installed`,
        },
      },
    );
  }
  // The check above proves `entry.backend` is defined and ready; the cast
  // bridges what TS cannot narrow through the optional-chained `.status()`
  // call in the condition above.
  return entry as IVaultEntry & { backend: SemanticBackend };
}
