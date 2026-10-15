#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseConfig } from './config.js';
import { runIndexCommand, type IndexCommandDeps } from './cli-index.js';
import type { DaemonCommandDeps } from './cli-daemon.js';
import { startNeuroVaultServer, type NeuroVaultStartupDependencies } from './server.js';

/**
 * Realpath of this CLI script: `dist/cli.js` in the bundle, `src/cli.ts` under
 * a TypeScript runner (where the `.ts` suffix makes the shared embedding
 * provider fall back in-process). The daemon is keyed by this file's size and
 * mtime and spawned from it, so every command passes the same path down.
 */
function currentCliPath(): string | undefined {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

export async function main(
  argv: string[] = process.argv,
  deps: {
    server?: NeuroVaultStartupDependencies;
    index?: IndexCommandDeps;
    daemon?: DaemonCommandDeps;
  } = {},
): Promise<void> {
  const parsed = await parseConfig(argv);
  // yargs already satisfied this invocation (--help or --version); stop here.
  if (parsed.kind === 'handled') {
    return;
  }
  if (parsed.kind === 'daemon') {
    const { runDaemonCommand } = await import('./cli-daemon.js');
    process.exitCode = await runDaemonCommand(parsed.options, {
      cliPath: currentCliPath(),
      ...deps.daemon,
    });
    return;
  }
  if (parsed.kind === 'index') {
    process.exitCode = await runIndexCommand(parsed.options, {
      cliPath: currentCliPath(),
      ...deps.index,
    });
    return;
  }
  await startNeuroVaultServer(parsed.config, { cliPath: currentCliPath(), ...deps.server });
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
