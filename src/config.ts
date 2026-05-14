import path from 'node:path';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import type { ServerConfig } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const DEFAULT_MODEL_ID = 'TaylorAI/bge-micro-v2';

export async function parseConfig(argv: string[]): Promise<ServerConfig> {
  const args = await yargs(hideBin(argv))
    .scriptName('neuro-vault-mcp')
    .usage(
      '$0 --vault <path>\n\nMCP server for an Obsidian vault: semantic search and vault operations.',
    )
    .option('vault', {
      type: 'string',
      demandOption: true,
      describe: 'Absolute path to the Obsidian vault directory',
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
    .option('vault-name', {
      type: 'string',
      describe:
        'Override the Obsidian vault name used in CLI invocations. Defaults to the basename of --vault. Set this only if you renamed the vault in Obsidian\'s "Manage vaults" UI and the display name differs from the directory name.',
    })
    .strict()
    .help()
    .version(false)
    .parse();

  if (!path.isAbsolute(args.vault)) {
    throw new Error('--vault must be an absolute path');
  }

  if (!args.semantic && !args.operations) {
    throw new Error('At least one module must be enabled (--semantic or --operations)');
  }

  if (args['vault-name'] !== undefined && args['vault-name'].trim() === '') {
    throw new Error('--vault-name must not be empty');
  }

  const normalizedVaultPath = path.resolve(args.vault);

  return {
    vaultPath: normalizedVaultPath,
    semantic: {
      enabled: args.semantic,
      smartEnvPath: path.join(normalizedVaultPath, '.smart-env', 'multi'),
      modelKey: DEFAULT_MODEL_KEY,
      modelId: DEFAULT_MODEL_ID,
    },
    operations: {
      enabled: args.operations,
      binaryPath: args['obsidian-cli'],
      vaultName: args['vault-name']?.trim() ?? path.basename(normalizedVaultPath),
    },
  };
}
