import { mkdir as fsMkdir } from 'node:fs/promises';

export type MkdirFn = (p: string, opts: { recursive: boolean }) => Promise<unknown>;

/**
 * Creates `dir`, a directory at or below `metaDir` (`<vault>/.neuro-vault`),
 * without ever creating the vault root: `metaDir` is made non-recursively, so a
 * vault directory that was deleted (or whose volume was unmounted) fails with
 * ENOENT instead of coming back as an empty vault whose corpus the next scan
 * would sweep. Only what lies below `metaDir` is created recursively.
 *
 * A mount point left behind as an empty directory still passes: the server
 * cannot tell it from a vault with no notes.
 */
export async function ensureCorpusDir(
  metaDir: string,
  dir: string,
  mkdir: MkdirFn = fsMkdir,
): Promise<void> {
  try {
    await mkdir(metaDir, { recursive: false });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'EEXIST') throw err;
  }
  if (dir !== metaDir) await mkdir(dir, { recursive: true });
}
