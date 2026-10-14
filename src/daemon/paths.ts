import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DaemonPaths {
  key: string;
  socketPath: string;
  stateDir: string;
  infoFile: string;
  logFile: string;
  lockFile: string;
}

/** The identity of an installed CLI script: its size and mtime. */
export interface CliBuild {
  size: number;
  mtimeMs: number;
}

/**
 * Size and mtime of the running cli.js (pass its realpath). A symlinked dev
 * install rebuilds without a version bump, so these join the version in the key.
 */
export function cliBuild(
  cliPath: string,
  stat: (p: string) => { size: number; mtimeMs: number } = fs.statSync,
): CliBuild {
  const { size, mtimeMs } = stat(cliPath);
  return { size, mtimeMs };
}

/**
 * 12 hex chars of sha256 over a layout tag, the package version and the CLI
 * script's size + mtime: one daemon per installed *build* (a symlinked dev
 * install rebuilds without a version bump, so the build joins the version).
 */
export function daemonKey(version: string, build: CliBuild): string {
  return createHash('sha256')
    .update(`v1:${version}:${build.size}:${build.mtimeMs}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * The socket lives under `/tmp`, not `os.tmpdir()`: macOS's per-user tmpdir
 * is 48 bytes long on its own and a unix socket path is capped at 103.
 */
export function daemonPaths(opts: {
  version: string;
  build: CliBuild;
  uid: number;
  platform: NodeJS.Platform;
  cacheBase: string;
}): DaemonPaths {
  const key = daemonKey(opts.version, opts.build);
  const socketPath =
    opts.platform === 'win32'
      ? `\\\\.\\pipe\\neuro-vault-${opts.uid}-${key}`
      : path.posix.join('/tmp', `neuro-vault-${opts.uid}`, `${key}.sock`);
  const stateDir = path.join(opts.cacheBase, 'daemons', key);
  return {
    key,
    socketPath,
    stateDir,
    infoFile: path.join(stateDir, 'daemon.json'),
    logFile: path.join(stateDir, 'daemon.log'),
    lockFile: path.join(stateDir, 'daemon.lock'),
  };
}
