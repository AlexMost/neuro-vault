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
import type { CorpusBlock, CorpusShard } from './types.js';

/** Corpus root, relative to the vault root. */
export const CORPUS_DIR = '.neuro-vault/corpus';

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
  private readonly notesDir: string;
  private readonly dims: number;
  private readonly writeFile: (p: string, data: string) => Promise<void>;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly readdir: (p: string) => Promise<string[]>;
  private readonly unlink: (p: string) => Promise<void>;
  private readonly mkdir: (p: string) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(vaultRoot: string, deps: CorpusStoreDeps = {}) {
    const root = path.join(vaultRoot, CORPUS_DIR);
    this.notesDir = path.join(root, 'notes');
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
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const shard = await this.readShardFile(path.join(this.notesDir, entry));
      if (shard) result.set(shard.path, shard);
    }
    return result;
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
    let byteLength: number;
    try {
      byteLength = Buffer.from(value, 'base64').length;
    } catch {
      return false;
    }
    return byteLength === this.dims * 4;
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
