import { createHash } from 'node:crypto';
import {
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  unlink as fsUnlink,
} from 'node:fs/promises';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { MODEL_DIMS } from './types.js';
import type { CorpusBlock, CorpusManifest, CorpusShard } from './types.js';

/** Corpus root, relative to the vault root. */
export const CORPUS_DIR = '.neuro-vault/corpus';

/**
 * Max shard files held open at once during a cold load. An unbounded fan-out
 * holds every file open together, and under a capped hard fd limit (containers,
 * systemd LimitNOFILE) the resulting EMFILEs would read the corpus as empty.
 */
const SHARD_READ_CONCURRENCY = 64;

export interface CorpusStoreDeps {
  /** Defaults to write-file-atomic (temp + rename). */
  writeFile?: (p: string, data: string) => Promise<void>;
  readFile?: (p: string) => Promise<string>;
  readdir?: (p: string) => Promise<string[]>;
  unlink?: (p: string) => Promise<void>;
  mkdir?: (p: string) => Promise<void>;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
  /** Expected vector dimension, used to validate a shard's vectors. Defaults to MODEL_DIMS. */
  dims?: number;
}

/** Reads, writes, lists, and deletes per-note shards under `<vaultRoot>/.neuro-vault/corpus/notes/`. */
export class CorpusStore {
  private readonly corpusRoot: string;
  private readonly notesDir: string;
  private readonly manifestFile: string;
  private readonly dims: number;
  private readonly writeFile: (p: string, data: string) => Promise<void>;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly readdir: (p: string) => Promise<string[]>;
  private readonly unlink: (p: string) => Promise<void>;
  private readonly mkdir: (p: string) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(vaultRoot: string, deps: CorpusStoreDeps = {}) {
    const root = path.join(vaultRoot, CORPUS_DIR);
    this.corpusRoot = root;
    this.notesDir = path.join(root, 'notes');
    this.manifestFile = path.join(root, 'manifest.json');
    this.dims = deps.dims ?? MODEL_DIMS;
    this.writeFile = deps.writeFile ?? ((p, data) => writeFileAtomic(p, data));
    this.readFile = deps.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.readdir = deps.readdir ?? ((p) => fsReaddir(p));
    this.unlink = deps.unlink ?? ((p) => fsUnlink(p));
    this.mkdir = deps.mkdir ?? ((p) => fsMkdir(p, { recursive: true }).then(() => undefined));
    this.warn = deps.warn ?? ((message) => console.error(message));
  }

  /** Shard filename for a note path: sha256(path) truncated to 32 hex chars, `.json`. */
  static shardFileName(notePath: string): string {
    return `${createHash('sha256').update(notePath).digest('hex').slice(0, 32)}.json`;
  }

  async writeShard(shard: CorpusShard): Promise<void> {
    this.assertShardVectors(shard);
    await this.mkdir(this.notesDir);
    await this.writeFile(
      path.join(this.notesDir, CorpusStore.shardFileName(shard.path)),
      `${JSON.stringify(shard)}\n`,
    );
  }

  async readShard(notePath: string): Promise<CorpusShard | null> {
    const file = path.join(this.notesDir, CorpusStore.shardFileName(notePath));
    return this.readShardFile(file);
  }

