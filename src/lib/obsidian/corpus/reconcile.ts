import { createHash } from 'node:crypto';

import { buildEmbedInputs } from './embed-text.js';
import { CorpusStore, ensureCorpusGitignored } from './shard-store.js';
import {
  EMBED_VERSION,
  MODEL_DIMS,
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

  // First, so an incompatible corpus identity discards the shards before they
  // are read: the shard map below must not see vectors of unknown provenance.
  await store.ensureManifest({
    embed_version: EMBED_VERSION,
    model_key: MODEL_KEY,
    dims: MODEL_DIMS,
    strategy: SC_PARITY_STRATEGY,
  });

  const paths = await scan();
  const shards = await store.listShards();
  const inScope = new Set(paths);

  // Shards whose note is no longer in scope: deletion candidates, and the only
  // place a rename can be recognised from.
  const orphans = new Map<string, string>();
  const orphansByHash = new Map<string, string[]>();
  for (const [shardPath, shard] of shards) {
    if (inScope.has(shardPath)) continue;
    orphans.set(shardPath, shard.content_hash);
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
          // Same bytes, new metadata: rewrite the shard, keep the vectors.
          await store.writeShard({ ...shard, mtime: note.mtime, size: note.size });
          summary.reused += 1;
          continue;
        }
        await embedNote(notePath, note, hash, embed, store);
        summary.embedded += 1;
        continue;
      }

      const note = await readNote(notePath);
      const hash = contentHash(note.content);
      const renamedFrom = takeOrphanWithHash(orphansByHash, hash);
      await embedNote(notePath, note, hash, embed, store);
      if (renamedFrom !== null) {
        orphans.delete(renamedFrom);
        await store.deleteShard(renamedFrom);
        summary.renamed += 1;
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
      opts.onProgress?.({ indexed, total: summary.total });
    }
  }

  for (const orphanPath of orphans.keys()) {
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
