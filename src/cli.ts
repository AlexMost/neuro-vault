#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { parseConfig } from './config.js';
import {
  startNeuroVaultServer,
  type NeuroVaultStartupDependencies,
} from './server.js';

export async function main(
  argv: string[] = process.argv,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const config = parseConfig(argv);
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

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  void run();
}
