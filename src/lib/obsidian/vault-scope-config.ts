import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { createVaultScope, isUsableExclusionPattern, type VaultScope } from './vault-scope.js';

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
  } catch (err) {
    gitignoreLines = undefined;
    // A missing .gitignore is the common case and stays silent; anything else
    // (EACCES, EIO) silently *widens* scope, so it gets the same visibility
    // the config failures get (design D5).
    if ((err as { code?: string }).code !== 'ENOENT') {
      warn(`neuro-vault: cannot read .gitignore for vault at ${vaultRoot}; using default scope`);
    }
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

  return createVaultScope({ gitignoreLines, configExclusions, warn });
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
  // Valid JSON of the wrong shape (`null`, `[...]`, `"glob"`, `42`) would
  // otherwise yield `undefined` from the `.exclusions` lookup and be
  // indistinguishable from "valid object, no exclusions key" — a bare array of
  // globs is the natural mis-write of this format and must not be silent (D5).
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(
      `neuro-vault: ${SCOPE_CONFIG_PATH} must be a JSON object with an "exclusions" array (vault at ${vaultRoot}); using default scope`,
    );
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
  // An empty entry makes picomatch throw and a `!`-prefixed one inverts the
  // predicate; drop them here so the user sees which entry was rejected.
  const rejected = exclusions.filter((e) => !isUsableExclusionPattern(e));
  if (rejected.length > 0) {
    warn(
      `neuro-vault: ignoring unusable "exclusions" entries in ${SCOPE_CONFIG_PATH} (vault at ${vaultRoot}): ` +
        `${rejected.map((e) => JSON.stringify(e)).join(', ')} — an entry must be non-empty and must not start with "!" (exclusions only add, never re-include)`,
    );
  }
  return exclusions.filter(isUsableExclusionPattern);
}
