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
    },
  };
}
