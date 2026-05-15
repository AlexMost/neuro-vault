import fs from 'node:fs';
import path from 'node:path';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import type { ServerConfig, VaultConfig } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const DEFAULT_MODEL_ID = 'TaylorAI/bge-micro-v2';
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function parseVaultFlag(raw: string): { name?: string; path: string } {
  if (raw.startsWith('/')) {
    return { path: raw };
  }
  const idx = raw.indexOf(':');
  if (idx === -1) {
    throw new Error(`--vault: expected absolute path or name:path, got "${raw}"`);
  }
  const name = raw.slice(0, idx);
  const rest = raw.slice(idx + 1);
  return { name, path: rest };
}

function basenameNoTrailingSlash(p: string): string {
  return path.basename(p.replace(/\/+$/, ''));
}

function buildVaultConfig(raw: string): VaultConfig {
  const parsed = parseVaultFlag(raw);
  if (!path.isAbsolute(parsed.path)) {
    throw new Error(`--vault: path must be absolute, got "${parsed.path}"`);
  }
  const normalizedPath = path.resolve(parsed.path);
  const name = parsed.name ?? basenameNoTrailingSlash(normalizedPath);
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(
      `--vault: invalid vault name "${name}" (allowed: alphanumerics, "_", "-", 1-64 chars)`,
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
    .usage(
      '$0 --vault [name:]<path> [--vault [name:]<path> ...]\n\nMCP server for one or more Obsidian vaults.',
    )
    .option('vault', {
      type: 'string',
      array: true,
      describe:
        'Vault to register. Repeat for multi-vault. Syntax: "<name>:<absolute-path>" or "<absolute-path>" (basename used as name).',
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
    throw new Error('--vault is required: provide at least one vault with --vault [name:]<path>');
  }

  if (!args.semantic && !args.operations) {
    throw new Error('At least one module must be enabled (--semantic or --operations)');
  }

  const vaults: VaultConfig[] = rawVaults.map(buildVaultConfig);
  const seen = new Set<string>();
  for (const v of vaults) {
    if (seen.has(v.name)) {
      throw new Error(`--vault: vault names must be unique, "${v.name}" seen twice`);
    }
    seen.add(v.name);
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
