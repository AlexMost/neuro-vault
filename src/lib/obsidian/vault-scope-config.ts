import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { createVaultScope, type VaultScope } from './vault-scope.js';

/** Vault-relative location of the per-vault scope config. */
export const SCOPE_CONFIG_PATH = '.neuro-vault/config.json';

export interface LoadVaultScopeOptions {
  readFile?: (p: string, enc: 'utf8') => Promise<string>;
  /** Defaults to stderr — stdout is the MCP transport and must stay clean. */
  warn?: (message: string) => void;
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
  } catch {
    gitignoreLines = undefined;
  }

  let configExclusions: string[] | undefined;
  try {
    const raw = await readFile(path.join(vaultRoot, SCOPE_CONFIG_PATH), 'utf8');
    configExclusions = parseExclusions(raw, vaultRoot, warn);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      warn(
        `neuro-vault: cannot read ${SCOPE_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`,
      );
    }
  }

  return createVaultScope({ gitignoreLines, configExclusions });
}

function parseExclusions(
  raw: string,
  vaultRoot: string,
  warn: (message: string) => void,
): string[] | undefined {
  const warnInvalidJson = () =>
    warn(
      `neuro-vault: invalid JSON in ${SCOPE_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnInvalidJson();
    return undefined;
  }
  if (parsed === null) {
    warnInvalidJson();
    return undefined;
  }
  const exclusions = (parsed as { exclusions?: unknown }).exclusions;
  if (exclusions === undefined) return undefined;
  if (!Array.isArray(exclusions) || !exclusions.every((e) => typeof e === 'string')) {
    warn(
      `neuro-vault: "exclusions" in ${SCOPE_CONFIG_PATH} must be a string array (vault at ${vaultRoot}); using default scope`,
    );
    return undefined;
  }
  return exclusions;
}
