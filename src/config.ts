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
      '$0 --vault <path>\n\nMCP server for semantic search over an Obsidian vault using Smart Connections embeddings.',
    )
    .option('vault', {
      type: 'string',
      demandOption: true,
      describe: 'Absolute path to the Obsidian vault directory',
    })
    .strict()
    .help()
    .version(false)
    .parse();

  const vaultPath = args.vault;

  if (!path.isAbsolute(vaultPath)) {
    throw new Error('--vault must be an absolute path');
  }

  const normalizedVaultPath = path.resolve(vaultPath);

  return {
    vaultPath: normalizedVaultPath,
    semantic: {
      enabled: true,
      smartEnvPath: path.join(normalizedVaultPath, '.smart-env', 'multi'),
      modelKey: DEFAULT_MODEL_KEY,
      modelId: DEFAULT_MODEL_ID,
    },
    operations: {
      enabled: false,
    },
  };
}
