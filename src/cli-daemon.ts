import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CALL_TIMEOUT_MS,
  defaultDaemonFs,
  runStatus,
  runStop,
  type DaemonFs,
  type OutStream,
} from './daemon/admin.js';
import { readDaemonInfo, writeDaemonInfo, type DaemonInfo } from './daemon/info.js';
import { acquireLock, isPidAlive, releaseLock } from './daemon/lock.js';
import { cliBuild, daemonPaths, type CliBuild, type DaemonPaths } from './daemon/paths.js';
import {
  cleanStaleSocket,
  defaultConnect,
  type SocketConnect,
  type Timers,
} from './daemon/probe.js';
import { ServiceRegistry } from './daemon/protocol.js';
import { createDaemonService } from './daemon/services/daemon.js';
import { createEmbedService } from './daemon/services/embed.js';
import { startDaemonServer, type DaemonServerHandle } from './daemon/socket-server.js';
import { neuroVaultCacheBase } from './lib/cache-dir.js';
import type { ModelProfile } from './modules/semantic/model-profiles.js';
import { createEmbeddingProvider } from './modules/semantic/provider-factory.js';
import type { EmbeddingProvider } from './modules/semantic/types.js';
import { packageMeta } from './package-meta.js';
import type { DaemonCliOptions } from './types.js';

export { CALL_TIMEOUT_MS, type DaemonFs };

/** Stopping exits 0 after this long even if closing the server has not finished. */
export const STOP_DEADLINE_MS = 5_000;

export interface DaemonCommandDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  pid?: number;
  version?: string;
  /** Realpath of the running CLI script; default `realpathSync(process.argv[1])`. */
  cliPath?: string;
  /** Size + mtime of the CLI script; default `cliBuild(cliPath)`. */
  build?: CliBuild;
  now?: () => Date;
  fs?: DaemonFs;
  isAlive?: (pid: number) => boolean;
  connect?: SocketConnect;
  startServer?: typeof startDaemonServer;
  createProvider?: (profile: ModelProfile) => EmbeddingProvider;
  writeInfo?: (file: string, info: DaemonInfo) => Promise<void>;
  readInfo?: (file: string) => DaemonInfo | undefined;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  exit?: (code: number) => void;
  timers?: Timers;
  stdout?: OutStream;
  stderr?: OutStream;
  kill?: (pid: number, signal: 'SIGTERM') => void;
}

