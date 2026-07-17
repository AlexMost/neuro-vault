import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMap, parseDocument } from 'yaml';

import { readDailyNotesConfig } from '../../lib/obsidian/daily-notes-config.js';
import { formatDailyDate } from '../../lib/obsidian/daily-note-path.js';
import {
  serializeFrontmatter,
  sliceFrontmatterYaml,
  splitFrontmatter,
} from '../../lib/obsidian/frontmatter.js';
import { splitRawFrontmatter } from '../../lib/obsidian/in-place-edit.js';
import { normalizeNotePath } from '../../lib/obsidian/note-path.js';
import { resolveNoteName } from './resolve-note-name.js';
import { invalidArgument } from './tool-helpers.js';
import { extractTags } from '../../lib/obsidian/query/note-record.js';
import type {
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  NoteIdentifier,
  PropertyListEntry,
  RemovePropertyInput,
  SetPropertyInput,
  TagListEntry,
  VaultProvider,
} from '../../lib/obsidian/vault-provider.js';
import type { ReadNotesItemSuccess, VaultReader } from '../../lib/obsidian/vault-reader.js';
import { ToolHandlerError } from '../../lib/tool-response.js';

function sortCounts(counts: Map<string, number>): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface FsVaultProviderOptions {
  vaultRoot: string;
  reader: VaultReader;
}

/**
 * Disk-direct VaultProvider. Every method reads and writes the vault directory
 * straight from disk (via `node:fs` and the injected {@link VaultReader}) — the
 * server no longer shells out to the Obsidian CLI, so Obsidian need not be
 * installed or running.
 */
export class FsVaultProvider implements VaultProvider {
  private readonly reader: VaultReader;
  private readonly vaultRoot: string;

  constructor(opts: FsVaultProviderOptions) {
    this.reader = opts.reader;
    this.vaultRoot = opts.vaultRoot;
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const vaultRoot = this.vaultRoot;
    if (input.name === undefined && input.path === undefined) {
      throw new Error('createNote requires name or path');
    }
    let relPath: string;
    if (input.path !== undefined) {
      relPath = input.path;
    } else {
      try {
        relPath = normalizeNotePath((await this.newNoteDir(vaultRoot)) + input.name!);
      } catch (err) {
        // Mirror the tool-layer `path` branch: a name that normalizes outside
        // the vault (e.g. '../x') is a caller error, not an internal failure.
        throw invalidArgument((err as Error).message, 'name');
      }
    }
    const absPath = path.join(vaultRoot, relPath);

    try {
      await mkdir(path.dirname(absPath), { recursive: true });
    } catch (err) {
      // e.g. a parent path component is a file, not a directory — a creation
      // failure, not a "note already exists" case.
      throw new ToolHandlerError(
        'CREATE_FAILED',
        `Failed to create directory for ${relPath}: ${(err as Error).message}`,
        { details: { path: relPath }, cause: err },
      );
    }
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
    const vaultRoot = this.vaultRoot;
    const config = await readDailyNotesConfig(vaultRoot);
    // `folder` and `format` come straight from daily-notes.json — a malicious
    // or misconfigured `folder: "../outside"` (or a `[literal]` format with
    // slashes) would otherwise resolve outside the vault. Normalize the whole
    // path so `..`/absolute components are rejected, and surface it as the
    // config error rather than an escape. (formatDailyDate's own
    // unsupported-token error is left to propagate unchanged.)
    const formatted = formatDailyDate(config.format, new Date());
    let relPath: string;
    try {
      relPath = normalizeNotePath(`${config.folder}/${formatted}.md`);
    } catch (err) {
      throw new ToolHandlerError(
        'DAILY_NOTES_NOT_CONFIGURED',
        `Daily Notes config resolves to a path outside the vault ` +
          `(folder='${config.folder}', format='${config.format}'). ` +
          `Fix the Daily Notes folder/format in Obsidian.`,
        { details: { folder: config.folder, format: config.format }, cause: err },
      );
    }

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
    await this.editFrontmatter(input.identifier, (doc) => {
      doc.set(input.name, input.value);
      return true;
    });
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    await this.editFrontmatter(input.identifier, (doc) => {
      if (!doc.has(input.name)) return false;
      doc.delete(input.name);
      return true;
    });
  }

  /** Shared read → mutate YAML document → write path. `mutate` returns false to skip the write. */
  private async editFrontmatter(
    identifier: NoteIdentifier,
    mutate: (doc: ReturnType<typeof parseDocument>) => boolean,
  ): Promise<void> {
    const vaultRoot = this.vaultRoot;
    const relPath = await this.resolveIdentifierPath(identifier);
    const absPath = path.join(vaultRoot, relPath);

    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new ToolHandlerError('NOT_FOUND', `Note not found: ${relPath}`, {
          details: { path: relPath },
          cause: err,
        });
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

    const { prefix, body } = splitRawFrontmatter(raw);
    const yamlBody = prefix === '' ? '' : sliceFrontmatterYaml(prefix);
    const doc = parseDocument(yamlBody === '' ? '{}' : yamlBody);
    if (doc.errors.length > 0) {
      throw new ToolHandlerError(
        'READ_FAILED',
        `Frontmatter of ${relPath} is not valid YAML; fix the note before editing properties.`,
        { details: { path: relPath, errors: doc.errors.map((e) => e.message) } },
      );
    }
    // Syntactically valid YAML whose root is a scalar or sequence (e.g. a
    // frontmatter block that is just `scalar` or a `- list`) parses without
    // errors, but doc.set()/doc.delete() would throw a plain Error. An empty
    // block yields `contents === null`, which the mutators handle fine.
    if (doc.contents !== null && !isMap(doc.contents)) {
      throw new ToolHandlerError(
        'READ_FAILED',
        `Frontmatter of ${relPath} is not a YAML mapping; properties can only be edited on key/value frontmatter.`,
        { details: { path: relPath } },
      );
    }

    if (!mutate(doc)) return;

    const contents = doc.contents;
    const isEmptyMap =
      contents === null ||
      (typeof contents === 'object' && 'items' in contents && contents.items.length === 0);
    let newPrefix: string;
    if (isEmptyMap) {
      newPrefix = '';
    } else if (yamlBody === '') {
      // The note had no frontmatter: serialize the fresh object cleanly.
      newPrefix = serializeFrontmatter(doc.toJS() as Record<string, unknown>);
    } else {
      newPrefix = `---\n${doc.toString()}---\n`;
    }
    try {
      await writeFile(absPath, newPrefix + body, 'utf8');
    } catch (err) {
      throw new ToolHandlerError(
        'WRITE_FAILED',
        `Failed to write ${relPath}: ${(err as Error).message}`,
        { details: { path: relPath }, cause: err },
      );
    }
  }

  private async resolveIdentifierPath(identifier: NoteIdentifier): Promise<string> {
    if (identifier.kind === 'path') return normalizeNotePath(identifier.value);
    return resolveNoteName(this.reader, identifier.value);
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
    const reader = this.reader;
    const paths = await reader.scan();
    const items = await reader.readNotes({ paths, fields: ['frontmatter'] });
    return items
      .filter((i): i is ReadNotesItemSuccess => !('error' in i))
      .map((i) => i.frontmatter ?? {});
  }
}
