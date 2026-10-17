import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { daemonPaths } from '../../daemon/paths.js';
import { defaultConnect } from '../../daemon/probe.js';
import { ensurePrivateSocketDir } from '../../daemon/socket-dir.js';
import { neuroVaultCacheBase } from '../../lib/cache-dir.js';
import { packageMeta } from '../../package-meta.js';

import {
  DaemonConnection,
  DaemonUnavailableError,
  type CliStamp,
  type DaemonConnectionDeps,
  type DaemonLink,
} from './daemon-connection.js';

/** The connection's I/O, replaceable by tests; everything else is derived. */
export type ConnectionIo = Omit<
  DaemonConnectionDeps,
  'paths' | 'cliPath' | 'platform' | 'build' | 'statBuild'
>;

/** What a process needs to reach the shared daemon, whatever model profiles it runs. */
export interface SharedServicesOptions {
  /** false: nothing is shared with a daemon (also what the daemon itself uses). */
  shared: boolean;
  /**
   * Realpath of the running CLI script: the daemon is keyed by its size and
   * mtime and spawned from it. Without one the process runs in-process.
   */
  cliPath?: string;
  /** Default `packageMeta.version`. */
  version?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Default `process.getuid()`; -1 where there is none (Windows). */
  uid?: number;
  platform?: NodeJS.Platform;
  stderr?: { write(chunk: string): boolean };
  /** Default `stampOf` (`fs.statSync`: size, mtime and inode). */
  build?: (cliPath: string) => CliStamp;
  /** Injected by tests; production uses real sockets, processes and files. */
  io?: Partial<ConnectionIo>;
}

/**
 * The process's one connection to the shared daemon and its one one-way
 * switch (design D11). Every daemon-backed facade — embedding and corpus
 * reads — runs `ensure()` through it, so the decision to stop using the
 * daemon is made, and reported, once.
 */
export interface ISharedServices {
  /** `pending` until the first `ensure()` settles; `local` is final. */
  readonly mode: 'pending' | 'daemon' | 'local';
  readonly connection: DaemonLink;
  /**
   * Connect to the daemon (spawning it if needed). When it cannot be located
   * or started, flip to `local` for good, write one stderr line, and answer
   * `local`. A connection error on a later request never flips the switch.
   */
  ensure(): Promise<'daemon' | 'local'>;
  close(): void;
}

function defaultIo(uid: number): ConnectionIo {
  return {
    execPath: process.execPath,
    cwd: os.homedir(),
    // Not os.userInfo(): it throws when the uid has no passwd entry (docker --user).
    ensureSocketDir: (dir) =>
      ensurePrivateSocketDir(dir, {
        uid,
        fs: {
          mkdirp: (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 }),
          lstat: (p) => fs.lstatSync(p),
          chmod: (p, mode) => fs.chmodSync(p, mode),
        },
      }),
    connect: defaultConnect,
    spawn: (file, args, opts) => spawn(file, args, opts),
    openLog: (file) => fs.openSync(file, 'a', 0o600),
    closeFd: (fd) => fs.closeSync(fd),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  };
}

/** Size and mtime (the daemon key's build, as `cliBuild` reads it) plus the inode. */
function stampOf(cliPath: string): CliStamp {
  const { size, mtimeMs, ino } = fs.statSync(cliPath);
  return { size, mtimeMs, ino };
}

/** A link whose every `ensure` reports the daemon unavailable, for a build we cannot key. */
function unavailableLink(reason: string): DaemonLink {
  return {
    epoch: 0,
    ensure: () => Promise.reject(new DaemonUnavailableError(reason)),
    close: () => {},
    request: () => Promise.reject(new DaemonUnavailableError(reason)),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SharedServices implements ISharedServices {
  private current: 'pending' | 'daemon' | 'local';

  constructor(
    readonly connection: DaemonLink,
    private readonly stderr: { write(chunk: string): boolean },
    /** Named in the fallback line; absent when the build could not be identified. */
    private readonly logFile: string | undefined,
    shared: boolean,
  ) {
    this.current = shared ? 'pending' : 'local';
  }

  get mode(): 'pending' | 'daemon' | 'local' {
    return this.current;
  }

  async ensure(): Promise<'daemon' | 'local'> {
    if (this.current === 'local') return 'local';
    try {
      await this.connection.ensure();
    } catch (error) {
      // Only locating or starting the daemon raises it; anything else is the caller's.
      if (!(error instanceof DaemonUnavailableError)) throw error;
      this.switchToLocal(error);
      return 'local';
    }
    // A concurrent caller may have flipped the switch while this one connected.
    if (this.mode === 'local') return 'local';
    this.current = 'daemon';
    return 'daemon';
  }

  close(): void {
    this.connection.close();
  }

  private switchToLocal(error: DaemonUnavailableError): void {
    if (this.current === 'local') return;
    this.current = 'local';
    const log = this.logFile === undefined ? '' : ` — see ${this.logFile}`;
    this.stderr.write(
      `${packageMeta.name}: shared daemon unavailable (${error.message}); ` +
        `running in-process for this session${log}\n`,
    );
  }
}

/**
 * One per process: `shared` builds the daemon connection lazily — nothing is
 * probed, spawned or created until the first `ensure()`. `shared: false` is
 * `local` from the start, with no connection and no line.
 */
export function createSharedServices(opts: SharedServicesOptions): ISharedServices {
  const stderr = opts.stderr ?? process.stderr;
  if (!opts.shared) {
    return new SharedServices(unavailableLink('shared daemon disabled'), stderr, undefined, false);
  }
  // A build we cannot key: the first `ensure()` reports why and goes in-process.
  const local = (reason: string): ISharedServices =>
    new SharedServices(unavailableLink(reason), stderr, undefined, true);

  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const platform = opts.platform ?? process.platform;
  const cliPath = opts.cliPath;
  if (cliPath === undefined) return local('no CLI script path to key it by');
  const statBuild = opts.build ?? stampOf;
  let build: CliStamp;
  try {
    build = statBuild(cliPath);
  } catch (error) {
    return local(`cannot identify the CLI script at ${cliPath}: ${messageOf(error)}`);
  }
  const paths = daemonPaths({
    version: opts.version ?? packageMeta.version,
    // The key is size + mtime only: the daemon computes the same from its own argv.
    build: { size: build.size, mtimeMs: build.mtimeMs },
    uid,
    platform,
    cacheBase: neuroVaultCacheBase(opts.env ?? process.env, opts.home ?? os.homedir()),
  });
  const connection = new DaemonConnection({
    ...defaultIo(uid),
    ...opts.io,
    paths,
    cliPath,
    platform,
    build,
    statBuild,
  });
  return new SharedServices(connection, stderr, paths.logFile, true);
}
