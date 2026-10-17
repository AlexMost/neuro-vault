import type { ICorpusReader } from './corpus/corpus.js';

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
 * One backend per vault entry, read by all three semantic tools of that vault
 * (design D12): the corpus's two reads, the vault's status, and `dispose()`
 * for shutdown. It never exposes the corpus's vectors — with the shared
 * daemon they never leave it, and in the in-process fallback they stay in the
 * vault entry.
 */
export interface ISemanticBackend extends ICorpusReader {
  /** Never rejects: a status that cannot be read is `unavailable` with the reason. */
  status(): Promise<BackendStatus>;
  dispose(): Promise<void>;
}

/**
 * A read refused because the corpus cannot serve yet (the daemon's
 * `CORPUS_NOT_READY`, or the same check in-process). Callers report it the way
 * the readiness gate reports `status`.
 */
export class CorpusNotReadyError extends Error {
  constructor(
    readonly status: BackendStatus,
    message = `the corpus is ${status.state}`,
  ) {
    super(message);
    this.name = 'CorpusNotReadyError';
  }
}
