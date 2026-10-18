import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { splitFrontmatter } from '../frontmatter.js';
import type { VaultReader } from '../vault-reader.js';
import { parseNote, type ParsedNote } from './blocks.js';
import { rankNotes, type RankedNote } from './rank.js';

type StatFn = (absPath: string) => Promise<{ mtimeMs: number }>;
type ReadFn = (absPath: string) => Promise<string>;

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedNote;
}

/** What one refresh hands its callers: the scan it ran over and the notes it saw. */
interface RefreshResult {
  paths: string[];
  notes: Map<string, ParsedNote>;
}

export interface ILexicalIndexInfo {
  warmed: boolean;
  notes: number;
  lastRefresh?: { at: Date; parsed: number; ms: number };
}

/**
 * Per-vault lexical index over Obsidian markdown notes (title/heading/body).
 *
 * Freshness model: every {@link search} call is served by a refresh that began
 * after it arrived. A refresh re-scans the vault via the injected
 * {@link VaultReader}, stats every scanned file, and re-parses only the files
 * whose mtime changed. Notes the scan no longer lists are dropped from the
 * cache. This is a read-through cache over the filesystem, not a persisted
 * index — it never touches the embedding corpus.
 *
 * Refreshes never overlap (the index may be shared by many sessions): a call
 * that finds one running waits for it, then shares one follow-up refresh with
 * every other call that arrived during the same run, so a burst costs at most
 * two refreshes. `allowed` narrows the ranked candidates after the refresh and
 * evicts nothing.
 */
export class LexicalIndex {
  private readonly vaultRoot: string;
  private readonly reader: VaultReader;
  private readonly stat: StatFn;
  private readonly readFile: ReadFn;
  private readonly warn: (message: string) => void;
  private readonly cache = new Map<string, CacheEntry>();
  private running: Promise<RefreshResult> | null = null;
  private queued: Promise<RefreshResult> | null = null;
  private lastRefresh: { at: Date; parsed: number; ms: number } | undefined;

  constructor(opts: {
    vaultRoot: string;
    reader: VaultReader;
    stat?: StatFn;
    readFile?: ReadFn;
    warn?: (message: string) => void;
  }) {
    this.vaultRoot = opts.vaultRoot;
    this.reader = opts.reader;
    this.stat = opts.stat ?? ((p) => fsStat(p));
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.warn = opts.warn ?? ((message) => console.error(message));
  }

  async search(opts: {
    queries: string[];
    allowed?: ReadonlySet<string>;
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): Promise<{
    notes: RankedNote[];
    truncated: boolean;
    perQueryCounts: Record<string, number>;
    perQueryTokenCounts: Record<string, Record<string, number>>;
    totalNotes: number;
  }> {
    const { paths, notes: seen } = await this.refresh();

    const notes = new Map<string, ParsedNote>();
    for (const p of paths) {
      if (opts.allowed && !opts.allowed.has(p)) continue;
      const parsed = seen.get(p);
      if (parsed) notes.set(p, parsed);
    }

    const ranked = rankNotes({
      notes,
      queries: opts.queries,
      noteCap: opts.noteCap,
      perNoteCap: opts.perNoteCap,
      getBacklinkCount: opts.getBacklinkCount,
    });
    return { ...ranked, totalNotes: paths.length };
  }

  /** One refresh through the serialising rule; never rejects (a failure goes to `warn`). */
  async warm(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.warn(`lexical index warm failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  info(): ILexicalIndexInfo {
    return {
      warmed: this.lastRefresh !== undefined,
      notes: this.cache.size,
      ...(this.lastRefresh ? { lastRefresh: this.lastRefresh } : {}),
    };
  }

  /**
   * The serialising rule. Nothing running: start a refresh. One running: join
   * the single queued follow-up (creating it if this is the first arrival), so
   * the caller is served by a refresh that starts after it arrived.
   */
  private refresh(): Promise<RefreshResult> {
    if (this.queued) return this.queued;
    if (!this.running) return this.start();
    const queued: Promise<RefreshResult> = this.running
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.start();
      });
    this.queued = queued;
    return queued;
  }

  private start(): Promise<RefreshResult> {
    const run: Promise<RefreshResult> = this.runRefresh().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runRefresh(): Promise<RefreshResult> {
    const startedAt = Date.now();
    const paths = await this.reader.scan();

    // Drop cache entries for notes the scan no longer lists (deletions and
    // scope changes). `allowed` is never applied here.
    const live = new Set(paths);
    for (const cached of this.cache.keys()) {
      if (!live.has(cached)) this.cache.delete(cached);
    }

    const stats = await Promise.all(
      paths.map(async (p) => {
        try {
          return [p, (await this.stat(path.join(this.vaultRoot, p))).mtimeMs] as const;
        } catch {
          return [p, null] as const; // vanished between scan and stat
        }
      }),
    );

    let parsedCount = 0;
    await Promise.all(
      stats.map(async ([p, mtimeMs]) => {
        if (mtimeMs === null) {
          this.cache.delete(p);
          return;
        }
        if (this.cache.get(p)?.mtimeMs === mtimeMs) return;

        try {
          const raw = await this.readFile(path.join(this.vaultRoot, p));
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
          parsedCount++;
        } catch {
          // vanished between stat and read
          this.cache.delete(p);
        }
      }),
    );

    // Snapshot for the callers this refresh serves: a later refresh may mutate
    // the cache before they resume.
    const notes = new Map<string, ParsedNote>();
    for (const p of paths) {
      const entry = this.cache.get(p);
      if (entry) notes.set(p, entry.parsed);
    }
    this.lastRefresh = { at: new Date(startedAt), parsed: parsedCount, ms: Date.now() - startedAt };
    return { paths, notes };
  }
}
