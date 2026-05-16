import fs from 'node:fs';
import path from 'node:path';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import type { ServerConfig, IVaultConfig } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const DEFAULT_MODEL_ID = 'TaylorAI/bge-micro-v2';
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function basenameNoTrailingSlash(p: string): string {
  return path.basename(p.replace(/\/+$/, ''));
}

function buildVaultConfig(rawPath: string): IVaultConfig {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`--vault: path must be absolute, got "${rawPath}"`);
  }
  const normalizedPath = path.resolve(rawPath);
  const name = basenameNoTrailingSlash(normalizedPath);
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(
      `--vault: directory basename "${name}" is not a valid vault identifier ` +
        `(allowed: alphanumerics, "_", "-", 1-64 chars). Rename the directory.`,
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

export async function parseConfig(argv: string[]): Promise<ServerConfig> {
  const args = await yargs(hideBin(argv))
    .scriptName('neuro-vault-mcp')
    .usage('$0 --vault <path> [--vault <path> ...]\n\nMCP server for one or more Obsidian vaults.')
    .option('vault', {
      type: 'string',
      array: true,
      describe:
        'Absolute path to a vault directory. Repeat for multi-vault. The MCP-side alias is derived from the directory basename.',
    })
    .option('semantic', {
      type: 'boolean',
      default: true,
      describe: 'Enable semantic search module (Smart Connections embeddings)',
    })
    .option('operations', {
      type: 'boolean',
      default: true,
      describe: 'Enable vault operations module (Obsidian CLI required at call time)',
    })
    .option('obsidian-cli', {
      type: 'string',
      describe: 'Path to the obsidian CLI binary (default: "obsidian" from PATH)',
    })
    .strict()
    .help()
    .version(false)
    .exitProcess(false)
    .parse();

  const rawVaults = (args.vault ?? []) as string[];
  if (rawVaults.length === 0) {
    throw new Error('--vault is required: provide at least one vault with --vault <path>');
  }

  if (!args.semantic && !args.operations) {
    throw new Error('At least one module must be enabled (--semantic or --operations)');
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

  return {
    vaults,
    semantic: {
      enabled: args.semantic,
      modelKey: DEFAULT_MODEL_KEY,
      modelId: DEFAULT_MODEL_ID,
    },
    operations: {
      enabled: args.operations,
      binaryPath: args['obsidian-cli'],
    },
  };
}
