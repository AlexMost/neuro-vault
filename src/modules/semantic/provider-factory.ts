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
} from './daemon-connection.js';
import { DaemonEmbeddingProvider, type DaemonLink } from './daemon-embedding-provider.js';
import { EmbeddingService, LOCAL_MAX_BATCH_SIZE } from './embedding-service.js';
import type { LocalModelLoader } from './local-model-loader.js';
import type { ModelProfile } from './model-profiles.js';
import type { EmbeddingProvider } from './types.js';

/** The connection's I/O, replaceable by tests; everything else is derived. */
export type ConnectionIo = Omit<
  DaemonConnectionDeps,
  'paths' | 'cliPath' | 'platform' | 'build' | 'statBuild'
>;

export interface ProviderFactoryOptions {
  profile: ModelProfile;
  /** false: load the model in this process (also what the daemon itself does). */
  shared: boolean;
  /**
   * Realpath of the running CLI script: the daemon is keyed by its size and
   * mtime and spawned from it. Without one the facade falls back in-process.
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
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
  /** Default `stampOf` (`fs.statSync`: size, mtime and inode). */
  build?: (cliPath: string) => CliStamp;
  /** Injected by tests; production uses real sockets, processes and files. */
  io?: Partial<ConnectionIo>;
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

/**
 * The one place a provider is chosen for a profile: the server, `index` and
 * the daemon's embed service all come through here (design D7). A remote
 * provider is a later profile kind handled in this same switch.
 *
 * `shared` builds the daemon facade over a lazy connection: nothing is probed,
 * spawned or created until the first call. The in-process fallback is built
 * only if that call finds the daemon unavailable.
 */
export function createEmbeddingProvider(opts: ProviderFactoryOptions): EmbeddingProvider {
  const local = (): EmbeddingProvider =>
    new EmbeddingService({ profile: opts.profile, loader: opts.loader });
  if (!opts.shared) return local();

  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const platform = opts.platform ?? process.platform;
  const facade = (connection: DaemonLink, logFile?: string): EmbeddingProvider =>
    new DaemonEmbeddingProvider({
      profile: opts.profile,
      connection,
      createFallback: local,
      initialMaxBatchSize: LOCAL_MAX_BATCH_SIZE,
      stderr: opts.stderr ?? process.stderr,
      logFile,
    });

  const cliPath = opts.cliPath;
  if (cliPath === undefined) return facade(unavailableLink('no CLI script path to key it by'));
  const statBuild = opts.build ?? stampOf;
  let build: CliStamp;
  try {
    build = statBuild(cliPath);
  } catch (error) {
    return facade(
      unavailableLink(`cannot identify the CLI script at ${cliPath}: ${messageOf(error)}`),
    );
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
  return facade(connection, paths.logFile);
}
