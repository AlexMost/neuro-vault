import { describe, expect, it, vi } from 'vitest';

import { createEpochGate } from '../../../src/modules/semantic/vault-client/epoch-gate.js';

interface IDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): IDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A gate over a mutable link whose `run` hands out one deferred per call. */
function setup() {
  const link = { epoch: 1 };
  const runs: IDeferred<string>[] = [];
  const run = vi.fn(() => {
    const d = deferred<string>();
    runs.push(d);
    return d.promise;
  });
  const commit = vi.fn<(value: string) => void>();
  const gate = createEpochGate(link, run, commit);
  return { link, runs, run, commit, gate };
}

describe('createEpochGate', () => {
  it('runs once per epoch and shares concurrent callers', async () => {
    const { runs, run, commit, gate } = setup();
    const a = gate.pass();
    const b = gate.pass();
    expect(run).toHaveBeenCalledTimes(1);
    runs[0]?.resolve('v');
    await Promise.all([a, b]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('v');
    expect(gate.done).toBe(true);
    await gate.pass();
    expect(run).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('a new epoch runs again', async () => {
    const { link, runs, run, gate } = setup();
    const first = gate.pass();
    runs[0]?.resolve('one');
    await first;
    expect(gate.done).toBe(true);
    link.epoch = 2;
    expect(gate.done).toBe(false);
    const second = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1]?.resolve('two');
    await second;
    expect(gate.done).toBe(true);
  });

  it('a run that settles on a replaced epoch commits nothing', async () => {
    const { link, runs, commit, gate } = setup();
    const pass = gate.pass();
    link.epoch = 2;
    runs[0]?.resolve('stale');
    await pass;
    expect(commit).not.toHaveBeenCalled();
    expect(gate.done).toBe(false);
  });

  it('a run in flight on an older epoch does not block a pass on the new one', async () => {
    const { link, runs, run, commit, gate } = setup();
    const old = gate.pass();
    link.epoch = 2;
    const fresh = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1]?.resolve('new');
    await fresh;
    runs[0]?.resolve('old');
    await old;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('new');
    expect(gate.done).toBe(true);
  });

  it('an older run settling after a newer run started leaves the newer slot in place', async () => {
    const { link, runs, run, gate } = setup();
    const old = gate.pass();
    link.epoch = 2;
    const fresh = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[0]?.resolve('old');
    await old;
    expect(gate.running).toBe(true);
    const joined = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1]?.resolve('new');
    await Promise.all([fresh, joined]);
    expect(gate.done).toBe(true);
    expect(gate.running).toBe(false);
  });

  it('a rejected run leaves it undone and the next pass runs again', async () => {
    const { runs, run, gate } = setup();
    const failed = gate.pass();
    runs[0]?.reject(new Error('refused'));
    await expect(failed).rejects.toThrow('refused');
    expect(gate.done).toBe(false);
    expect(gate.running).toBe(false);
    const retry = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1]?.resolve('ok');
    await retry;
    expect(gate.done).toBe(true);
  });

  it('forget makes the next pass run again', async () => {
    const { runs, run, gate } = setup();
    const first = gate.pass();
    runs[0]?.resolve('one');
    await first;
    gate.forget();
    expect(gate.done).toBe(false);
    const second = gate.pass();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1]?.resolve('two');
    await second;
    expect(gate.done).toBe(true);
  });

  it('running is true only while a run is in flight on the current epoch', async () => {
    const { link, runs, gate } = setup();
    expect(gate.running).toBe(false);
    const pass = gate.pass();
    expect(gate.running).toBe(true);
    runs[0]?.resolve('v');
    await pass;
    expect(gate.running).toBe(false);

    link.epoch = 2;
    const moved = gate.pass();
    expect(gate.running).toBe(true);
    link.epoch = 3;
    expect(gate.running).toBe(false);
    runs[1]?.resolve('late');
    await moved;
    expect(gate.running).toBe(false);
  });
});
