import type { IndexCliOptions } from './config.js';
import type { IVaultConfig } from './types.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { buildReconcileFsDeps } from './lib/obsidian/corpus/fs-deps.js';
import { CorpusStore } from './lib/obsidian/corpus/shard-store.js';
import { corpusIdentityOf } from './lib/obsidian/corpus/identity.js';
import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileSummary,
} from './lib/obsidian/corpus/reconcile.js';
import type { EmbedFn, EmbeddingIdentity } from './lib/obsidian/corpus/types.js';
import { EmbeddingService } from './modules/semantic/embedding-service.js';
import { DEFAULT_MODEL_KEY, resolveModelProfile } from './modules/semantic/model-profiles.js';

interface OutStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

/** One embedder for the whole run: what it is, and how to call it. */
export interface IndexEmbedder {
  identity: EmbeddingIdentity;
  embed: EmbedFn;
}

export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embedder shared by every vault in the run. */
  createEmbedder?: () => IndexEmbedder;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbedder(): IndexEmbedder {
  const service = new EmbeddingService({ profile: resolveModelProfile(DEFAULT_MODEL_KEY) });
  return { identity: service.identity, embed: (text) => service.embed(text) };
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
  embedder: IndexEmbedder,
  reconcile: NonNullable<IndexCommandDeps['reconcile']>,
  stdout: OutStream,
): Promise<ReconcileSummary> {
  const scope = await loadVaultScope(vault.path);
  const reader = new FsVaultReader({ vaultRoot: vault.path, scope });
  const identity = corpusIdentityOf(embedder.identity);
  const store = new CorpusStore(vault.path, { dims: identity.dims });
  return reconcile(
    {
      ...buildReconcileFsDeps({ vaultRoot: vault.path, reader }),
      embed: embedder.embed,
      store,
      identity,
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
  const embedder = (deps.createEmbedder ?? defaultEmbedder)();

  let complete = true;
  for (const vault of options.vaults) {
    try {
      const summary = await reconcileOne(vault, embedder, reconcile, stdout);
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
