import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import fastGlob from 'fast-glob';

import { splitFrontmatter } from './frontmatter.js';
import { normalizeScanPrefix, toPosixSlashes } from './paths.js';

export type ReadNotesField = 'frontmatter' | 'content';

export interface ReadNotesItemSuccess {
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
}

export interface ReadNotesItemError {
  path: string;
  error: {
    code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'READ_FAILED';
    message: string;
  };
}

export type ReadNotesItem = ReadNotesItemSuccess | ReadNotesItemError;

export interface ReadNotesInput {
  paths: string[];
  fields: ReadNotesField[];
}

export interface ScanOptions {
  pathPrefix?: string;
}

export class ScanPathNotFoundError extends Error {
  readonly code = 'PATH_NOT_FOUND' as const;
  constructor(prefix: string) {
    super(`path_prefix not found: ${prefix}`);
    this.name = 'ScanPathNotFoundError';
  }
}

export interface VaultReader {
  readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]>;
  scan(opts?: ScanOptions): Promise<string[]>;
}

export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;
export type FsStat = (absPath: string) => Promise<{ isDirectory(): boolean }>;
export type FsGlob = (
  pattern: string,
  options: { cwd: string; onlyFiles: boolean; dot: boolean; followSymbolicLinks: boolean },
) => Promise<string[]>;

export interface FsVaultReaderOptions {
  vaultRoot: string;
  readFile?: FsReadFile;
  stat?: FsStat;
  glob?: FsGlob;
}

export class FsVaultReader implements VaultReader {
  private readonly vaultRoot: string;
  private readonly readFile: FsReadFile;
  private readonly stat: FsStat;
  private readonly glob: FsGlob;

  constructor(opts: FsVaultReaderOptions) {
    this.vaultRoot = opts.vaultRoot;
    this.readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
    this.stat = opts.stat ?? ((p) => fsStat(p));
    this.glob =
      opts.glob ?? ((pattern, options) => fastGlob(pattern, { ...options }) as Promise<string[]>);
  }

  async readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]> {
    return Promise.all(input.paths.map((p) => this.readOne(p)));
  }

  async scan(opts: ScanOptions = {}): Promise<string[]> {
    const prefix = normalizeScanPrefix(opts.pathPrefix);

    if (prefix) {
      const absPrefix = path.join(this.vaultRoot, prefix);
      try {
        const stats = await this.stat(absPrefix);
        if (!stats.isDirectory()) {
          throw new ScanPathNotFoundError(prefix);
        }
      } catch (err) {
        if (err instanceof ScanPathNotFoundError) throw err;
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new ScanPathNotFoundError(prefix);
        }
        throw err;
      }
    }

    const cwd = prefix ? path.join(this.vaultRoot, prefix) : this.vaultRoot;
    const matches = await this.glob('**/*.md', {
      cwd,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
    if (!prefix) {
      return matches.map(toPosixSlashes).sort();
    }
    return matches.map((m) => `${prefix}/${toPosixSlashes(m)}`).sort();
  }

  private async readOne(vaultRelativePath: string): Promise<ReadNotesItem> {
    const absPath = path.join(this.vaultRoot, vaultRelativePath);
    let raw: string;
    try {
      raw = await this.readFile(absPath, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          path: vaultRelativePath,
          error: {
            code: 'NOT_FOUND',
            message: `Note not found: ${vaultRelativePath}`,
          },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: vaultRelativePath,
        error: {
          code: 'READ_FAILED',
          message: `Failed to read ${vaultRelativePath}: ${message}`,
        },
      };
    }
    const { frontmatter, content } = splitFrontmatter(raw);
    return { path: vaultRelativePath, frontmatter, content };
  }
}
