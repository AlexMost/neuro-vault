import { EmbeddingService } from './embedding-service.js';
import type { ModelProfile } from '../../lib/model-profiles.js';
import {
  buildLexicalOnlyTools,
  buildSemanticTools,
  type ISemanticToolDeps,
} from './tools/index.js';
import type { QueryEmbedder } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import { WikilinkGraphIndex } from '../../lib/obsidian/wikilink-graph.js';
import type { VaultReader } from '../../lib/obsidian/vault-reader.js';
import type { IRegisteredVaultDeps, IVaultRegistry } from '../../lib/vault-registry.js';
import { createStandaloneGraphReader } from './graph/index.js';
import { createStandaloneLexicalReader } from './lexical/index.js';

// What the composition root builds a session's semantic side from (ADR-0022):
// the process's daemon connection, the embedding provider and its queue, and
// the vault clients whose views are each vault's backend and lexical reader.
export {
  createSharedServices,
  SharedServicesClosedError,
  type ISharedServices,
} from './shared-services.js';
export { createEmbeddingProvider } from './provider-factory.js';
export { createQueuedEmbedder } from './embed-queue.js';
export { createVaultClients, type IVaultClients } from './vault-client/index.js';
export type { EmbeddingProvider } from './types.js';

export interface ISemanticModuleConfig {
  profile: ModelProfile;
}

export interface ISemanticModuleDeps {
  embeddingServiceFactory?: (profile: ModelProfile) => QueryEmbedder;
}

export interface ISemanticModule {
  tools: ToolRegistration[];
  warmup: () => Promise<void>;
}

export function createSemanticModule(
  registry: IVaultRegistry,
  config: ISemanticModuleConfig,
  deps: ISemanticModuleDeps = {},
): ISemanticModule {
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ?? ((profile: ModelProfile) => new EmbeddingService({ profile }));
  const embeddingService = embeddingServiceFactory(config.profile);

  const semanticDeps: ISemanticToolDeps = {
    registry,
    embeddingProvider: embeddingService,
    modelKey: config.profile.key,
    similarity: config.profile.similarity,
  };
  return {
    tools: buildSemanticTools(semanticDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}

/**
 * What the semantic module contributes when it is off (`--no-semantic`): only
 * `search_notes`, answering from its lexical leg. The tools with no
 * non-semantic leg (`get_similar_notes`, `find_duplicates`) stay unregistered.
 */
export function createLexicalOnlyTools(
  registry: IVaultRegistry,
  config: ISemanticModuleConfig,
): ToolRegistration[] {
  return buildLexicalOnlyTools(registry, config.profile);
}

/**
 * The vault factories of a `--no-semantic` session (brainstorm F1): no vault
 * clients, so nothing attaches and no daemon starts. Every vault's lexical leg
 * is the session's own cache over its reader, and its graph the session's own
 * `WikilinkGraphIndex` — one per vault root, built on the first factory call
 * for it, read by the graph reader and the lexical tie-break alike (design D5).
 * The registry builds no backend when `semanticEnabled` is false, so the
 * semantic factory is never called.
 */
export function createLexicalOnlyVaultFactories(): Pick<
  IRegisteredVaultDeps,
  'semanticBackendFactory' | 'lexicalReaderFactory' | 'graphFactory'
> {
  const graphs = new Map<string, WikilinkGraphIndex>();
  const graphOf = (vaultRoot: string, reader: VaultReader): WikilinkGraphIndex => {
    let graph = graphs.get(vaultRoot);
    if (graph === undefined) {
      graph = new WikilinkGraphIndex({ reader });
      graphs.set(vaultRoot, graph);
    }
    return graph;
  };
  return {
    semanticBackendFactory: () => {
      throw new Error('no semantic backend is built under --no-semantic');
    },
    lexicalReaderFactory: ({ vaultRoot, reader }) =>
      createStandaloneLexicalReader({ vaultRoot, reader, graph: graphOf(vaultRoot, reader) }),
    graphFactory: ({ vaultRoot, reader }) =>
      createStandaloneGraphReader(graphOf(vaultRoot, reader)),
  };
}
