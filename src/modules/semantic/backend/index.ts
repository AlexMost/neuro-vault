import {
  CorpusNotReadyError,
  type BackendStatus,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';

/**
 * The backend of a vault whose config sets `"semantic": false`: it never
 * attaches by itself. The vault's lexical reader attaches it with no profile,
 * so neither the daemon nor this process indexes it.
 */
export function createDisabledSemanticBackend(): ISemanticBackend {
  const status: BackendStatus = { state: 'disabled' };
  const refuse = (): Promise<never> => Promise.reject(new CorpusNotReadyError(status));
  return {
    status: () => Promise.resolve(status),
    nearest: refuse,
    nearestBlocks: refuse,
    dispose: () => Promise.resolve(),
  };
}
