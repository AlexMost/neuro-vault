import type { IndexCliOptions } from './config.js';
import type { IVaultConfig } from './types.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { buildReconcileFsDeps } from './lib/obsidian/corpus/fs-deps.js';
import { CorpusStore } from './lib/obsidian/corpus/shard-store.js';
import { corpusIdentityOf, formatRebuild } from './lib/obsidian/corpus/identity.js';
import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileSummary,
} from './lib/obsidian/corpus/reconcile.js';
import type { EmbedDocumentsFn, EmbeddingIdentity } from './lib/obsidian/corpus/types.js';
import { createQueuedEmbedder } from './modules/semantic/embed-queue.js';
import type { ModelProfile } from './modules/semantic/model-profiles.js';
import { createEmbeddingProvider } from './modules/semantic/provider-factory.js';

interface OutStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

/** One embedder for the whole run: what it is, and how to call it. */
export interface IndexEmbedder {
  identity: EmbeddingIdentity;
  embedDocuments: EmbedDocumentsFn;
}

export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embedder shared by every vault in the run, built from the selected profile. */
  createEmbedder?: (profile: ModelProfile) => IndexEmbedder;
  /** Realpath of the running CLI script; the shared embedding daemon is keyed by it. */
  cliPath?: string;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbedder(
  profile: ModelProfile,
  opts: { shared: boolean; cliPath?: string; stderr: OutStream },
): IndexEmbedder {
  // Shared by default: an `index` run next to a live server embeds through the
  // daemon that already holds the model instead of loading a second copy.
  const provider = createEmbeddingProvider({ profile, ...opts });
  // Through the queue so `index` buckets by length exactly as the server does.
  return {
    identity: provider.identity,
    embedDocuments: createQueuedEmbedder(provider).asDocumentEmbedFn(),
  };
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
      embedDocuments: embedder.embedDocuments,
      store,
      identity,
    },
    {
      onProgress: createProgressRenderer(stdout, vault.name),
      onRebuild: ({ stored, active }) => {
        const named = formatRebuild(stored, active);
        stdout.write(
          `rebuilding ${vault.name}: corpus was indexed with ${named.stored}; active model is ${named.active}\n`,
        );
      },
    },
  );
}

export async function runIndexCommand(
  options: IndexCliOptions,
  deps: IndexCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const reconcile = deps.reconcile ?? reconcileCorpus;
  const createEmbedder =
    deps.createEmbedder ??
    ((profile: ModelProfile) =>
      defaultEmbedder(profile, { shared: options.shared, cliPath: deps.cliPath, stderr }));
  const embedder = createEmbedder(options.model);

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
