import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { ToolHandlerError } from '../tool-response.js';

export interface DailyNotesConfig {
  /** Vault-relative POSIX path to the daily notes folder, no trailing slash. */
  folder: string;
  /** moment.js-compatible format string. Defaults to 'YYYY-MM-DD'. */
  format: string;
}

export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;

const CONFIG_REL = '.obsidian/daily-notes.json';
const DEFAULT_FORMAT = 'YYYY-MM-DD';

/**
 * Read and validate Obsidian's Daily Notes core-plugin configuration. Throws
 * `ToolHandlerError('DAILY_NOTES_NOT_CONFIGURED')` when the config is absent,
 * unreadable, malformed JSON, or its `folder` is missing/empty/blank.
 *
 * `FsVaultProvider.readDaily` depends on this failing fast: for a vault where
 * the Daily Notes plugin has never been configured there is no folder/format
 * to resolve headlessly, so the server refuses with the contract error rather
 * than guessing a path at the vault root (see
 * docs/architecture/disk-write-path.md).
 */
export async function readDailyNotesConfig(
  vaultRoot: string,
  readFile: FsReadFile = fsReadFile,
): Promise<DailyNotesConfig> {
  const absPath = path.join(vaultRoot, CONFIG_REL);

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new ToolHandlerError(
      'DAILY_NOTES_NOT_CONFIGURED',
      `Daily Notes plugin is not configured for this vault. ` +
        `Expected ${CONFIG_REL} (daily-notes.json) to exist with a non-empty 'folder' field. ` +
        `Open the vault in Obsidian and configure Daily Notes (or Periodic Notes), then retry.`,
      { details: { vaultRoot, configPath: CONFIG_REL }, cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolHandlerError(
      'DAILY_NOTES_NOT_CONFIGURED',
      `Daily Notes config at ${CONFIG_REL} (daily-notes.json) is not valid JSON.`,
      { details: { vaultRoot, configPath: CONFIG_REL }, cause: err },
    );
  }

  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const folderRaw = typeof obj.folder === 'string' ? obj.folder.trim() : '';
  if (folderRaw === '') {
    throw new ToolHandlerError(
      'DAILY_NOTES_NOT_CONFIGURED',
      `Daily Notes config at ${CONFIG_REL} (daily-notes.json) has no 'folder' set. ` +
        `Configure a daily-notes folder in Obsidian's Daily Notes plugin and retry.`,
      { details: { vaultRoot, configPath: CONFIG_REL } },
    );
  }
  const folder = folderRaw.replace(/\/+$/, '');

  const formatRaw = typeof obj.format === 'string' ? obj.format.trim() : '';
  const format = formatRaw === '' ? DEFAULT_FORMAT : formatRaw;

  return { folder, format };
}
