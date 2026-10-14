/** What `lstat` must report about the socket directory. */
export interface DirStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
}

export interface SocketDirFs {
  /** `mkdir -p` with mode 0700. */
  mkdirp(dir: string): void;
  /** Stat `p` itself, not what a symlink there points at. */
  lstat(p: string): DirStat;
  chmod(p: string, mode: number): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POSIX: make `dir` (the `/tmp/neuro-vault-<uid>` socket directory) exist as a
 * real directory owned by `uid` with mode 0700, or throw naming the path and
 * what is wrong. `/tmp` is shared, so another local user can create the path
 * first: as a symlink to a directory they control, or as a directory of their
 * own. `mkdir -p` accepts both, so the result is checked with `lstat` before
 * anything is put in it. The socket file's own mode is only access control
 * inside a directory that passed this check.
 */
export function ensurePrivateSocketDir(dir: string, deps: { fs: SocketDirFs; uid: number }): void {
  let mkdirError: unknown;
  try {
    deps.fs.mkdirp(dir);
  } catch (error) {
    // A regular file (EEXIST) or a dangling symlink (ENOENT) is there: lstat says which.
    mkdirError = error;
  }
  let stat: DirStat;
  try {
    stat = deps.fs.lstat(dir);
  } catch (error) {
    throw mkdirError ?? error;
  }
  if (stat.isSymbolicLink()) throw new Error(`socket directory ${dir} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`socket directory ${dir} is not a directory`);
  if (stat.uid !== deps.uid) {
    throw new Error(`socket directory ${dir} is owned by uid ${stat.uid}, not ${deps.uid}`);
  }
  // Tighten a looser mode left by an older run.
  try {
    deps.fs.chmod(dir, 0o700);
  } catch (error) {
    throw new Error(`cannot chmod 0700 socket directory ${dir}: ${messageOf(error)}`);
  }
}
