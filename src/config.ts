import path from 'node:path';

import type { ServerConfig } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const DEFAULT_MODEL_ID = 'TaylorAI/bge-micro-v2';

function getFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  return argv[index + 1];
}

export function parseConfig(argv: string[]): ServerConfig {
  const vaultPath = getFlagValue(argv, '--vault');

  if (!vaultPath) {
    throw new Error('Missing required --vault <absolute-path> argument');
  }

  if (!path.isAbsolute(vaultPath)) {
    throw new Error('--vault must be an absolute path');
  }

  const normalizedVaultPath = path.resolve(vaultPath);

  return {
    vaultPath: normalizedVaultPath,
    smartEnvPath: path.join(normalizedVaultPath, '.smart-env', 'multi'),
    modelKey: DEFAULT_MODEL_KEY,
    modelId: DEFAULT_MODEL_ID,
  };
}
