import { EmbeddingService } from './embedding-service.js';
import type { LocalModelLoader } from './local-model-loader.js';
import type { ModelProfile } from './model-profiles.js';
import type { EmbeddingProvider } from './types.js';

export interface ProviderFactoryOptions {
  profile: ModelProfile;
  /** false: load the model in this process (also what the daemon itself does). */
  shared: boolean;
  /** Absolute path of the running CLI script; the daemon is spawned from it. */
  cliPath?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  stderr?: { write(chunk: string): boolean };
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

/**
 * The one place a provider is chosen for a profile: the server, `index` and
 * the daemon's embed service all come through here (design D7). A remote
 * provider is a later profile kind handled in this same switch.
 */
export function createEmbeddingProvider(opts: ProviderFactoryOptions): EmbeddingProvider {
  if (!opts.shared) return new EmbeddingService({ profile: opts.profile, loader: opts.loader });
  throw new Error('shared provider not implemented yet');
}
