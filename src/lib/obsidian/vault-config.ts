import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { isUsableExclusionPattern } from './vault-scope.js';

/** Vault-relative location of the per-vault config file. */
export const VAULT_CONFIG_PATH = '.neuro-vault/config.json';

/** The parsed, validated shape of `.neuro-vault/config.json`. */
export interface VaultConfigFile {
  exclusions?: string[];
  semantic?: boolean;
}

export interface LoadVaultConfigOptions {
  readFile?: (p: string, enc: 'utf8') => Promise<string>;
  /** Defaults to stderr — stdout is the MCP transport and must stay clean. */
  warn?: (message: string) => void;
}

/**
 * Read and validate `.neuro-vault/config.json`. The sole reader of this file
 * (design D8) — `loadVaultScope` and the vault registry both go through this
 * loader instead of re-parsing it themselves, so the JSON read, the shape
 * check, and the warning text live in exactly one place. Never throws: a
 * missing file yields an empty config silently; an unreadable or invalid one
 * yields an empty config plus one stderr warning naming the vault (design D5
 * — a config typo must be visible, but one bad vault must not kill a
 * multi-vault server).
 */
export async function loadVaultConfig(
  vaultRoot: string,
  opts: LoadVaultConfigOptions = {},
): Promise<VaultConfigFile> {
  const readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
  const warn = opts.warn ?? ((message) => console.error(message));

  try {
    const raw = await readFile(path.join(vaultRoot, VAULT_CONFIG_PATH), 'utf8');
    return parseVaultConfig(raw, vaultRoot, warn);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      warn(
        `neuro-vault: cannot read ${VAULT_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`,
      );
    }
    return {};
  }
}

function parseVaultConfig(
  raw: string,
  vaultRoot: string,
  warn: (message: string) => void,
): VaultConfigFile {
  const warnInvalidJson = () =>
    warn(
      `neuro-vault: invalid JSON in ${VAULT_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnInvalidJson();
    return {};
  }
  // Valid JSON of the wrong shape (`null`, `[...]`, `"glob"`, `42`) would
  // otherwise yield `undefined` from the `.exclusions` lookup and be
  // indistinguishable from "valid object, no exclusions key" — a bare array of
  // globs is the natural mis-write of this format and must not be silent (D5).
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(
      `neuro-vault: ${VAULT_CONFIG_PATH} must be a JSON object with an "exclusions" array (vault at ${vaultRoot}); using default scope`,
    );
    return {};
  }

  const exclusionsRaw = (parsed as { exclusions?: unknown }).exclusions;
  let exclusions: string[] | undefined;
  if (exclusionsRaw !== undefined) {
    if (!Array.isArray(exclusionsRaw) || !exclusionsRaw.every((e) => typeof e === 'string')) {
      warn(
        `neuro-vault: "exclusions" in ${VAULT_CONFIG_PATH} must be a string array (vault at ${vaultRoot}); using default scope`,
      );
    } else {
      // An empty entry makes picomatch throw and a `!`-prefixed one inverts
      // the predicate; drop them here so the user sees which entry was
      // rejected.
      const rejected = exclusionsRaw.filter((e) => !isUsableExclusionPattern(e));
      if (rejected.length > 0) {
        warn(
          `neuro-vault: ignoring unusable "exclusions" entries in ${VAULT_CONFIG_PATH} (vault at ${vaultRoot}): ` +
            `${rejected.map((e) => JSON.stringify(e)).join(', ')} — an entry must be non-empty and must not start with "!" (exclusions only add, never re-include)`,
        );
      }
      exclusions = exclusionsRaw.filter(isUsableExclusionPattern);
    }
  }

  const semanticRaw = (parsed as { semantic?: unknown }).semantic;
  if (semanticRaw !== undefined && typeof semanticRaw !== 'boolean') {
    warn(
      `neuro-vault: "semantic" in ${VAULT_CONFIG_PATH} must be true or false ` +
        `(vault at ${vaultRoot}); treating the vault as semantically enabled`,
    );
  }
  const semantic = typeof semanticRaw === 'boolean' ? semanticRaw : undefined;

  return { exclusions, semantic };
}
