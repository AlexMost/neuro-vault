import { describe, expect, it } from 'vitest';
import { cliBuild, daemonKey, daemonPaths } from '../../src/daemon/paths.js';

const build = { size: 1000, mtimeMs: 1_700_000_000_000 };

describe('daemonKey', () => {
  it('is 12 hex chars and deterministic per version and build', () => {
    expect(daemonKey('18.0.0', build)).toMatch(/^[0-9a-f]{12}$/);
    expect(daemonKey('18.0.0', build)).toBe(daemonKey('18.0.0', { ...build }));
    expect(daemonKey('18.0.0', build)).not.toBe(daemonKey('18.0.1', build));
  });
  it('differs for the same version when the build differs', () => {
    const base = daemonKey('18.0.0', build);
    expect(daemonKey('18.0.0', { ...build, size: 1001 })).not.toBe(base);
    expect(daemonKey('18.0.0', { ...build, mtimeMs: build.mtimeMs + 1 })).not.toBe(base);
  });
});

describe('cliBuild', () => {
  it('returns size and mtimeMs from the injected stat', () => {
    const seen: string[] = [];
    const stat = (p: string) => {
      seen.push(p);
      return { size: 42, mtimeMs: 7.5, extra: true };
    };
    expect(cliBuild('/opt/cli.js', stat)).toEqual({ size: 42, mtimeMs: 7.5 });
    expect(seen).toEqual(['/opt/cli.js']);
  });
});

describe('daemonPaths', () => {
  const base = { version: '18.0.0', build, uid: 501, cacheBase: '/home/u/.cache/neuro-vault' };
  it('puts the POSIX socket under /tmp, short and build-keyed', () => {
    const p = daemonPaths({ ...base, platform: 'darwin' });
    const key = daemonKey('18.0.0', build);
    expect(p.key).toBe(key);
    expect(p.socketPath).toBe(`/tmp/neuro-vault-501/${key}.sock`);
    expect(Buffer.byteLength(p.socketPath)).toBeLessThan(100);
    expect(p.stateDir).toBe(`/home/u/.cache/neuro-vault/daemons/${key}`);
    expect(p.infoFile).toBe(`${p.stateDir}/daemon.json`);
    expect(p.logFile).toBe(`${p.stateDir}/daemon.log`);
    expect(p.lockFile).toBe(`${p.stateDir}/daemon.lock`);
  });
  it('uses a named pipe on Windows', () => {
    const p = daemonPaths({ ...base, platform: 'win32' });
    expect(p.socketPath).toBe(`\\\\.\\pipe\\neuro-vault-501-${daemonKey('18.0.0', build)}`);
  });
});
