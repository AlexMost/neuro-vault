import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';

import { applyReplace, splitRawFrontmatter } from './in-place-edit.js';
import { ToolHandlerError } from '../tool-response.js';

export interface ReplaceInNoteInput {
  path: string; // vault-relative POSIX path
  find: string;
  content: string;
  replaceAll: boolean;
}

export interface ReplaceFullBodyInput {
  path: string;
  content: string;
}

export interface VaultWriter {
  replaceInNote(input: ReplaceInNoteInput): Promise<void>;
  replaceFullBody(input: ReplaceFullBodyInput): Promise<void>;
}

export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;
export type FsWriteFile = (absPath: string, data: string, encoding: 'utf8') => Promise<void>;

export interface FsVaultWriterOptions {
  vaultRoot: string;
  readFile?: FsReadFile;
  writeFile?: FsWriteFile;
}

export class FsVaultWriter implements VaultWriter {
  private readonly vaultRoot: string;
  private readonly readFile: FsReadFile;
  private readonly writeFile: FsWriteFile;

  constructor(opts: FsVaultWriterOptions) {
    this.vaultRoot = opts.vaultRoot;
    this.readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
    this.writeFile = opts.writeFile ?? ((p, d, enc) => fsWriteFile(p, d, enc));
  }

  async replaceInNote(input: ReplaceInNoteInput): Promise<void> {
    const absPath = path.join(this.vaultRoot, input.path);
    const raw = await this.readRaw(absPath, input.path);
    const { prefix, body } = splitRawFrontmatter(raw);

    const result = applyReplace(body, input.find, input.content, input.replaceAll);
    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        throw new ToolHandlerError('NOT_FOUND', `Find text not present in body of ${input.path}`, {
          details: { path: input.path },
        });
      }
      throw new ToolHandlerError(
        'AMBIGUOUS_MATCH',
        `Find text matched ${result.lines.length} times in ${input.path}; pass replace_all=true or use a more specific anchor`,
        { details: { path: input.path, matches: result.lines } },
      );
    }

    await this.writeFile(absPath, prefix + result.body, 'utf8');
  }

  async replaceFullBody(input: ReplaceFullBodyInput): Promise<void> {
    const absPath = path.join(this.vaultRoot, input.path);
    const raw = await this.readRaw(absPath, input.path);
    const { prefix } = splitRawFrontmatter(raw);
    await this.writeFile(absPath, prefix + input.content, 'utf8');
  }

  private async readRaw(absPath: string, vaultRelativePath: string): Promise<string> {
    try {
      return await this.readFile(absPath, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new ToolHandlerError('NOT_FOUND', `Note not found: ${vaultRelativePath}`, {
          details: { path: vaultRelativePath },
          cause: err,
        });
      }
      throw new ToolHandlerError(
        'READ_FAILED',
        `Failed to read ${vaultRelativePath}: ${(err as Error).message}`,
        { details: { path: vaultRelativePath }, cause: err },
      );
    }
  }
}
