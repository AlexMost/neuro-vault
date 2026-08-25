import fs from 'node:fs';
import path from 'node:path';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import { MODEL_ID, MODEL_KEY } from './lib/obsidian/corpus/types.js';

import type { ServerConfig, IVaultConfig } from './types.js';
import { packageMeta } from './package-meta.js';

const DEFAULT_MODEL_ID = MODEL_ID;
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function basenameNoTrailingSlash(p: string): string {
  return path.basename(p.replace(/\/+$/, ''));
}

export interface IndexCliOptions {
  vaults: IVaultConfig[];
}

/**
 * The three ways argument parsing can end.
 *
 * `handled` means yargs itself satisfied the invocation — it printed help or
 * the version and, because of `.exitProcess(false)`, returned instead of
 * exiting. There is no config to produce and nothing left to validate.
 */
export type ParsedCli =
  | { kind: 'run'; config: ServerConfig }
  | { kind: 'index'; options: IndexCliOptions }
  | { kind: 'handled' };

function buildVaultConfig(rawPath: string): IVaultConfig {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`--vault: path must be absolute, got "${rawPath}"`);
  }
  const normalizedPath = path.resolve(rawPath);
  const name = basenameNoTrailingSlash(normalizedPath);
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(
      `--vault: directory basename "${name}" is not a valid vault identifier ` +
        `(allowed pattern: /^[a-zA-Z0-9_-]{1,64}$/ — ASCII letters, digits, "_", or "-"; ` +
        `1-64 chars; no spaces or Unicode). Rename the directory.`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(`--vault: directory does not exist: "${normalizedPath}"`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`--vault: path is not a directory: "${normalizedPath}"`);
  }
  return {
    name,
    path: normalizedPath,
    smartEnvPath: path.join(normalizedPath, '.smart-env', 'multi'),
  };
}

function validateVaults(rawVaults: string[]): IVaultConfig[] {
  if (rawVaults.length === 0) {
    throw new Error('--vault is required: provide at least one vault with --vault <path>');
  }

  const vaults: IVaultConfig[] = rawVaults.map(buildVaultConfig);
  // Case-insensitive uniqueness: vault lookup is case-insensitive (so callers
  // can type "obsidian" or "Obsidian"), which means two vaults with basenames
  // that differ only in case (Sandbox vs sandbox) would alias the same lookup
  // key — rejected.
  const seen = new Set<string>();
  for (const v of vaults) {
    const key = v.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `--vault: two vaults share the directory basename "${v.name}" (case-insensitive). ` +
          `Rename one of the directories — the basename doubles as the MCP-side alias and must be unique.`,
      );
    }
    seen.add(key);
  }

  return vaults;
}

const VAULT_OPTION = {
  type: 'string',
  array: true,
  describe:
    'Absolute path to a vault directory. Repeat for multi-vault. The MCP-side alias is derived from the directory basename.',
} as const;

export async function parseConfig(argv: string[]): Promise<ParsedCli> {
  const args = await yargs(hideBin(argv))
    .scriptName('neuro-vault-mcp')
    .usage('$0 --vault <path> [--vault <path> ...]\n\nMCP server for one or more Obsidian vaults.')
    .command('$0', 'Run the MCP server over stdio (default)', (y) =>
      y.option('vault', VAULT_OPTION).option('semantic', {
        type: 'boolean',
        default: true,
        describe: 'Enable semantic search module (Smart Connections embeddings)',
      }),
    )
    .command('index', 'Build or refresh the embedding corpus for each vault, then exit', (y) =>
      y.option('vault', VAULT_OPTION),
    )
    .strict()
    .help()
    .version(packageMeta.version)
    .exitProcess(false)
    .parse();

  // yargs already satisfied this invocation by printing help or the version.
  // `.exitProcess(false)` means it did not exit for us, so stop here — running
  // the --vault guard below would print a spurious error after the help text
  // and exit non-zero.
  if (args.help === true || args.version === true) {
    return { kind: 'handled' };
  }

  const vaults = validateVaults((args.vault as string[] | undefined) ?? []);

  if (args._[0] === 'index') {
    return { kind: 'index', options: { vaults } };
  }
  return {
    kind: 'run',
    config: {
      vaults,
      semantic: {
        enabled: (args.semantic as boolean | undefined) ?? true,
        modelKey: MODEL_KEY,
        modelId: DEFAULT_MODEL_ID,
      },
    },
  };
}
