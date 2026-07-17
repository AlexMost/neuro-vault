import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readDailyNotesConfig } from '../../lib/obsidian/daily-notes-config.js';
import { formatDailyDate } from '../../lib/obsidian/daily-note-path.js';
import { splitFrontmatter } from '../../lib/obsidian/frontmatter.js';
import { normalizeNotePath } from '../../lib/obsidian/note-path.js';
import { extractTags } from '../../lib/obsidian/query/note-record.js';
import type {
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  PropertyListEntry,
  RemovePropertyInput,
  SetPropertyInput,
  TagListEntry,
  VaultProvider,
} from '../../lib/obsidian/vault-provider.js';
import type { ReadNotesItemSuccess, VaultReader } from '../../lib/obsidian/vault-reader.js';
import { ToolHandlerError } from '../../lib/tool-response.js';
import { ObsidianCLIProvider, type ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';

function sortCounts(counts: Map<string, number>): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface FsVaultProviderOptions extends ObsidianCLIProviderOptions {
  reader?: VaultReader;
}

/**
 * Disk-direct VaultProvider (strangler fig over ObsidianCLIProvider).
 * Methods without a disk implementation yet delegate to an internal CLI
 * provider; each migration step replaces one delegation. When none remain,
 * the delegate and ObsidianCLIProvider are deleted.
 */
export class FsVaultProvider implements VaultProvider {
  private readonly cli: ObsidianCLIProvider;
  private readonly reader: VaultReader | undefined;
  private readonly vaultRootOpt: string | undefined;

  constructor(opts: FsVaultProviderOptions = {}) {
    this.cli = new ObsidianCLIProvider(opts);
    this.reader = opts.reader;
    this.vaultRootOpt = opts.vaultRoot;
  }

  private requireReader(): VaultReader {
    if (!this.reader) throw new Error('FsVaultProvider: reader not wired');
    return this.reader;
  }

  private requireVaultRoot(): string {
    if (this.vaultRootOpt === undefined) throw new Error('FsVaultProvider: vaultRoot not wired');
    return this.vaultRootOpt;
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const vaultRoot = this.requireVaultRoot();
    if (input.name === undefined && input.path === undefined) {
      throw new Error('createNote requires name or path');
    }
    const relPath =
      input.path ?? normalizeNotePath((await this.newNoteDir(vaultRoot)) + input.name!);
    const absPath = path.join(vaultRoot, relPath);

    await mkdir(path.dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, input.content ?? '', {
        encoding: 'utf8',
        flag: input.overwrite ? 'w' : 'wx',
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new ToolHandlerError(
          'NOTE_EXISTS',
          'Note already exists. Pass overwrite: true after confirming with the user.',
          { details: { path: relPath }, cause: err },
        );
      }
      throw new ToolHandlerError(
        'CREATE_FAILED',
        `Failed to write ${relPath}: ${(err as Error).message}`,
        {
          details: { path: relPath },
          cause: err,
        },
      );
    }
    return { path: relPath };
  }

  /** '' or 'Folder/' prefix for name-identified new notes, per .obsidian/app.json. */
  private async newNoteDir(vaultRoot: string): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, '.obsidian/app.json'), 'utf8');
    } catch {
      return '';
    }
    try {
      const parsed = JSON.parse(raw) as { newFileLocation?: string; newFileFolderPath?: string };
      if (parsed.newFileLocation === 'folder' && typeof parsed.newFileFolderPath === 'string') {
        const folder = parsed.newFileFolderPath.trim().replace(/\/+$/, '');
        if (folder !== '') return `${folder}/`;
      }
    } catch {
      /* malformed app.json → vault root */
    }
    return '';
  }

  async readDaily(): Promise<DailyNoteResult> {
    const vaultRoot = this.requireVaultRoot();
    const config = await readDailyNotesConfig(vaultRoot);
    const relPath = `${config.folder}/${formatDailyDate(config.format, new Date())}.md`;

    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, relPath), 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new ToolHandlerError(
          'NOT_FOUND',
          `Today's daily note does not exist yet: ${relPath}. Create it with create_note at this path.`,
          { details: { path: relPath }, cause: err },
        );
      }
      throw new ToolHandlerError(
        'READ_FAILED',
        `Failed to read ${relPath}: ${(err as Error).message}`,
        {
          details: { path: relPath },
          cause: err,
        },
      );
    }

    const { frontmatter, content } = splitFrontmatter(raw);
    return { path: relPath, frontmatter, content };
  }

  async setProperty(input: SetPropertyInput): Promise<void> {
    return this.cli.setProperty(input);
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    return this.cli.removeProperty(input);
  }

  async listProperties(): Promise<PropertyListEntry[]> {
    const counts = new Map<string, number>();
    for (const fm of await this.scanFrontmatter()) {
      for (const key of Object.keys(fm)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return sortCounts(counts);
  }

  async listTags(): Promise<TagListEntry[]> {
    const counts = new Map<string, number>();
    for (const fm of await this.scanFrontmatter()) {
      for (const tag of extractTags(fm)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return sortCounts(counts);
  }

  private async scanFrontmatter(): Promise<Array<Record<string, unknown>>> {
    const reader = this.requireReader();
    const paths = await reader.scan();
    const items = await reader.readNotes({ paths, fields: ['frontmatter'] });
    return items
      .filter((i): i is ReadNotesItemSuccess => !('error' in i))
      .map((i) => i.frontmatter ?? {});
  }
}
