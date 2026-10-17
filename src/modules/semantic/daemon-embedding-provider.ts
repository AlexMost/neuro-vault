import type {
  EmbedDocumentsResult,
  EmbedInitializeResult,
  EmbedQueryResult,
} from '../../daemon/protocol.js';
import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

import type { ISharedServices } from './shared-services.js';
import { identityOf, type ModelProfile } from '../../lib/model-profiles.js';
import type { EmbeddingProvider } from './types.js';

export const REQUEST_TIMEOUTS = {
  /** The first load downloads the weights: minutes, not seconds. */
  initialize: 900_000,
  query: 60_000,
  documents: 300_000,
} as const;

/** What the facades need from a connection — `DaemonConnection` in production. */
export interface DaemonLink {
  /** Changes on every new connection; `embed.initialize` is re-sent once per value. */
  readonly epoch: number;
  /** Connect (spawning the daemon if needed); `DaemonUnavailableError` when that fails. */
  ensure(): Promise<void>;
  /** Drop the connection, rejecting what is pending on it; the next `ensure()` reconnects. */
  close(): void;
  /** One request on the current connection; never connects. */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

export interface DaemonEmbeddingProviderDeps {
  profile: ModelProfile;
  /** The process's connection and one-way switch, shared with the corpus reads. */
  services: ISharedServices;
  /** The in-process provider, built only if the daemon is unavailable. */
  createFallback: () => EmbeddingProvider;
  /** `maxBatchSize` until the daemon reports its own. */
  initialMaxBatchSize: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * `EmbeddingProvider` over the shared daemon (design D6). The identity is
 * computed locally: the daemon is keyed by this very build, so it runs this
 * same code and its vectors are ours. The batch size is the daemon's to report
 * (a later remote-backed profile has its own limits), so it is read from
 * `embed.initialize`.
 *
 * `embed.initialize` goes out first on every new connection, whatever the
 * call: it makes the connection one of the daemon's clients at once (which
 * holds off its idle exit), loads the profile, and refreshes the batch size.
 *
 * Fallback is the services' one-way switch per process (design D11). Once the
 * daemon could not be located or started, `services.ensure()` answers `local`
 * for the rest of the process's life — it has said so in one stderr line and
 * never touches the connection again — and this facade embeds through its own
 * in-process provider, built on first use. A daemon that answers with an error
 * — `EMBED_FAILED` for a model that will not load, a timeout, a dropped
 * connection — is *not* that case: the error reaches the caller like a local
 * load failure would, and the next call goes through the daemon again.
 */
export class DaemonEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  private daemonBatchSize: number;
  private fallback?: EmbeddingProvider;
  private handshakeEpoch = -1;
  private handshaking?: Promise<void>;

  constructor(private readonly deps: DaemonEmbeddingProviderDeps) {
    this.identity = identityOf(deps.profile);
    this.daemonBatchSize = deps.initialMaxBatchSize;
  }

  get maxBatchSize(): number {
    return this.fallback?.maxBatchSize ?? this.daemonBatchSize;
  }

  async initialize(): Promise<void> {
    await this.run(
      async () => {},
      (p) => p.initialize(),
    );
  }

  embedQuery(text: string): Promise<number[]> {
    return this.run(
      async () => {
        const { vector } = await this.deps.services.connection.request<EmbedQueryResult>(
          'embed.query',
          { profile: this.deps.profile.key, text },
          REQUEST_TIMEOUTS.query,
        );
        if (!Array.isArray(vector)) throw new Error('daemon answered embed.query without a vector');
        return vector;
      },
      (p) => p.embedQuery(text),
    );
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.run(
      async () => {
        // The caller bucketed by the batch size it saw; the handshake may have
        // just lowered it, so chunk to what the daemon accepts.
        const vectors: number[][] = [];
        for (let start = 0; start < texts.length; ) {
          const chunk = texts.slice(start, start + this.daemonBatchSize);
          start += chunk.length;
          const result = await this.deps.services.connection.request<EmbedDocumentsResult>(
            'embed.documents',
            { profile: this.deps.profile.key, texts: chunk },
            REQUEST_TIMEOUTS.documents,
          );
          if (!Array.isArray(result.vectors) || result.vectors.length !== chunk.length) {
            throw new Error(
              `daemon answered embed.documents with ${String(result.vectors?.length)} vectors ` +
                `for ${chunk.length} texts`,
            );
          }
          vectors.push(...result.vectors);
        }
        return vectors;
      },
      (p) => p.embedDocuments(texts),
    );
  }

  private async run<T>(
    viaDaemon: () => Promise<T>,
    viaFallback: (provider: EmbeddingProvider) => Promise<T>,
  ): Promise<T> {
    if (this.fallback) return viaFallback(this.fallback);
    // The switch is the services': it flips once for every facade of the process.
    if ((await this.deps.services.ensure()) === 'local') return viaFallback(this.localProvider());
    await this.handshake();
    return viaDaemon();
  }

  /** `embed.initialize` once per connection; concurrent callers share it. */
  private handshake(): Promise<void> {
    const epoch = this.deps.services.connection.epoch;
    if (this.handshakeEpoch === epoch) return Promise.resolve();
    this.handshaking ??= this.deps.services.connection
      .request<EmbedInitializeResult>(
        'embed.initialize',
        { profile: this.deps.profile.key },
        REQUEST_TIMEOUTS.initialize,
      )
      .then((result) => {
        if (isPositiveInteger(result.max_batch_size)) this.daemonBatchSize = result.max_batch_size;
        this.handshakeEpoch = epoch;
      })
      .finally(() => {
        this.handshaking = undefined;
      });
    return this.handshaking;
  }

  private localProvider(): EmbeddingProvider {
    this.fallback ??= this.deps.createFallback();
    return this.fallback;
  }
}
