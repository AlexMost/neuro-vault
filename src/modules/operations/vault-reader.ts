import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { splitFrontmatter } from './frontmatter.js';

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

export interface VaultReader {
  readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]>;
}

export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;

export interface FsVaultReaderOptions {
  vaultRoot: string;
  readFile?: FsReadFile;
}

export class FsVaultReader implements VaultReader {
  private readonly vaultRoot: string;
  private readonly readFile: FsReadFile;

  constructor(opts: FsVaultReaderOptions) {
    this.vaultRoot = opts.vaultRoot;
    this.readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
  }

  async readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]> {
    return Promise.all(input.paths.map((p) => this.readOne(p)));
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
