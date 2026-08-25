import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { loadVaultConfig, VAULT_CONFIG_PATH, type VaultConfigFile } from './vault-config.js';
import { createVaultScope, type VaultScope } from './vault-scope.js';

/** Vault-relative location of the per-vault scope config. */
export const SCOPE_CONFIG_PATH = VAULT_CONFIG_PATH;

export interface LoadVaultScopeOptions {
  readFile?: (p: string, enc: 'utf8') => Promise<string>;
  /** Defaults to stderr — stdout is the MCP transport and must stay clean. */
  warn?: (message: string) => void;
  /**
   * A config already parsed by `loadVaultConfig`, so a caller that needs both
   * the scope and the config (the vault registry) parses the file once
   * instead of twice (design D8).
   */
  config?: VaultConfigFile;
}

/**
 * Build a vault's scope from its root `.gitignore` and
 * `.neuro-vault/config.json`. Never throws: a missing file means defaults,
 * silently; an unreadable or invalid config means defaults plus one stderr
 * warning naming the vault (design D5 — a scope typo must be visible, but one
 * bad vault must not kill a multi-vault server).
 */
export async function loadVaultScope(
  vaultRoot: string,
  opts: LoadVaultScopeOptions = {},
): Promise<VaultScope> {
  const readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
  const warn = opts.warn ?? ((message) => console.error(message));

  let gitignoreLines: string[] | undefined;
  try {
    gitignoreLines = (await readFile(path.join(vaultRoot, '.gitignore'), 'utf8')).split(/\r?\n/);
  } catch (err) {
    gitignoreLines = undefined;
    // A missing .gitignore is the common case and stays silent; anything else
    // (EACCES, EIO) silently *widens* scope, so it gets the same visibility
    // the config failures get (design D5).
    if ((err as { code?: string }).code !== 'ENOENT') {
      warn(`neuro-vault: cannot read .gitignore for vault at ${vaultRoot}; using default scope`);
    }
  }

  const config = opts.config ?? (await loadVaultConfig(vaultRoot, opts));

  return createVaultScope({ gitignoreLines, configExclusions: config.exclusions, warn });
}
