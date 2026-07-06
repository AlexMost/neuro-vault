import { readFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { splitFrontmatter } from '../frontmatter.js';
import type { VaultReader } from '../vault-reader.js';
import { parseNote, type ParsedNote } from './blocks.js';
import { rankNotes, type RankedNote } from './rank.js';

type StatFn = (absPath: string) => Promise<{ mtimeMs: number }>;

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedNote;
}

/**
 * Per-vault lexical index over Obsidian markdown notes (title/heading/body).
 *
 * Freshness model: every {@link search} call re-scans the vault via the
 * injected {@link VaultReader}, stats every scoped file, and re-parses only
 * the files whose mtime changed since the last call. Vanished files are
 * dropped from the cache and from the result set. This is a read-through
 * cache over the filesystem, not a persisted index — it never touches the
 * Smart Connections embedding corpus.
 */
export class LexicalIndex {
  private readonly vaultRoot: string;
  private readonly reader: VaultReader;
  private readonly stat: StatFn;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: StatFn }) {
    this.vaultRoot = opts.vaultRoot;
    this.reader = opts.reader;
    this.stat = opts.stat ?? ((p) => fsStat(p));
  }

  async search(opts: {
    queries: string[];
    allowed?: Set<string>;
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): Promise<{ notes: RankedNote[]; truncated: boolean }> {
    const paths = await this.reader.scan();
    const scoped = opts.allowed ? paths.filter((p) => opts.allowed!.has(p)) : paths;

    await this.refresh(scoped);

    const notes = new Map<string, ParsedNote>();
    for (const p of scoped) {
      const entry = this.cache.get(p);
      if (entry) notes.set(p, entry.parsed);
    }

    return rankNotes({
      notes,
      queries: opts.queries,
      noteCap: opts.noteCap,
      perNoteCap: opts.perNoteCap,
      getBacklinkCount: opts.getBacklinkCount,
    });
  }

  private async refresh(scopedPaths: string[]): Promise<void> {
    // Drop cache entries for notes no longer within scope (covers deletions
    // and, for a scoped call, notes that fell outside the `allowed` set).
    const live = new Set(scopedPaths);
    for (const cached of this.cache.keys()) {
      if (!live.has(cached)) this.cache.delete(cached);
    }

    const stats = await Promise.all(
      scopedPaths.map(async (p) => {
        try {
          return [p, (await this.stat(path.join(this.vaultRoot, p))).mtimeMs] as const;
        } catch {
          return [p, null] as const; // vanished between scan and stat
        }
      }),
    );

    await Promise.all(
      stats.map(async ([p, mtimeMs]) => {
        if (mtimeMs === null) {
          this.cache.delete(p);
          return;
        }
        if (this.cache.get(p)?.mtimeMs === mtimeMs) return;

        try {
          const raw = await readFile(path.join(this.vaultRoot, p), 'utf8');
          const { content } = splitFrontmatter(raw);
          // The reader strips frontmatter from `content`, but unit `lines`
          // must stay file-relative. Recover the offset from how much of the
          // raw file precedes `content` (the frontmatter fence, if any).
          const prefixLength = raw.length - content.length;
          const lineOffset =
            prefixLength > 0 ? raw.slice(0, prefixLength).split('\n').length - 1 : 0;
          this.cache.set(p, {
            mtimeMs,
            parsed: parseNote({ path: p, body: content, lineOffset }),
          });
        } catch {
          // vanished between stat and read
          this.cache.delete(p);
        }
      }),
    );
  }
}
