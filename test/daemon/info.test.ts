import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDaemonInfo, readDaemonInfo, writeDaemonInfo } from '../../src/daemon/info.js';

const info = {
  pid: 42,
  version: '18.0.0',
  socket: '/tmp/neuro-vault-501/abc.sock',
  started_at: '2026-10-14T10:00:00.000Z',
  cli_size: 1000,
  cli_mtime_ms: 1700000000000.5,
};

function withField(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...info, ...patch });
}

function withoutField(key: keyof typeof info): string {
  const copy: Record<string, unknown> = { ...info };
  delete copy[key];
  return JSON.stringify(copy);
}

describe('daemon info file', () => {
  it('round-trips through an injected writer and reader', async () => {
    const writeFile = vi.fn<(p: string, data: string) => Promise<void>>(async () => {});
    await writeDaemonInfo('/s/daemon.json', info, { writeFile });
    const written = writeFile.mock.calls[0][1];
    expect(readDaemonInfo('/s/daemon.json', { readFile: () => written })).toEqual(info);
  });

  it('rejects another layout instead of crashing', () => {
    expect(parseDaemonInfo('{"pid":"42","version":"17.0.0"}')).toBeUndefined();
    expect(parseDaemonInfo('not json')).toBeUndefined();
    expect(parseDaemonInfo('[]')).toBeUndefined();
  });

  it('reads undefined when the file is missing', () => {
    expect(readDaemonInfo('/s/daemon.json', { readFile: () => undefined })).toBeUndefined();
  });

  it('reads undefined when the file lacks cli_size', () => {
    expect(parseDaemonInfo(withoutField('cli_size'))).toBeUndefined();
  });

  it('reads undefined when cli_mtime_ms is not a finite number', () => {
    expect(parseDaemonInfo(withField({ cli_mtime_ms: '1700000000000' }))).toBeUndefined();
    expect(parseDaemonInfo(withField({ cli_mtime_ms: null }))).toBeUndefined();
    // JSON.parse turns 1e999 into Infinity, which must not pass as a finite number.
    expect(
      parseDaemonInfo(JSON.stringify(info).replace('1700000000000.5', '1e999')),
    ).toBeUndefined();
  });

  it('reads undefined when pid is not a positive integer', () => {
    expect(parseDaemonInfo(withField({ pid: 0 }))).toBeUndefined();
    expect(parseDaemonInfo(withField({ pid: 1.5 }))).toBeUndefined();
  });

  it('reads undefined when the file lacks socket', () => {
    expect(parseDaemonInfo(withoutField('socket'))).toBeUndefined();
  });
});

describe('daemon info file on the real filesystem', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nv-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically and reads back the same info', async () => {
    const file = path.join(dir, 'daemon.json');
    await writeDaemonInfo(file, info);
    expect(readDaemonInfo(file)).toEqual(info);
  });
});