  async deleteShard(notePath: string): Promise<void> {
    const file = path.join(this.notesDir, CorpusStore.shardFileName(notePath));
    try {
      await this.unlink(file);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  async listShards(): Promise<Map<string, CorpusShard>> {
    const result = new Map<string, CorpusShard>();
    let entries: string[];
    try {
      entries = await this.readdir(this.notesDir);
    } catch (err) {
      if (isEnoent(err)) return result;
      throw err;
    }
    // A cold load is I/O-bound, so the files are read concurrently (design D4's
    // 68 ms at 2 500 shards), bounded by SHARD_READ_CONCURRENCY. Sorted first so
    // two files claiming the same note path resolve to the same winner every run.
    const files = entries.filter((entry) => entry.endsWith('.json')).sort();
    const shards: Array<CorpusShard | null> = new Array<CorpusShard | null>(files.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const i = nextIndex;
        nextIndex += 1;
        shards[i] = await this.readShardFile(path.join(this.notesDir, files[i]));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SHARD_READ_CONCURRENCY, files.length) }, () => worker()),
    );
    for (const shard of shards) {
      if (shard) result.set(shard.path, shard);
    }
    return result;
  }

  async readManifest(): Promise<CorpusManifest | null> {
    let raw: string;
    try {
      raw = await this.readFile(this.manifestFile);
    } catch (err) {
      if (isEnoent(err)) return null;
      this.warn(`neuro-vault corpus: failed to read manifest ${this.manifestFile}: ${String(err)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.warn(
        `neuro-vault corpus: manifest ${this.manifestFile} is not valid JSON: ${String(err)}`,
      );
      return null;
    }

    if (!isValidManifest(parsed)) {
      this.warn(`neuro-vault corpus: manifest ${this.manifestFile} failed validation`);
      return null;
    }

    return parsed;
  }

  async writeManifest(manifest: CorpusManifest): Promise<void> {
    await this.mkdir(this.corpusRoot);
    await this.writeFile(this.manifestFile, `${JSON.stringify(manifest)}\n`);
  }

  /** Deletes every shard file, regardless of whether it parses or validates. */
  async clearShards(): Promise<void> {
    let entries: string[];
    try {
      entries = await this.readdir(this.notesDir);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          try {
            await this.unlink(path.join(this.notesDir, entry));
          } catch (err) {
            if (isEnoent(err)) return;
            throw err;
          }
        }),
    );
  }

  /**
   * Compares the stored manifest against the caller's expected corpus
   * identity and rebuilds (discards every shard, writes a fresh manifest)
   * on any mismatch. Writes nothing when the stored manifest already
   * matches. Called first by reconcile.
   *
   * A fresh corpus (no manifest, no shards) is not a mismatch, but the manifest
   * is still written: leaving it absent would make the very next pass read
   * "no manifest + shards present" as incompatible and discard the whole first
   * index. Shards are only cleared when there are shards to clear.
   */
  async ensureManifest(expected: Omit<CorpusManifest, 'created'>): Promise<{ rebuilt: boolean }> {
    const stored = await this.readManifest();
    const hasShards = await this.hasAnyShards();
    const compatible = isManifestCompatible(stored, expected, hasShards);
    if (compatible && stored !== null) return { rebuilt: false };
    if (!compatible && hasShards) await this.clearShards();
    await this.writeManifest({ ...expected, created: new Date().toISOString() });
    return { rebuilt: !compatible };
  }

  private async hasAnyShards(): Promise<boolean> {
    try {
      const entries = await this.readdir(this.notesDir);
      return entries.some((entry) => entry.endsWith('.json'));
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /**
   * Reads and validates a shard file. Any failure to read, parse, or validate
   * it — including an I/O or permission error, not just the spec-named
   * corruption cases (parse failure, schema failure, a `path` that doesn't
   * hash back to the filename it was found under, or a vector whose base64
   * byte length disagrees with `dims * 4`) — reads as `null` rather than
   * throwing, and emits a warning. The note is simply re-embedded on the next
   * pass: no corpus or filesystem problem is fatal to the process.
   */
  private async readShardFile(file: string): Promise<CorpusShard | null> {
    let raw: string;
    try {
      raw = await this.readFile(file);
    } catch (err) {
      if (isEnoent(err)) return null;
      this.warn(`neuro-vault corpus: failed to read shard ${file}: ${String(err)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.warn(`neuro-vault corpus: shard ${file} is not valid JSON: ${String(err)}`);
      return null;
    }

    if (!this.isValidShard(parsed)) {
      this.warn(`neuro-vault corpus: shard ${file} failed validation`);
      return null;
    }

    if (CorpusStore.shardFileName(parsed.path) !== path.basename(file)) {
      this.warn(
        `neuro-vault corpus: shard ${file} path "${parsed.path}" does not hash to its filename`,
      );
      return null;
    }

    return parsed;
  }

  private isValidShard(value: unknown): value is CorpusShard {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (typeof v.path !== 'string') return false;
    if (typeof v.content_hash !== 'string') return false;
    if (typeof v.mtime !== 'number') return false;
    if (typeof v.size !== 'number') return false;
    if (v.embedding !== null && !this.isValidVector(v.embedding)) return false;
    if (!Array.isArray(v.blocks)) return false;
    return v.blocks.every((block) => this.isValidBlock(block));
  }

  private isValidBlock(value: unknown): value is CorpusBlock {
    if (typeof value !== 'object' || value === null) return false;
    const b = value as Record<string, unknown>;
    if (typeof b.key !== 'string') return false;
    if (typeof b.heading !== 'string') return false;
    if (
      !Array.isArray(b.lines) ||
      b.lines.length !== 2 ||
      typeof b.lines[0] !== 'number' ||
      typeof b.lines[1] !== 'number'
    ) {
      return false;
    }
    return this.isValidVector(b.embedding);
  }

  /** Validates by base64 byte length (`dims * 4`), never by decoding into floats. */
  private isValidVector(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    return Buffer.from(value, 'base64').length === this.dims * 4;
  }

  /**
   * Rejects a shard carrying a vector of the wrong dimension. Unlike a corrupt
   * shard on disk — which reads as a missing shard so the note is simply
   * re-embedded — this is a programming or configuration error: the manifest
   * gate cannot catch it (`expected.dims` comes from the same constant), so a
   * mismatched vector would be written, read back as `null`, and re-embedded on
   * every pass forever. It throws; reconcile contains per-note failures.
   */
  private assertShardVectors(shard: CorpusShard): void {
    const reject = (what: string, value: unknown): never => {
      throw new Error(
        `neuro-vault corpus: refusing to write shard "${shard.path}": ${what} is ` +
          `${describeVector(value)}, expected ${this.dims} dims`,
      );
    };
    if (shard.embedding !== null && !this.isValidVector(shard.embedding)) {
      reject('the note vector', shard.embedding);
    }
    for (const block of shard.blocks) {
      if (!this.isValidVector(block.embedding)) {
        reject(`the vector for block "${block.key}"`, block.embedding);
      }
    }
  }
}

/** Renders a vector's float32 length for an error message. */
function describeVector(value: unknown): string {
  if (typeof value !== 'string') return `not a string (${typeof value})`;
  const bytes = Buffer.from(value, 'base64').length;
  return bytes % 4 === 0 ? `${bytes / 4} dims` : `${bytes} bytes`;
}

/**
 * Whether `stored` matches `expected` on every corpus-identity field. A
 * missing manifest is compatible only when the corpus has no shards to lose
 * (a fresh corpus); once shards exist, a missing or unparsable manifest is
 * treated as incompatible so the corpus rebuilds rather than trusting
 * vectors of unknown provenance.
 */
export function isManifestCompatible(
  stored: CorpusManifest | null,
  expected: Omit<CorpusManifest, 'created'>,
  hasShards: boolean,
): boolean {
  if (stored === null) return !hasShards;
  return (
    stored.embed_version === expected.embed_version &&
    stored.model_key === expected.model_key &&
    stored.model_id === expected.model_id &&
    stored.dims === expected.dims &&
    stored.strategy === expected.strategy
  );
}

function isValidManifest(value: unknown): value is CorpusManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.embed_version === 'number' &&
    typeof v.model_key === 'string' &&
    typeof v.model_id === 'string' &&
    typeof v.dims === 'number' &&
    typeof v.strategy === 'string' &&
    typeof v.created === 'string'
  );
}

