import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultDaemonFs } from '../../src/daemon/admin.js';
import {
  ensurePrivateSocketDir,
  type DirStat,
  type SocketDirFs,
} from '../../src/daemon/socket-dir.js';

const DIR = '/tmp/neuro-vault-501';

function stat(over: Partial<{ dir: boolean; link: boolean; uid: number }> = {}): DirStat {
  const { dir = true, link = false, uid = 501 } = over;
  return { isDirectory: () => dir, isSymbolicLink: () => link, uid };
}

function fakeFs(found: DirStat | Error, over: Partial<SocketDirFs> = {}) {
  const calls: string[] = [];
  const fs: SocketDirFs = {
    mkdirp: vi.fn((d: string) => void calls.push(`mkdirp ${d}`)),
    lstat: vi.fn((p: string) => {
      calls.push(`lstat ${p}`);
      if (found instanceof Error) throw found;
      return found;
    }),
    chmod: vi.fn((p: string, mode: number) => void calls.push(`chmod ${p} ${mode.toString(8)}`)),
    ...over,
  };
  return { fs, calls };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('ensurePrivateSocketDir', () => {
  it('creates the directory, checks it is ours and tightens it to 0700', () => {
    const { fs, calls } = fakeFs(stat());
    ensurePrivateSocketDir(DIR, { fs, uid: 501 });
    expect(calls).toEqual([`mkdirp ${DIR}`, `lstat ${DIR}`, `chmod ${DIR} 700`]);
  });

  it('refuses a symlink, naming the path', () => {
    const { fs } = fakeFs(stat({ link: true, dir: false }));
    expect(() => ensurePrivateSocketDir(DIR, { fs, uid: 501 })).toThrow(`${DIR} is a symlink`);
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it('refuses a directory owned by another uid, naming the owner', () => {
    const { fs } = fakeFs(stat({ uid: 666 }));
    expect(() => ensurePrivateSocketDir(DIR, { fs, uid: 501 })).toThrow(
      `${DIR} is owned by uid 666`,
    );
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it('refuses something that is not a directory', () => {
    const { fs } = fakeFs(stat({ dir: false }), {
      mkdirp: () => {
        throw errno('EEXIST');
      },
    });
    expect(() => ensurePrivateSocketDir(DIR, { fs, uid: 501 })).toThrow(
      `${DIR} is not a directory`,
    );
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it('names the path when chmod fails', () => {
    const { fs } = fakeFs(stat(), {
      chmod: () => {
        throw errno('EPERM');
      },
    });
    expect(() => ensurePrivateSocketDir(DIR, { fs, uid: 501 })).toThrow(
      new RegExp(`${DIR}.*EPERM`),
    );
  });

  it('rethrows the mkdir error when nothing is there to inspect', () => {
    const { fs } = fakeFs(errno('ENOENT'), {
      mkdirp: () => {
        throw errno('EACCES');
      },
    });
    expect(() => ensurePrivateSocketDir(DIR, { fs, uid: 501 })).toThrow('EACCES');
  });
});

describe.skipIf(process.platform === 'win32')('ensurePrivateSocketDir (real fs)', () => {
  let root: string;
  const uid = process.getuid!();
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/nv-dir-');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a fresh directory 0700 and tightens a looser one', () => {
    const dir = path.join(root, 'sock');
    ensurePrivateSocketDir(dir, { fs: defaultDaemonFs(), uid });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    ensurePrivateSocketDir(dir, { fs: defaultDaemonFs(), uid });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlink to a directory and leaves the target alone', () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target, { mode: 0o755 });
    const dir = path.join(root, 'sock');
    fs.symlinkSync(target, dir);
    expect(() => ensurePrivateSocketDir(dir, { fs: defaultDaemonFs(), uid })).toThrow(
      `${dir} is a symlink`,
    );
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it('refuses a dangling symlink and a regular file', () => {
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'nowhere'), dangling);
    expect(() => ensurePrivateSocketDir(dangling, { fs: defaultDaemonFs(), uid })).toThrow(
      `${dangling} is a symlink`,
    );
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'x');
    expect(() => ensurePrivateSocketDir(file, { fs: defaultDaemonFs(), uid })).toThrow(
      `${file} is not a directory`,
    );
  });
});
