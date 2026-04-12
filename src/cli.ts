#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseConfig } from './config.js';
import { startNeuroVaultServer, type NeuroVaultStartupDependencies } from './server.js';

export async function main(
  argv: string[] = process.argv,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const config = await parseConfig(argv);
  await startNeuroVaultServer(config, deps);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

function checkIsEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const invokedFile = realpathSync(process.argv[1]);
    return thisFile === invokedFile;
  } catch {
    return false;
  }
}

if (checkIsEntrypoint()) {
  void run();
}
