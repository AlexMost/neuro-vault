/**
 * Per-connection setup that runs once per epoch (the vault attach, and the
 * embedding handshake after it): the daemon forgets a session's setup when the
 * connection drops, so each reconnect (a new epoch) must run it again.
 */
export interface IEpochGate {
  /** `true` once a run committed on the current epoch (and not forgotten since). */
  readonly done: boolean;
  /** `true` while a run started on the current epoch is in flight. */
  readonly running: boolean;
  /**
   * Resolves once a run on the epoch it was called on has settled — at once when already done.
   * Does not retry across epochs: an answer from a replaced epoch resolves with `done` still
   * false, and the caller decides whether to ask again. Rejects as the run does.
   */
  pass(): Promise<void>;
  /** Forget that setup ran so the next pass() runs again (after the daemon lost it). */
  forget(): void;
}

interface IInFlight {
  epoch: number;
  answer: Promise<void>;
}

/**
 * Concurrent passes on one epoch share a single run. `commit` takes the run's
 * value only when the epoch at settle is the one the run started on — an answer
 * from a connection already replaced records nothing on the new one. A run in
 * flight on an older epoch never blocks a pass on the new one. A failed run
 * leaves the gate undone, so the next pass runs again.
 */
export function createEpochGate<T>(
  link: { readonly epoch: number },
  run: () => Promise<T>,
  commit: (value: T) => void,
): IEpochGate {
  let doneEpoch = -1;
  let inFlight: IInFlight | undefined;

  return {
    get done() {
      return doneEpoch === link.epoch;
    },
    get running() {
      return inFlight?.epoch === link.epoch;
    },
    pass() {
      const epoch = link.epoch;
      if (doneEpoch === epoch) return Promise.resolve();
      if (inFlight?.epoch === epoch) return inFlight.answer;
      const answer: Promise<void> = run()
        .then((value) => {
          if (epoch === link.epoch) {
            commit(value);
            doneEpoch = epoch;
          }
        })
        .finally(() => {
          if (inFlight?.answer === answer) inFlight = undefined;
        });
      inFlight = { epoch, answer };
      return answer;
    },
    forget() {
      doneEpoch = -1;
    },
  };
}
