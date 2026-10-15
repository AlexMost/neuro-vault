import type { DaemonInfoResult, ServiceHandlers } from '../protocol.js';

export interface DaemonServiceDeps {
  name: string;
  version: string;
  pid: number;
  startedAt: string;
  idleTimeoutMin: number;
  clients: () => number;
  embedLoaded: () => string[];
  /** Deferred by the caller so the shutdown response is written first. */
  requestShutdown: () => void;
}

export function createDaemonService(deps: DaemonServiceDeps): ServiceHandlers {
  return {
    info: (): Promise<DaemonInfoResult> =>
      Promise.resolve({
        name: deps.name,
        version: deps.version,
        pid: deps.pid,
        started_at: deps.startedAt,
        idle_timeout_min: deps.idleTimeoutMin,
        clients: deps.clients(),
        services: { embed: { loaded: deps.embedLoaded() } },
      }),
    shutdown: () => {
      deps.requestShutdown();
      return Promise.resolve({});
    },
  };
}
