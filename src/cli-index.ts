import { hostname } from 'node:os';

import type { IndexCliOptions } from './config.js';
import type { IVaultConfig } from './types.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { buildReconcileFsDeps } from './lib/obsidian/corpus/fs-deps.js';
import { corpusRootOf } from './lib/obsidian/corpus/layout.js';
import { pruneOtherCorpora } from './lib/obsidian/corpus/prune.js';
import { acquireCorpusLock, describeHolder } from './lib/obsidian/corpus/reconcile-lock.js';
import { ShardStore } from './lib/obsidian/corpus/shard-store.js';
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
  /**
   * Deletes every other model's corpus under the vault while holding its lock,
   * returning what it removed (design D8); calls `onLockWait` once if it has
   * to wait for that lock. Defaults to {@link defaultPrune}.
   */
  prune?: (
    vaultRoot: string,
    keepModelKey: string,
    opts?: { onLockWait?: LockWaitFn },
  ) => Promise<string[]>;
  stdout?: OutStream;
  stderr?: OutStream;
}

type LockWaitFn = NonNullable<ReconcileOptions['onLockWait']>;

async function defaultPrune(
  vaultRoot: string,
  keepModelKey: string,
  opts: { onLockWait?: LockWaitFn } = {},
): Promise<string[]> {
  // Under the lock, so no other process is mid-pass in a directory that goes.
  const lock = await acquireCorpusLock(corpusRootOf(vaultRoot), {}, { onWait: opts.onLockWait });
  try {
    return await pruneOtherCorpora(vaultRoot, keepModelKey);
  } finally {
    await lock.release();
  }
}

/** The stderr line `index` writes when a vault's lock is held by another process (design D9). */
function lockWaitLine(stderr: OutStream, vaultName: string): LockWaitFn {
  return ({ holderPid, holderHost }) => {
    // The host only when it is not this one; no holder at all while its pid is unknown.
    const host = holderHost === hostname() ? null : holderHost;
    const holder = holderPid === null ? '' : ` (${describeHolder(holderPid, host)})`;
    stderr.write(`waiting for another neuro-vault process${holder} to finish with ${vaultName}…\n`);
  };
}

function writePruned(stdout: OutStream, vaultName: string, removed: string[]): void {
  stdout.write(
    removed.length === 0
      ? `pruned ${vaultName}: nothing to remove\n`
      : `pruned ${vaultName}: removed ${[...removed].sort().join(', ')}\n`,
  );
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
  stderr: OutStream,
): Promise<ReconcileSummary> {
  const scope = await loadVaultScope(vault.path);
  const reader = new FsVaultReader({ vaultRoot: vault.path, scope });
  const identity = corpusIdentityOf(embedder.identity);
  const store = new ShardStore(vault.path, { modelKey: identity.model_key, dims: identity.dims });
  return reconcile(
    {
      ...buildReconcileFsDeps({ vaultRoot: vault.path, reader }),
      embedDocuments: embedder.embedDocuments,
      store,
      identity,
    },
    {
      onProgress: createProgressRenderer(stdout, vault.name),
      // Before any progress output, so it never splits a TTY progress line.
      onLockWait: lockWaitLine(stderr, vault.name),
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
  const prune = deps.prune ?? defaultPrune;
  const createEmbedder =
    deps.createEmbedder ??
    ((profile: ModelProfile) =>
      defaultEmbedder(profile, { shared: options.shared, cliPath: deps.cliPath, stderr }));
  const embedder = createEmbedder(options.model);

  let complete = true;
  for (const vault of options.vaults) {
    try {
      const summary = await reconcileOne(vault, embedder, reconcile, stdout, stderr);
      writeSummary(stdout, vault.name, summary);
      if (summary.failed > 0) complete = false;
      // After the reconcile, so the selected model's corpus is current before the
      // others go. Skipped when it threw (the catch below) and when it indexed
      // nothing: reconcile contains per-note embed failures and returns, so an
      // offline first run of a new model must be caught here — never leave a
      // vault with nothing to serve (design D8).
      if (options.prune) {
        if (summary.total > 0 && summary.embedded + summary.reused + summary.renamed === 0) {
          stderr.write(
            `not pruning ${vault.name}: no note was indexed with ${embedder.identity.model_key}, ` +
              `so the other models' corpora are kept\n`,
          );
        } else {
          const removed = await prune(vault.path, embedder.identity.model_key, {
            onLockWait: lockWaitLine(stderr, vault.name),
          });
          writePruned(stdout, vault.name, removed);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stdout.isTTY) stdout.write('\n');
      stderr.write(`index ${vault.name}: ${message}\n`);
      complete = false;
    }
  }
  return complete ? 0 : 1;
}
