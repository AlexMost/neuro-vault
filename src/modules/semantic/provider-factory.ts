import type { ModelProfile } from '../../lib/model-profiles.js';

import { DaemonEmbeddingProvider } from './daemon-embedding-provider.js';
import { EmbeddingService, LOCAL_MAX_BATCH_SIZE } from './embedding-service.js';
import type { LocalModelLoader } from './local-model-loader.js';
import {
  createSharedServices,
  type ISharedServices,
  type SharedServicesOptions,
} from './shared-services.js';
import type { EmbeddingProvider } from './types.js';

export interface ProviderFactoryOptions extends SharedServicesOptions {
  profile: ModelProfile;
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

/**
 * The one place a provider is chosen for a profile: the server, `index` and
 * the daemon's embed service all come through here (design D7). A remote
 * provider is a later profile kind handled in this same switch.
 *
 * A shared process passes the `services` it built once (design D11), so the
 * embedding provider and the corpus reads use one connection and one switch;
 * without them `opts` builds a set for this provider alone. With `shared`
 * unset or the switch already on `local` the result is the in-process
 * provider; otherwise it is the daemon facade over the lazy connection:
 * nothing is probed, spawned or created until the first call, and the
 * in-process fallback is built only if that call finds the daemon unavailable.
 */
export function createEmbeddingProvider(
  opts: ProviderFactoryOptions,
  services: ISharedServices = createSharedServices(opts),
): EmbeddingProvider {
  const local = (): EmbeddingProvider =>
    new EmbeddingService({ profile: opts.profile, loader: opts.loader });
  if (services.mode === 'local') return local();
  return new DaemonEmbeddingProvider({
    profile: opts.profile,
    services,
    createFallback: local,
    initialMaxBatchSize: LOCAL_MAX_BATCH_SIZE,
  });
}
