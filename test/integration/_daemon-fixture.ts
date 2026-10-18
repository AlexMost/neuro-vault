import { daemonPaths } from '../../src/daemon/paths.js';
import { defaultConnect } from '../../src/daemon/probe.js';
import type { ServiceHandlers } from '../../src/daemon/protocol.js';
import { DaemonConnection } from '../../src/modules/semantic/daemon-connection.js';
import type { ISharedServices } from '../../src/modules/semantic/shared-services.js';

/** One request the daemon side received: the method and the params it was given. */
export interface IRecordedRequest {
  method: string;
  params: unknown;
}

/** The service's handlers, each logging `<namespace>.<method>` and its params before it runs. */
export function recording(
  namespace: string,
  handlers: ServiceHandlers,
  log: IRecordedRequest[],
): ServiceHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params, ctx) => {
        log.push({ method: `${namespace}.${method}`, params });
        return handler(params, ctx);
      },
    ]),
  );
}

/**
 * A session's real {@link DaemonConnection} to the test daemon listening on `socketPath`, and the
 * thin {@link ISharedServices} shell a session builds around it. It never spawns: the test owns
 * the socket. `sent` lists the methods this connection sent, in order.
 */
export function daemonServices(opts: { dir: string; socketPath: string }) {
  const connection = new DaemonConnection({
    paths: {
      ...daemonPaths({
        version: '0.0.0',
        build: { size: 1, mtimeMs: 1 },
        uid: 1,
        platform: 'linux',
        cacheBase: opts.dir,
      }),
      socketPath: opts.socketPath,
    },
    cliPath: '/never/spawned.js',
    build: { size: 1, mtimeMs: 1 },
    statBuild: () => ({ size: 1, mtimeMs: 1 }),
    cwd: opts.dir,
    execPath: process.execPath,
    platform: 'linux',
    ensureSocketDir: () => {},
    connect: defaultConnect,
    spawn: () => {
      throw new Error('must not spawn: the test daemon owns the socket');
    },
    openLog: () => -1,
    closeFd: () => {},
    mkdirp: () => {},
  });
  const sent: string[] = [];
  const request = connection.request.bind(connection);
  connection.request = (method, params, timeoutMs) => {
    sent.push(method);
    return request(method, params, timeoutMs);
  };
  const services: ISharedServices = {
    mode: 'daemon',
    connection,
    ensure: async () => {
      await connection.ensure();
      return 'daemon';
    },
    close: () => connection.close(),
  };
  return { connection, services, sent };
}
