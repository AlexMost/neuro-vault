import { registerTool } from '../../../lib/tool-registry.js';
import type { ToolRegistration } from '../../../lib/tool-registration.js';
import type { ModelProfile, SimilarityDefaults } from '../../../lib/model-profiles.js';
import type { QueryEmbedder, SearchEngine } from '../types.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { buildFindDuplicatesTool } from './find-duplicates.js';
import { buildGetSimilarNotesTool } from './get-similar-notes.js';
import { buildSearchNotesTool } from './search-notes.js';

export interface ISemanticToolDeps {
  registry: IVaultRegistry;
  embeddingProvider: QueryEmbedder;
  searchEngine: SearchEngine;
  modelKey: string;
  /** The active model profile's default thresholds. */
  similarity: SimilarityDefaults;
}

export function buildSemanticTools(deps: ISemanticToolDeps): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
  ];
}

/**
 * `search_notes` for a server started with `--no-semantic`: its lexical leg
 * needs no embedding corpus, so it stays registered. No vault has a backend
 * then, so every response reports `semantic_status: { state: "disabled" }` and
 * the semantic leg never runs. The embedder below is a tripwire — the handler
 * gates the semantic leg on the backend, so reaching it would be a bug — and
 * the registry's `modelKey`/`similarity` only feed wording and thresholds the
 * lexical leg never reads.
 */
export function buildLexicalOnlyTools(
  registry: IVaultRegistry,
  profile: ModelProfile,
): ToolRegistration[] {
  return [
    registerTool(
      buildSearchNotesTool({
        registry,
        embeddingProvider: {
          initialize: async () => {},
          embedQuery: () =>
            Promise.reject(new Error('the semantic module is disabled; nothing can be embedded')),
        },
        modelKey: profile.key,
        similarity: profile.similarity,
      }),
    ),
  ];
}
