import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { IndexCliOptions } from './config.js';
import type { IVaultConfig } from './types.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { CorpusStore } from './lib/obsidian/corpus/shard-store.js';
import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileSummary,
} from './lib/obsidian/corpus/reconcile.js';
import type { EmbedFn } from './lib/obsidian/corpus/types.js';
import { EmbeddingService } from './modules/semantic/embedding-service.js';

interface OutStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embed function shared by every vault in the run. */
  createEmbed?: () => EmbedFn;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbed(): EmbedFn {
  const service = new EmbeddingService();
  return (text) => service.embed(text);
}

function createProgressRenderer(stdout: OutStream, vaultName: string) {
  let lastStep = -1;
  return ({ indexed, total }: { indexed: number; total: number }): void => {
    if (stdout.isTTY) {
      stdout.write(`\rindexing ${vaultName}: ${indexed}/${total}`);
      if (indexed === total) stdout.write('\n');
      return;
    }
    const step = total === 0 ? 10 : Math.floor((indexed / total) * 10);
    if (step > lastStep) {
      lastStep = step;
      stdout.write(`indexing ${vaultName}: ${indexed}/${total}\n`);
    }
  };
}

function writeSummary(stdout: OutStream, vaultName: string, s: ReconcileSummary): void {
  stdout.write(
    `indexed ${vaultName}: total=${s.total} embedded=${s.embedded} reused=${s.reused} ` +
      `renamed=${s.renamed} deleted=${s.deleted} failed=${s.failed}\n`,
  );
}

async function reconcileOne(
  vault: IVaultConfig,
  embed: EmbedFn,
  reconcile: NonNullable<IndexCommandDeps['reconcile']>,
  stdout: OutStream,
): Promise<ReconcileSummary> {
  const scope = await loadVaultScope(vault.path);
  const reader = new FsVaultReader({ vaultRoot: vault.path, scope });
  const store = new CorpusStore(vault.path);
  return reconcile(
    {
      vaultRoot: vault.path,
      scan: () => reader.scan(),
      stat: async (relPath) => {
        const s = await stat(path.join(vault.path, relPath));
        return { mtime: s.mtimeMs, size: s.size };
      },
      readNote: async (relPath) => {
        const abs = path.join(vault.path, relPath);
        const s = await stat(abs);
        const content = await readFile(abs, 'utf8');
        return { content, mtime: s.mtimeMs, size: s.size };
      },
      embed,
      store,
    },
    { onProgress: createProgressRenderer(stdout, vault.name) },
  );
}

export async function runIndexCommand(
  options: IndexCliOptions,
  deps: IndexCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const reconcile = deps.reconcile ?? reconcileCorpus;
  const embed = (deps.createEmbed ?? defaultEmbed)();

  let complete = true;
  for (const vault of options.vaults) {
    try {
      const summary = await reconcileOne(vault, embed, reconcile, stdout);
      writeSummary(stdout, vault.name, summary);
      if (summary.failed > 0) complete = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stdout.isTTY) stdout.write('\n');
      stderr.write(`index ${vault.name}: ${message}\n`);
      complete = false;
    }
  }
  return complete ? 0 : 1;
}