/** Literal `.gitignore` lines (trimmed) that already cover the corpus directory. */
const GITIGNORE_COVERING_LINES = new Set([
  '.neuro-vault/corpus/',
  '.neuro-vault/corpus',
  '/.neuro-vault/corpus/',
  '.neuro-vault/',
  '.neuro-vault',
]);

export interface EnsureCorpusGitignoredDeps {
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, data: string) => Promise<void>;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

/**
 * Appends a single `.neuro-vault/corpus/` line to `<vaultRoot>/.gitignore` so
 * a vault owner does not accidentally commit the embedding corpus. Never
 * creates a `.gitignore` that doesn't exist, never rewrites any other line,
 * and never ignores `.neuro-vault/` as a whole (a committed eval golden set
 * lives elsewhere under that directory). A failure to update the file is
 * reported via `warn` and never throws — this is a best-effort convenience,
 * not something indexing should fail over.
 */
export async function ensureCorpusGitignored(
  vaultRoot: string,
  deps: EnsureCorpusGitignoredDeps = {},
): Promise<void> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p: string, data: string) => writeFileAtomic(p, data));
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const gitignoreFile = path.join(vaultRoot, '.gitignore');

  let existing: string;
  try {
    existing = await readFile(gitignoreFile);
  } catch (err) {
    if (isEnoent(err)) return;
    warn(
      `neuro-vault corpus: failed to read ${gitignoreFile} in vault ${vaultRoot}: ${String(err)}`,
    );
    return;
  }

  try {
    const alreadyCovered = existing
      .split('\n')
      .some((line) => GITIGNORE_COVERING_LINES.has(line.trim()));
    if (alreadyCovered) return;

    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await writeFile(gitignoreFile, `${existing}${separator}${CORPUS_DIR}/\n`);
  } catch (err) {
    warn(`neuro-vault corpus: failed to update .gitignore in vault ${vaultRoot}: ${String(err)}`);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
