import type { BasenameIndex } from './link-resolver.js';
import type { SmartSource } from './corpus/types.js';

/** What every semantic tool ranks against: notes keyed by vault-relative path. */
export interface CorpusSnapshot {
  sources: Map<string, SmartSource>;
  basenameIndex: BasenameIndex;
}

/**
 * `disabled` is deliberate (the vault turned semantics off); `unavailable` is
 * broken. Never report a failure as `disabled`.
 */
export type BackendState = 'ready' | 'indexing' | 'disabled' | 'unavailable';

export interface BackendStatus {
  state: BackendState;
  /** Present exactly while `state === 'indexing'`. 0/0 until the scan lands. */
  indexed?: number;
  total?: number;
  /** Present for `unavailable`: why the corpus could not be served. */
  reason?: string;
}

/**
 * One backend per vault entry, read by all three semantic tools of that vault.
 * `snapshot()` is what ranking consumes; `status()` is what the contract
 * surfaces report; `dispose()` releases background resources at shutdown.
 */
export interface SemanticBackend {
  snapshot(): Promise<CorpusSnapshot>;
  status(): BackendStatus;
  dispose(): Promise<void>;
}
