import { EmbeddingService } from './embedding-service.js';
import type { ModelProfile } from '../../lib/model-profiles.js';
import {
  buildLexicalOnlyTools,
  buildSemanticTools,
  type ISemanticToolDeps,
} from './tools/index.js';
import type { QueryEmbedder } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { IVaultRegistry } from '../../lib/vault-registry.js';

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