function resolveDeps(deps: DaemonCommandDeps) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  return {
    platform: deps.platform ?? process.platform,
    uid: deps.uid ?? os.userInfo().uid,
    version: deps.version ?? packageMeta.version,
    cacheBase: neuroVaultCacheBase(env, home),
    pid: deps.pid ?? process.pid,
    cliPath: deps.cliPath,
    build: deps.build,
    now: deps.now ?? (() => new Date()),
    fs: deps.fs ?? defaultDaemonFs(),
    isAlive: deps.isAlive ?? isPidAlive,
    connect: deps.connect ?? defaultConnect,
    startServer: deps.startServer ?? startDaemonServer,
    createProvider:
      deps.createProvider ??
      ((profile: ModelProfile) => createEmbeddingProvider({ profile, shared: false })),
    writeInfo: deps.writeInfo ?? ((file: string, info: DaemonInfo) => writeDaemonInfo(file, info)),
    readInfo: deps.readInfo ?? ((file: string) => readDaemonInfo(file)),
    onSignal:
      deps.onSignal ??
      ((signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void process.once(signal, handler)),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    timers: deps.timers ?? { setTimeout, clearTimeout },
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    kill: deps.kill ?? ((pid: number, signal: 'SIGTERM') => void process.kill(pid, signal)),
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

/** `neuro-vault-mcp daemon [status|stop]`. Resolves to the exit code; a running daemon resolves 0 once up. */
export async function runDaemonCommand(
  options: DaemonCliOptions,
  deps: DaemonCommandDeps = {},
): Promise<number> {
  const r = resolveDeps(deps);
  if (options.action === 'status') return runStatus(r);
  if (options.action === 'stop') return runStop(r);
  return runDaemon(options, r);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The build the daemon is keyed by, or an error line naming the script it could not read. */
function identifyBuild(r: Resolved): CliBuild | string {
  if (r.build !== undefined) return r.build;
  const cliPath = r.cliPath ?? process.argv[1];
  if (cliPath === undefined) return 'cannot identify the CLI script: no script path';
  try {
    return cliBuild(r.cliPath ?? realpathSync(cliPath));
  } catch (error) {
    return `cannot identify the CLI script at ${cliPath}: ${messageOf(error)}`;
  }
}

async function runDaemon(options: DaemonCliOptions, r: Resolved): Promise<number> {
  const name = packageMeta.name;
  const build = identifyBuild(r);
  if (typeof build === 'string') {
    r.stderr.write(`${name} daemon: ${build}\n`);
    return 1;
  }
  const paths = daemonPaths({
    version: r.version,
    build,
    uid: r.uid,
    platform: r.platform,
    cacheBase: r.cacheBase,
  });

  const lock = acquireLock(paths.lockFile, { pid: r.pid, isAlive: r.isAlive, fs: r.fs });
  if (lock.kind === 'held') {
    r.stderr.write(`${name} daemon is already running (pid ${lock.pid})\n`);
    return 1;
  }
  if (lock.kind === 'contended') {
    r.stderr.write(`${name} could not take the daemon lock (contended); try again\n`);
    return 1;
  }

  // From here on we hold the lock: any failure before the daemon is up gives it back.
  const server: ServerSlot = {};
  try {
    if (await prepareSocket(paths, r)) {
      releaseLock(paths.lockFile, r.fs, r.pid);
      r.stderr.write(`${name} daemon is already listening on ${paths.socketPath}\n`);
      return 1;
    }
    const stop = await startServing(options, paths, build, r, server);
    r.onSignal('SIGINT', stop);
    r.onSignal('SIGTERM', stop);
  } catch (error) {
    await server.handle?.close().catch(() => undefined);
    releaseLock(paths.lockFile, r.fs, r.pid);
    r.stderr.write(`${name} daemon failed to start: ${messageOf(error)}\n`);
    return 1;
  }
  r.stderr.write(
    `${name} v${r.version} daemon listening on ${paths.socketPath} ` +
      `(idle timeout ${options.idleTimeoutMinutes} min)\n`,
  );
  return 0;
}

/**
 * POSIX: create the socket directory 0700 (and tighten a looser one left by an
 * older run), then unlink a socket file nobody answers on. True when something
 * already listens there.
 */
async function prepareSocket(paths: DaemonPaths, r: Resolved): Promise<boolean> {
  if (r.platform !== 'win32') {
    const dir = path.posix.dirname(paths.socketPath);
    r.fs.mkdirp(dir);
    r.fs.chmod(dir, 0o700);
  }
  const cleaned = await cleanStaleSocket(paths.socketPath, {
    connect: r.connect,
    unlink: (p) => r.fs.unlink(p),
    platform: r.platform,
    timers: r.timers,
  });
  return cleaned === 'listening';
}

/** Set as soon as the server listens, so a later startup failure can close it. */
interface ServerSlot {
  handle?: DaemonServerHandle;
}

/** Listen, chmod the socket, record daemon.json. Returns the stop routine. */
async function startServing(
  options: DaemonCliOptions,
  paths: DaemonPaths,
  build: CliBuild,
  r: Resolved,
  server: ServerSlot,
): Promise<() => void> {
  const embed = createEmbedService({ createProvider: r.createProvider });
  const registry = new ServiceRegistry();
  registry.register('embed', embed.handlers);

  const stop = createStop(paths, r, server);
  const startedAt = r.now().toISOString();
  registry.register(
    'daemon',
    createDaemonService({
      name: packageMeta.name,
      version: r.version,
      pid: r.pid,
      startedAt,
      idleTimeoutMin: options.idleTimeoutMinutes,
      clients: () => server.handle?.clients() ?? 0,
      embedLoaded: () => embed.loaded(),
      // Deferred one tick so the shutdown response is written before the socket ends.
      requestShutdown: () => void r.timers.setTimeout(stop, 0),
    }),
  );

  server.handle = await r.startServer({
    socketPath: paths.socketPath,
    registry,
    idleTimeoutMs: options.idleTimeoutMinutes * 60_000,
    onIdle: stop,
    timers: r.timers,
    onError: (error) => void r.stderr.write(`${packageMeta.name} daemon: ${error.message}\n`),
  });
  // The 0700 directory guards the socket between listen and this chmod.
  if (r.platform !== 'win32') r.fs.chmod(paths.socketPath, 0o600);
  await r.writeInfo(paths.infoFile, {
    pid: r.pid,
    version: r.version,
    socket: paths.socketPath,
    started_at: startedAt,
    cli_size: build.size,
    cli_mtime_ms: build.mtimeMs,
  });
  return stop;
}

/**
 * The one stop path (SIGINT, SIGTERM, idle, daemon.shutdown): close the
 * server, remove daemon.json, the socket file and the lock, exit 0. Runs once;
 * exits 0 at `STOP_DEADLINE_MS` even if closing stalls on a peer that never reads.
 */
function createStop(paths: DaemonPaths, r: Resolved, server: ServerSlot): () => void {
  let stopping = false;
  let finished = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const attempt = (what: string, work: () => void): void => {
    try {
      work();
    } catch (error) {
      r.stderr.write(`${packageMeta.name} daemon: could not remove ${what}: ${messageOf(error)}\n`);
    }
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (deadline !== undefined) r.timers.clearTimeout(deadline);
    attempt(paths.infoFile, () => r.fs.unlink(paths.infoFile));
    if (r.platform !== 'win32') attempt(paths.socketPath, () => r.fs.unlink(paths.socketPath));
    // Last: until the lock goes, no new daemon can take this socket path.
    attempt(paths.lockFile, () => releaseLock(paths.lockFile, r.fs, r.pid));
    r.exit(0);
  };
  return () => {
    if (stopping) return;
    stopping = true;
    deadline = r.timers.setTimeout(finish, STOP_DEADLINE_MS);
    void Promise.resolve()
      .then(() => server.handle?.close())
      .catch((error: unknown) => {
        r.stderr.write(`${packageMeta.name} daemon: close failed: ${messageOf(error)}\n`);
      })
      .finally(finish);
  };
}
