import type { ReconcileSummary } from './reconcile.js';

/**
 * Backoff for the self-retry after a pass leaves a corpus `unavailable` (or, in
 * the vault entry's loop, times out on the lock): the first retry waits this
 * long, each further one doubles it up to {@link RETRY_MAX_MS}. Without it a
 * vault nobody edits has no way back — the watcher is the only other thing that
 * ever asks for a pass.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 900_000;

/**
 * Why a pass that returned left a corpus nothing in which can rank, or `null`
 * when it did not. `rankable` is how many notes the corpus can rank after the
 * pass.
 *
 * A pass that returns is not a pass that worked. Reconcile is per-note tolerant
 * by design: a rejected `embed` — an offline first run, an unwritable model
 * cache, an ONNX load failure — is counted in `summary.failed` and the pass
 * returns normally. When every note went that way, `ready` would report a
 * broken index as a healthy empty one.
 *
 * All three clauses are load-bearing, and none alone is the guard: an empty
 * corpus also describes an empty vault (`total > 0` rules that out) and a
 * healthy vault whose notes are all below the size gate, which index fine and
 * carry no vector (`failed > 0` rules that out — nothing failed there);
 * `failed > 0` alone also describes a healthy incremental pass that lost one
 * note, whose corpus is not empty, because a failed note keeps the record it
 * already had.
 *
 * Deliberately NOT also requiring `embedded === 0`: a note under `MIN_CHARS`
 * gets no note vector and no qualifying block, so `embedNote` calls `embed`
 * zero times, writes a record that carries no embedding, and still counts as
 * `embedded`. One stub note in a cold vault would therefore keep the guard
 * silent while every real note failed. Callers measure `rankable` afresh on
 * every pass, so the reused stub cannot latch `ready` either; a later pass that
 * embeds anything replaces the `unavailable` state with `ready`.
 */
export function unusableCorpusReason(
  rankable: number,
  summary: Pick<ReconcileSummary, 'total' | 'failed'>,
): string | null {
  if (rankable > 0 || summary.total === 0 || summary.failed === 0) return null;
  return `indexing produced no usable corpus: ${summary.failed} of ${summary.total} notes failed and the decoded corpus is empty (see the per-note warnings above)`;
}
