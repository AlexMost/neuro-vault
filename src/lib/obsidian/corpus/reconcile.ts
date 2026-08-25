import { createHash } from 'node:crypto';

import { buildEmbedInputs } from './embed-text.js';
import { CorpusStore, ensureCorpusGitignored } from './shard-store.js';
import {
  EMBED_VERSION,
  MODEL_DIMS,
  MODEL_ID,
  MODEL_KEY,
  SC_PARITY_STRATEGY,
  type CorpusBlock,
  type CorpusShard,
  type EmbedFn,
} from './types.js';
import { encodeVector } from './vector-codec.js';

export interface NoteStat {
  /** Modification time in milliseconds, as `fs.Stats.mtimeMs` reports it. */
  mtime: number;
  size: number;
}

export interface NoteContent extends NoteStat {
  content: string;
}

export interface ReconcileDeps {
  vaultRoot: string;
  /** Scope-filtered, vault-relative `.md` paths. Production: `FsVaultReader.scan()`. */
  scan: () => Promise<string[]>;
  /**
   * Metadata only, so an unchanged note is skipped without being read. Split
   * from `readNote` deliberately: the pre-check is what keeps a no-op reconcile
   * off the note bodies entirely.
   */
  stat: (relPath: string) => Promise<NoteStat>;
  /** Content plus the metadata observed with it, so the shard records what was hashed. */
  readNote: (relPath: string) => Promise<NoteContent>;
  embed: EmbedFn;
  store: CorpusStore;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

export interface ReconcileOptions {
  onProgress?: (progress: { indexed: number; total: number }) => void;
  /**
   * Stops the run at the next note boundary. A pass is thousands of reads and
   * embeds, each an active libuv request, so a server whose client hung up
   * mid-index needs a way to stop rather than outlive it (design D10). The
   * summary returned after an abort is partial by construction — the caller
   * that aborted is expected to discard it.
   */
  signal?: AbortSignal;
}

export interface ReconcileSummary {
  /** Notes in scope for this run. */
  total: number;
  embedded: number;
  reused: number;
  renamed: number;
  deleted: number;
  failed: number;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Brings the corpus into agreement with the vault.
 *
 * Membership comes from `scan` alone — reconcile applies no exclusion rule of
 * its own. `mtime` + `size` are a cheap pre-check, `content_hash` is the truth,
 * and a hash matching a shard whose path has vanished identifies a rename. A
 * rename re-embeds rather than reusing vectors: both embed-text formulas carry
 * path breadcrumbs, so a vector is a function of (path, content, strategy) and
 * reusing one would leave the old path inside it (design D9). That is what makes
 * an incrementally maintained corpus identical to a from-scratch index.
 *
 * A failure to read, embed or store one note is contained: it is counted,
 * warned about, leaves that note's previous shard untouched, and never aborts
 * the run.
 */
export async function reconcileCorpus(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const { vaultRoot, scan, stat, readNote, embed, store } = deps;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  // Before any I/O. The setup below — a manifest write, a full scan, a full
  // shard listing — is itself seconds of disk work on a large corpus, and a
  // pass kicked off just as the client hung up would otherwise run all of it
  // before reaching the first per-note check.
  if (opts.signal?.aborted) {
    return { total: 0, embedded: 0, reused: 0, renamed: 0, deleted: 0, failed: 0 };
  }

  // First, so an incompatible corpus identity discards the shards before they
  // are read: the shard map below must not see vectors of unknown provenance.
  await store.ensureManifest({
    embed_version: EMBED_VERSION,
    model_key: MODEL_KEY,
    model_id: MODEL_ID,
    dims: MODEL_DIMS,
    strategy: SC_PARITY_STRATEGY,
  });

  const paths = await scan();
  // Retain only the metadata the loop reads — the vectors of a whole corpus
  // would otherwise sit in memory for the run. The rare metadata-rewrite path
  // re-reads its one shard lazily.
  const shards = new Map<string, { mtime: number; size: number; content_hash: string }>();
  for (const [shardPath, shard] of await store.listShards()) {
    shards.set(shardPath, {
      mtime: shard.mtime,
      size: shard.size,
      content_hash: shard.content_hash,
    });
  }
  const inScope = new Set(paths);

  // Shards whose note is no longer in scope: deletion candidates, and the only
  // place a rename can be recognised from.
  const orphans = new Set<string>();
  const orphansByHash = new Map<string, string[]>();
  for (const [shardPath, shard] of shards) {
    if (inScope.has(shardPath)) continue;
    orphans.add(shardPath);
    const sameHash = orphansByHash.get(shard.content_hash);
    if (sameHash) sameHash.push(shardPath);
    else orphansByHash.set(shard.content_hash, [shardPath]);
  }

  const summary: ReconcileSummary = {
    total: paths.length,
    embedded: 0,
    reused: 0,
    renamed: 0,
    deleted: 0,
    failed: 0,
  };

  let indexed = 0;
  for (const notePath of paths) {
    // Checked per note, not per embed: one note's work is the granularity a
    // shutdown waits out, and stopping mid-note would leave its shard unwritten
    // anyway (the next pass re-embeds it).
    if (opts.signal?.aborted) break;
    try {
      const shard = shards.get(notePath) ?? null;

      if (shard) {
        const meta = await stat(notePath);
        if (meta.mtime === shard.mtime && meta.size === shard.size) {
          summary.reused += 1;
          continue;
        }
        const note = await readNote(notePath);
        const hash = contentHash(note.content);
        if (hash === shard.content_hash) {
          // Same bytes, new metadata: rewrite the shard, keep the vectors. The
          // listing kept metadata only, so fetch the full shard lazily; a shard
          // that vanished meanwhile falls through to a re-embed.
          const full = await store.readShard(notePath);
          if (full !== null) {
            await store.writeShard({ ...full, mtime: note.mtime, size: note.size });
            summary.reused += 1;
            continue;
          }
        }
        await embedNote(notePath, note, hash, embed, store);
        summary.embedded += 1;
        continue;
      }

      const note = await readNote(notePath);
      const hash = contentHash(note.content);
      // Claiming removes the orphan from the deletion sweep before the embed,
      // so a failed embed preserves the old shard for the next pass's retry —
      // a failure must leave the note's previous shard untouched.
      const renamedFrom = takeOrphanWithHash(orphansByHash, hash);
      if (renamedFrom !== null) orphans.delete(renamedFrom);
      await embedNote(notePath, note, hash, embed, store);
      if (renamedFrom !== null) {
        summary.renamed += 1;
        // The rename already succeeded; a failed unlink of the old shard must
        // not recount it as a failed index. The stale shard is swept as an
        // orphan on the next pass.
        try {
          await store.deleteShard(renamedFrom);
        } catch (err) {
          summary.failed += 1;
          warn(
            `neuro-vault corpus: failed to delete the shard of "${renamedFrom}" in vault ${vaultRoot}: ${String(err)}`,
          );
        }
      } else {
        summary.embedded += 1;
      }
    } catch (err) {
      // The note keeps whatever shard it already had; the next pass retries it.
      summary.failed += 1;
      warn(
        `neuro-vault corpus: failed to index "${notePath}" in vault ${vaultRoot}: ${String(err)}`,
      );
    } finally {
      indexed += 1;
      // Guarded: a throw here would escape the catch above and abort the run.
      try {
        opts.onProgress?.({ indexed, total: summary.total });
      } catch (err) {
        warn(`neuro-vault corpus: onProgress callback threw: ${String(err)}`);
      }
    }
  }

  // The sweep and the gitignore write below are corpus maintenance, not part of
  // the partial result an aborted run hands back — skip them so a shutdown is
  // bounded by the note in flight and nothing more.
  if (opts.signal?.aborted) return summary;

  for (const orphanPath of orphans) {
    // Per orphan, not just before the loop: a vault that dropped a whole folder
    // from its scope sweeps thousands of shards here, and an abort arriving
    // mid-sweep must stop it too. A shard left behind stays an orphan and is
    // swept by the next pass.
    if (opts.signal?.aborted) return summary;
    try {
      await store.deleteShard(orphanPath);
      summary.deleted += 1;
    } catch (err) {
      summary.failed += 1;
      warn(
        `neuro-vault corpus: failed to delete the shard of "${orphanPath}" in vault ${vaultRoot}: ${String(err)}`,
      );
    }
  }

  await ensureCorpusGitignored(vaultRoot, { warn });

  return summary;
}

/** Claims one orphan shard carrying `hash`, if any — the note moved there. */
function takeOrphanWithHash(orphansByHash: Map<string, string[]>, hash: string): string | null {
  const candidates = orphansByHash.get(hash);
  if (!candidates || candidates.length === 0) return null;
  const claimed = candidates.shift() ?? null;
  if (candidates.length === 0) orphansByHash.delete(hash);
  return claimed;
}

/** Embeds one note's inputs and writes its shard. Throws on the first failure — the caller contains it. */
async function embedNote(
  notePath: string,
  note: NoteContent,
  hash: string,
  embed: EmbedFn,
  store: CorpusStore,
): Promise<void> {
  const inputs = buildEmbedInputs(notePath, note.content);

  const embedding = inputs.note === null ? null : encodeVector(await embed(inputs.note));

  const blocks: CorpusBlock[] = [];
  for (const block of inputs.blocks) {
    blocks.push({
      key: block.key,
      heading: block.heading,
      lines: block.lines,
      embedding: encodeVector(await embed(block.embedText)),
    });
  }

  const shard: CorpusShard = {
    path: notePath,
    content_hash: hash,
    mtime: note.mtime,
    size: note.size,
    embedding,
    blocks,
  };
  await store.writeShard(shard);
}
