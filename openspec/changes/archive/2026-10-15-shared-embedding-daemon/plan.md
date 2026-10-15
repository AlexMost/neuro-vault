# Shared embedding daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load each embedding model once per machine: a shared-services daemon over a unix socket hosts the model, and the session's `EmbeddingProvider` becomes a facade onto it, with today's in-process provider as the fallback and `--no-shared` as the opt-out.

**Architecture:** `src/daemon/` holds the daemon's lifecycle (version-keyed paths, lock, stale-socket probe, info file), a JSON-RPC 2.0 service registry framed with the MCP SDK's `ReadBuffer`/`serializeMessage`, an `embed` service that builds one provider per profile through the shared provider factory, and a `net` socket server with an idle timer. `src/modules/semantic/` gains `DaemonConnection` (locate / spawn / poll / request with timeouts), `DaemonEmbeddingProvider` (the facade, falling back once) and `provider-factory.ts`, which `server.ts`, `cli-index.ts` and the daemon all call. Nothing MCP-level changes.

**Tech Stack:** TypeScript (ESM, strict, `tsc --noEmit` is the gate), Node ≥ 20.9 (`node:net`, `node:child_process`, `node:crypto`, `node:fs`), `@modelcontextprotocol/sdk` 1.29 (`shared/stdio.js`, `types.js`), `write-file-atomic`, `yargs`, vitest.

**Spec:** `openspec/changes/shared-embedding-daemon/` — `design.md` (D1–D9), `specs/shared-services-daemon/spec.md`, `specs/daemon-embedding-provider/spec.md`, `specs/cli-startup-flags/spec.md`, `specs/semantic-backend-lifecycle/spec.md`, `specs/embedding-model-profiles/spec.md`. Read `design.md` first; the specs are the acceptance.

## Global Constraints

- `npm test && npm run lint && npm run typecheck && npm run build` green before every commit; the test count never drops.
- No new runtime dependency. No `exec` with a shell string: every child process is `spawn(file, args[])` (ADR-0004).
- Nothing in `src/` writes to stdout except the MCP transport and the `index`/`daemon status` reports named in the specs; diagnostics go to stderr.
- No tool parameter is added or renamed; no change to `openspec/specs/mcp-tool-surface` or the parameter dictionary.
- Every new module takes its I/O through an injected `deps` object (fs, connect, spawn, timers, exit, streams) with production defaults; tests inject fakes, never module-level mocks.
- POSIX socket path < 100 bytes: `/tmp/neuro-vault-<uid>/<12 hex>.sock`. Socket file `0600`, its directory `0700`. State under `<cache>/neuro-vault/daemons/<key>/` with `<cache>` = `$XDG_CACHE_HOME` if absolute else `~/.cache`.
- Daemon key = first 12 hex chars of `sha256("v1:" + packageVersion + ":" + cliSize + ":" + cliMtimeMs)` (size and mtime from `fs.statSync(cliPath)`), so a rebuilt dev install gets a new daemon. `daemonKey(version, build: { size: number; mtimeMs: number })`; Task 1's tests add: a different `build` gives a different key; `daemonPaths` takes `build` too and the facade/daemon pass it from `statSync(cliPath)`.
- Request timeouts: `embed.initialize` 15 min, `embed.query` 60 s, `embed.documents` 5 min. Spawn-and-poll: every 50 ms, 10 s total. Stop deadline 5 s. Default idle timeout 30 min.
- Conventional Commits; body lines ≤ 100 chars; one `Co-Authored-By:` trailer naming the session's primary model. PR 1 `Refs #145`, PR 2 `Closes #145`.

## Review Focus

Inputs the specs imply but no scenario spells out; each has a test pinned to the task that owns it:

1. **A `daemon.json` from another layout** (missing `socket`, non-numeric `pid`) must read as "no daemon", never crash `status` or the facade → Task 3 (`readDaemonInfo` rejects it), Task 11 (`status` prints it as `stale` and sweeps it).
2. **A provider that returns a vector with `NaN`/`Infinity`** would serialise as `null` and poison a corpus → Task 6 (the embed service answers `EMBED_FAILED` for a non-finite vector).
3. **Two `embed.initialize` calls for the same profile arriving before the first finished** must build one provider → Task 6 (promise memo per profile).
4. **A text containing newlines or `"`** must survive the line framing both ways → Task 8 (round trip of a text with `\n` and quotes through the real socket).
5. **`daemon.log` cannot be opened** (read-only cache dir) must fall back in-process, not throw out of `embedQuery` → Task 12 (`openLog` throws → `DaemonUnavailableError` → fallback).

---

## PR 1 — the shared-services daemon (`Refs #145`)

### Task 1: Cache base and daemon paths

**Files:**
- Create: `src/lib/cache-dir.ts`
- Modify: `src/modules/semantic/local-model-loader.ts:64-71` (`defaultModelCacheDir` delegates)
- Create: `src/daemon/paths.ts`
- Test: `test/lib/cache-dir.test.ts`, `test/daemon/paths.test.ts`

**Interfaces:**
- Produces: `neuroVaultCacheBase(env?: NodeJS.ProcessEnv, home?: string): string`; `daemonKey(version: string): string`; `daemonPaths(opts: { version: string; uid: number; platform: NodeJS.Platform; cacheBase: string }): DaemonPaths`; `interface DaemonPaths { key: string; socketPath: string; stateDir: string; infoFile: string; logFile: string; lockFile: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/cache-dir.test.ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { neuroVaultCacheBase } from '../../src/lib/cache-dir.js';

describe('neuroVaultCacheBase', () => {
  it('uses an absolute XDG_CACHE_HOME', () => {
    expect(neuroVaultCacheBase({ XDG_CACHE_HOME: '/x/cache' }, '/home/u')).toBe('/x/cache/neuro-vault');
  });
  it('ignores a relative XDG_CACHE_HOME', () => {
    expect(neuroVaultCacheBase({ XDG_CACHE_HOME: 'rel' }, '/home/u')).toBe(path.join('/home/u', '.cache', 'neuro-vault'));
  });
  it('defaults to ~/.cache', () => {
    expect(neuroVaultCacheBase({}, '/home/u')).toBe(path.join('/home/u', '.cache', 'neuro-vault'));
  });
});
```

```ts
// test/daemon/paths.test.ts
import { describe, expect, it } from 'vitest';
import { daemonKey, daemonPaths } from '../../src/daemon/paths.js';

describe('daemonKey', () => {
  it('is 12 hex chars and deterministic per version', () => {
    expect(daemonKey('18.0.0')).toMatch(/^[0-9a-f]{12}$/);
    expect(daemonKey('18.0.0')).toBe(daemonKey('18.0.0'));
    expect(daemonKey('18.0.0')).not.toBe(daemonKey('18.0.1'));
  });
});

describe('daemonPaths', () => {
  const base = { version: '18.0.0', uid: 501, cacheBase: '/home/u/.cache/neuro-vault' };
  it('puts the POSIX socket under /tmp, short and version-keyed', () => {
    const p = daemonPaths({ ...base, platform: 'darwin' });
    const key = daemonKey('18.0.0');
    expect(p.socketPath).toBe(`/tmp/neuro-vault-501/${key}.sock`);
    expect(Buffer.byteLength(p.socketPath)).toBeLessThan(100);
    expect(p.stateDir).toBe(`/home/u/.cache/neuro-vault/daemons/${key}`);
    expect(p.infoFile).toBe(`${p.stateDir}/daemon.json`);
    expect(p.logFile).toBe(`${p.stateDir}/daemon.log`);
    expect(p.lockFile).toBe(`${p.stateDir}/daemon.lock`);
  });
  it('uses a named pipe on Windows', () => {
    const p = daemonPaths({ ...base, platform: 'win32' });
    expect(p.socketPath).toBe(`\\\\.\\pipe\\neuro-vault-501-${daemonKey('18.0.0')}`);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/lib/cache-dir.test.ts test/daemon/paths.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/cache-dir.ts
import os from 'node:os';
import path from 'node:path';

/**
 * `$XDG_CACHE_HOME/neuro-vault`, else `~/.cache/neuro-vault`. A relative
 * `XDG_CACHE_HOME` is ignored, as the XDG spec requires — it would resolve
 * against whatever directory the MCP client launched us from. One rule for
 * the model cache and the daemon state, so they always sit side by side.
 */
export function neuroVaultCacheBase(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
  return path.join(base, 'neuro-vault');
}
```

In `src/modules/semantic/local-model-loader.ts`, replace the body of `defaultModelCacheDir` with:

```ts
export function defaultModelCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(neuroVaultCacheBase(env, home), 'models');
}
```

and add `import { neuroVaultCacheBase } from '../../lib/cache-dir.js';`.

```ts
// src/daemon/paths.ts
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface DaemonPaths {
  key: string;
  socketPath: string;
  stateDir: string;
  infoFile: string;
  logFile: string;
  lockFile: string;
}

/** 12 hex chars of sha256 over a layout tag and the package version: one daemon per installed version. */
export function daemonKey(version: string): string {
  return createHash('sha256').update(`v1:${version}`).digest('hex').slice(0, 12);
}

/**
 * The socket lives under `/tmp`, not `os.tmpdir()`: macOS's per-user tmpdir
 * is 48 bytes long on its own and a unix socket path is capped at 103.
 */
export function daemonPaths(opts: {
  version: string;
  uid: number;
  platform: NodeJS.Platform;
  cacheBase: string;
}): DaemonPaths {
  const key = daemonKey(opts.version);
  const socketPath =
    opts.platform === 'win32'
      ? `\\\\.\\pipe\\neuro-vault-${opts.uid}-${key}`
      : path.posix.join('/tmp', `neuro-vault-${opts.uid}`, `${key}.sock`);
  const stateDir = path.join(opts.cacheBase, 'daemons', key);
  return {
    key,
    socketPath,
    stateDir,
    infoFile: path.join(stateDir, 'daemon.json'),
    logFile: path.join(stateDir, 'daemon.log'),
    lockFile: path.join(stateDir, 'daemon.lock'),
  };
}
```

- [ ] **Step 4: Run the tests and the existing loader tests**

Run: `npx vitest run test/lib/cache-dir.test.ts test/daemon/paths.test.ts test/semantic/local-model-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cache-dir.ts src/daemon/paths.ts src/modules/semantic/local-model-loader.ts test/lib/cache-dir.test.ts test/daemon/paths.test.ts
git commit -m "feat(daemon): version-keyed socket and state paths; one cache-base rule"
```

### Task 2: Lock file

**Files:**
- Create: `src/daemon/lock.ts`
- Test: `test/daemon/lock.test.ts`

**Interfaces:**
- Produces: `interface LockFs { openExclusive(file: string, content: string): boolean /* false on EEXIST */; read(file: string): string | undefined; unlink(file: string): void; mkdirp(dir: string): void }`; `acquireLock(lockFile: string, deps: { pid: number; isAlive: (pid: number) => boolean; fs: LockFs }): { kind: 'acquired' } | { kind: 'held'; pid: number }`; `releaseLock(lockFile: string, fs: LockFs): void`; `defaultLockFs(): LockFs`; `isPidAlive(pid: number): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/lock.test.ts
import { describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, type LockFs } from '../../src/daemon/lock.js';

function memFs(initial: Record<string, string> = {}): LockFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    mkdirp: () => {},
    openExclusive: (file, content) => {
      if (files.has(file)) return false;
      files.set(file, content);
      return true;
    },
    read: (file) => files.get(file),
    unlink: (file) => {
      files.delete(file);
    },
  };
}

describe('acquireLock', () => {
  it('creates the lock with its pid when none exists', () => {
    const fs = memFs();
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => true, fs })).toEqual({ kind: 'acquired' });
    expect(fs.files.get('/s/daemon.lock')).toBe('42');
  });
  it('refuses when the holder is alive', () => {
    const fs = memFs({ '/s/daemon.lock': '7' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: (pid) => pid === 7, fs })).toEqual({ kind: 'held', pid: 7 });
    expect(fs.files.get('/s/daemon.lock')).toBe('7');
  });
  it('replaces a dead holder', () => {
    const fs = memFs({ '/s/daemon.lock': '7' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => false, fs })).toEqual({ kind: 'acquired' });
    expect(fs.files.get('/s/daemon.lock')).toBe('42');
  });
  it('treats an unreadable pid as dead', () => {
    const fs = memFs({ '/s/daemon.lock': 'garbage' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => true, fs })).toEqual({ kind: 'acquired' });
  });
  it('releaseLock removes the file', () => {
    const fs = memFs({ '/s/daemon.lock': '42' });
    releaseLock('/s/daemon.lock', fs);
    expect(fs.files.has('/s/daemon.lock')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/daemon/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/daemon/lock.ts
import fs from 'node:fs';
import path from 'node:path';

export interface LockFs {
  mkdirp(dir: string): void;
  /** Exclusive create (`wx`); false when the file already exists. */
  openExclusive(file: string, content: string): boolean;
  read(file: string): string | undefined;
  unlink(file: string): void;
}

export function defaultLockFs(): LockFs {
  return {
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
    openExclusive: (file, content) => {
      try {
        fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    unlink: (file) => {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

/** `kill(pid, 0)`: EPERM means "exists, not ours" — alive for our purposes. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { kind: 'acquired' } | { kind: 'held'; pid: number };

/**
 * Exclusive-create under the state dir. An existing lock is only ever
 * replaced when its holder is dead; two starters racing on `wx` cannot both
 * win, which is what keeps the stale-socket cleanup (probe.ts) safe.
 */
export function acquireLock(
  lockFile: string,
  deps: { pid: number; isAlive: (pid: number) => boolean; fs: LockFs },
): LockResult {
  deps.fs.mkdirp(path.dirname(lockFile));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (deps.fs.openExclusive(lockFile, String(deps.pid))) return { kind: 'acquired' };
    const holder = Number.parseInt(deps.fs.read(lockFile) ?? '', 10);
    if (Number.isInteger(holder) && holder > 0 && deps.isAlive(holder)) {
      return { kind: 'held', pid: holder };
    }
    deps.fs.unlink(lockFile);
  }
  return { kind: 'held', pid: -1 };
}

export function releaseLock(lockFile: string, lockFs: LockFs): void {
  lockFs.unlink(lockFile);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/daemon/lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/lock.ts test/daemon/lock.test.ts
git commit -m "feat(daemon): pid lock file with dead-holder replacement"
```

### Task 3: Info file

**Files:**
- Create: `src/daemon/info.ts`
- Test: `test/daemon/info.test.ts`

**Interfaces:**
- Produces: `interface DaemonInfo { pid: number; version: string; socket: string; started_at: string }`; `writeDaemonInfo(file: string, info: DaemonInfo, deps?: { writeFile?: (p: string, data: string) => Promise<void> }): Promise<void>`; `readDaemonInfo(file: string, deps?: { readFile?: (p: string) => string | undefined }): DaemonInfo | undefined`; `parseDaemonInfo(raw: string): DaemonInfo | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/info.test.ts
import { describe, expect, it, vi } from 'vitest';
import { parseDaemonInfo, readDaemonInfo, writeDaemonInfo } from '../../src/daemon/info.js';

const info = { pid: 42, version: '18.0.0', socket: '/tmp/neuro-vault-501/abc.sock', started_at: '2026-10-14T10:00:00.000Z' };

describe('daemon info file', () => {
  it('round-trips through an injected writer and reader', async () => {
    const writeFile = vi.fn(async () => {});
    await writeDaemonInfo('/s/daemon.json', info, { writeFile });
    const written = writeFile.mock.calls[0]![1] as string;
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
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/daemon/info.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/info.ts
import fs from 'node:fs';
import writeFileAtomic from 'write-file-atomic';

export interface DaemonInfo {
  pid: number;
  version: string;
  socket: string;
  started_at: string;
}

export function parseDaemonInfo(raw: string): DaemonInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (
    typeof o.pid !== 'number' ||
    !Number.isInteger(o.pid) ||
    typeof o.version !== 'string' ||
    typeof o.socket !== 'string' ||
    typeof o.started_at !== 'string'
  ) {
    return undefined;
  }
  return { pid: o.pid, version: o.version, socket: o.socket, started_at: o.started_at };
}

export function readDaemonInfo(
  file: string,
  deps: { readFile?: (p: string) => string | undefined } = {},
): DaemonInfo | undefined {
  const readFile =
    deps.readFile ??
    ((p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    });
  const raw = readFile(file);
  return raw === undefined ? undefined : parseDaemonInfo(raw);
}

/** Atomic (temp + rename): a reader never sees a half-written file. */
export async function writeDaemonInfo(
  file: string,
  info: DaemonInfo,
  deps: { writeFile?: (p: string, data: string) => Promise<void> } = {},
): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, data: string) => writeFileAtomic(p, data));
  await writeFile(file, JSON.stringify(info, null, 2) + '\n');
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/daemon/info.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/info.ts test/daemon/info.test.ts
git commit -m "feat(daemon): atomic daemon.json with a tolerant reader"
```

### Task 4: Socket probe and stale cleanup

**Files:**
- Create: `src/daemon/probe.ts`
- Test: `test/daemon/probe.test.ts`

**Interfaces:**
- Produces: `type ProbeResult = 'listening' | 'refused' | 'absent'`; `type SocketConnect = (path: string) => Promise<Duplex>` (rejects with an errno error); `probeSocket(path: string, deps: { connect: SocketConnect; timeoutMs?: number; timers?: Timers }): Promise<ProbeResult>`; `cleanStaleSocket(path: string, deps: { connect: SocketConnect; unlink: (p: string) => void; platform: NodeJS.Platform }): Promise<'cleaned' | 'listening' | 'nothing'>`; `defaultConnect: SocketConnect`; `interface Timers { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/probe.test.ts
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { cleanStaleSocket, probeSocket } from '../../src/daemon/probe.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('probeSocket', () => {
  it('reports listening when connect succeeds and closes the socket', async () => {
    const sock = new PassThrough();
    const destroy = vi.spyOn(sock, 'destroy');
    await expect(probeSocket('/s.sock', { connect: async () => sock })).resolves.toBe('listening');
    expect(destroy).toHaveBeenCalled();
  });
  it('maps ECONNREFUSED to refused and ENOENT to absent', async () => {
    await expect(probeSocket('/s.sock', { connect: async () => { throw errno('ECONNREFUSED'); } })).resolves.toBe('refused');
    await expect(probeSocket('/s.sock', { connect: async () => { throw errno('ENOENT'); } })).resolves.toBe('absent');
  });
  it('treats a hang as listening — never delete on ambiguity', async () => {
    vi.useFakeTimers();
    const pending = probeSocket('/s.sock', { connect: () => new Promise(() => {}), timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe('listening');
    vi.useRealTimers();
  });
});

describe('cleanStaleSocket', () => {
  it('unlinks a refused socket file', async () => {
    const unlink = vi.fn();
    await expect(cleanStaleSocket('/s.sock', { connect: async () => { throw errno('ECONNREFUSED'); }, unlink, platform: 'darwin' })).resolves.toBe('cleaned');
    expect(unlink).toHaveBeenCalledWith('/s.sock');
  });
  it('leaves a listening socket alone', async () => {
    const unlink = vi.fn();
    await expect(cleanStaleSocket('/s.sock', { connect: async () => new PassThrough(), unlink, platform: 'linux' })).resolves.toBe('listening');
    expect(unlink).not.toHaveBeenCalled();
  });
  it('does nothing on Windows (pipes leave no file)', async () => {
    const connect = vi.fn();
    await expect(cleanStaleSocket('\\\\.\\pipe\\x', { connect, unlink: vi.fn(), platform: 'win32' })).resolves.toBe('nothing');
    expect(connect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/daemon/probe.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/probe.ts
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export type ProbeResult = 'listening' | 'refused' | 'absent';
export type SocketConnect = (path: string) => Promise<Duplex>;

export const defaultConnect: SocketConnect = (path) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

/**
 * Is something listening? A connect that neither succeeds nor fails within
 * the timeout counts as listening: an ambiguous answer must never lead to a
 * live socket being unlinked (the SvelteKit size-0 bug, in our terms).
 */
export async function probeSocket(
  path: string,
  deps: { connect: SocketConnect; timeoutMs?: number; timers?: Timers },
): Promise<ProbeResult> {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const timeoutMs = deps.timeoutMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = timers.setTimeout(() => resolve('listening'), timeoutMs);
  });
  const attempt = deps.connect(path).then(
    (socket) => {
      socket.destroy();
      return 'listening' as const;
    },
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? ('absent' as const) : ('refused' as const);
    },
  );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

/** Only ever unlinks after a `refused`/`absent` probe; the caller holds the lock. */
export async function cleanStaleSocket(
  path: string,
  deps: { connect: SocketConnect; unlink: (p: string) => void; platform: NodeJS.Platform; timers?: Timers },
): Promise<'cleaned' | 'listening' | 'nothing'> {
  if (deps.platform === 'win32') return 'nothing';
  const result = await probeSocket(path, { connect: deps.connect, timers: deps.timers });
  if (result === 'listening') return 'listening';
  deps.unlink(path);
  return 'cleaned';
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/daemon/probe.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/probe.ts test/daemon/probe.test.ts
git commit -m "feat(daemon): connect probe and lock-guarded stale socket cleanup"
```

### Task 5: Protocol types and the service registry

**Files:**
- Create: `src/daemon/protocol.ts`
- Test: `test/daemon/protocol.test.ts`

**Interfaces:**
- Produces: method param/result types (`EmbedInitializeParams { profile: string }`, `EmbedInitializeResult { identity: EmbeddingIdentity; max_batch_size: number }`, `EmbedQueryParams { profile: string; text: string }`, `EmbedQueryResult { vector: number[] }`, `EmbedDocumentsParams { profile: string; texts: string[] }`, `EmbedDocumentsResult { vectors: number[][] }`, `DaemonInfoResult { name: string; version: string; pid: number; started_at: string; idle_timeout_min: number; clients: number; services: { embed: { loaded: string[] } } }`); `type DaemonErrorCode = 'UNKNOWN_METHOD' | 'INVALID_PARAMS' | 'UNKNOWN_PROFILE' | 'EMBED_FAILED' | 'SHUTTING_DOWN' | 'INTERNAL'`; `class DaemonRpcError extends Error { readonly code: DaemonErrorCode }`; `type MethodHandler = (params: unknown) => Promise<unknown>`; `type ServiceHandlers = Record<string, MethodHandler>`; `class ServiceRegistry { register(namespace: string, handlers: ServiceHandlers): void; dispatch(request: JSONRPCRequest): Promise<JSONRPCMessage> }`; `errorResponse(id: RequestId, code: DaemonErrorCode, message: string): JSONRPCMessage`; `asRecord(params: unknown): Record<string, unknown>` (throws `INVALID_PARAMS`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/protocol.test.ts
import { isJSONRPCErrorResponse, isJSONRPCResponse, type JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { DaemonRpcError, ServiceRegistry } from '../../src/daemon/protocol.js';

function req(method: string, params?: unknown, id = 1): JSONRPCRequest {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params: params as Record<string, unknown> }) };
}

describe('ServiceRegistry.dispatch', () => {
  it('routes <service>.<method> and wraps the result', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async (params) => ({ got: params }) });
    const response = await registry.dispatch(req('echo.say', { a: 1 }, 7));
    expect(isJSONRPCResponse(response)).toBe(true);
    expect(response).toMatchObject({ id: 7, result: { got: { a: 1 } } });
  });
  it('answers UNKNOWN_METHOD for an unregistered namespace or method', async () => {
    const registry = new ServiceRegistry();
    registry.register('echo', { say: async () => ({}) });
    for (const method of ['lexical.search', 'echo.shout', 'nodot']) {
      const response = await registry.dispatch(req(method));
      expect(isJSONRPCErrorResponse(response)).toBe(true);
      expect(response).toMatchObject({ error: { code: -32601, data: { code: 'UNKNOWN_METHOD' } } });
    }
  });
  it('maps DaemonRpcError codes and keeps the message', async () => {
    const registry = new ServiceRegistry();
    registry.register('embed', { query: async () => { throw new DaemonRpcError('EMBED_FAILED', 'model exploded'); } });
    const response = await registry.dispatch(req('embed.query'));
    expect(response).toMatchObject({ error: { code: -32603, message: 'model exploded', data: { code: 'EMBED_FAILED' } } });
  });
  it('turns any other throw into INTERNAL', async () => {
    const registry = new ServiceRegistry();
    registry.register('x', { y: async () => { throw new TypeError('boom'); } });
    const response = await registry.dispatch(req('x.y'));
    expect(response).toMatchObject({ error: { code: -32603, message: 'boom', data: { code: 'INTERNAL' } } });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/daemon/protocol.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/protocol.ts
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { EmbeddingIdentity } from '../lib/obsidian/corpus/types.js';

// ---- method shapes (the wire contract; see design D2) ----
export interface EmbedInitializeParams { profile: string }
export interface EmbedInitializeResult { identity: EmbeddingIdentity; max_batch_size: number }
export interface EmbedQueryParams { profile: string; text: string }
export interface EmbedQueryResult { vector: number[] }
export interface EmbedDocumentsParams { profile: string; texts: string[] }
export interface EmbedDocumentsResult { vectors: number[][] }
export interface DaemonInfoResult {
  name: string;
  version: string;
  pid: number;
  started_at: string;
  idle_timeout_min: number;
  clients: number;
  services: { embed: { loaded: string[] } };
}

export type DaemonErrorCode =
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'UNKNOWN_PROFILE'
  | 'EMBED_FAILED'
  | 'SHUTTING_DOWN'
  | 'INTERNAL';

const JSON_RPC_CODE: Record<DaemonErrorCode, number> = {
  UNKNOWN_METHOD: ErrorCode.MethodNotFound,
  INVALID_PARAMS: ErrorCode.InvalidParams,
  UNKNOWN_PROFILE: ErrorCode.InvalidParams,
  EMBED_FAILED: ErrorCode.InternalError,
  SHUTTING_DOWN: ErrorCode.ConnectionClosed,
  INTERNAL: ErrorCode.InternalError,
};

export class DaemonRpcError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonRpcError';
  }
}

export type MethodHandler = (params: unknown) => Promise<unknown>;
export type ServiceHandlers = Record<string, MethodHandler>;

export function errorResponse(id: RequestId, code: DaemonErrorCode, message: string): JSONRPCMessage {
  return { jsonrpc: '2.0', id, error: { code: JSON_RPC_CODE[code], message, data: { code } } };
}

export function resultResponse(id: RequestId, result: unknown): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result: result as Record<string, unknown> };
}

/** Params as an object, or `INVALID_PARAMS`. */
export function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new DaemonRpcError('INVALID_PARAMS', 'params must be an object');
  }
  return params as Record<string, unknown>;
}

/**
 * `namespace → { method: handler }`. A later service (`lexical`, `watch`)
 * is one more `register` call; framing, discovery and lifecycle do not move.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, ServiceHandlers>();

  register(namespace: string, handlers: ServiceHandlers): void {
    this.services.set(namespace, handlers);
  }

  async dispatch(request: JSONRPCRequest): Promise<JSONRPCMessage> {
    const dot = request.method.indexOf('.');
    const handler =
      dot === -1 ? undefined : this.services.get(request.method.slice(0, dot))?.[request.method.slice(dot + 1)];
    if (handler === undefined) {
      return errorResponse(request.id, 'UNKNOWN_METHOD', `unknown method "${request.method}"`);
    }
    try {
      return resultResponse(request.id, await handler(request.params));
    } catch (error) {
      if (error instanceof DaemonRpcError) return errorResponse(request.id, error.code, error.message);
      return errorResponse(request.id, 'INTERNAL', error instanceof Error ? error.message : String(error));
    }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/daemon/protocol.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/protocol.ts test/daemon/protocol.test.ts
git commit -m "feat(daemon): JSON-RPC service registry with namespaced methods"
```

### Task 6: The embed service

**Files:**
- Create: `src/daemon/services/embed.ts`
- Test: `test/daemon/embed-service.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` (`src/modules/semantic/types.ts`), `createQueuedEmbedder` (`embed-queue.ts`), `resolveModelProfile`/`MODEL_PROFILES` (`model-profiles.ts`), `DaemonRpcError`, `asRecord`, the `Embed*` shapes (Task 5).
- Produces: `createEmbedService(deps: { createProvider: (profile: ModelProfile) => EmbeddingProvider }): { handlers: ServiceHandlers; loaded(): string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/embed-service.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createEmbedService } from '../../src/daemon/services/embed.js';
import { DaemonRpcError } from '../../src/daemon/protocol.js';
import { identityOf, resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from '../../src/modules/semantic/types.js';

function fakeProvider(key: string, opts: { failInit?: string; vector?: number[] } = {}): EmbeddingProvider {
  const profile = resolveModelProfile(key);
  return {
    identity: identityOf(profile),
    maxBatchSize: 8,
    initialize: vi.fn(async () => {
      if (opts.failInit) throw new Error(opts.failInit);
    }),
    embedQuery: vi.fn(async () => opts.vector ?? [1, 0, 0]),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  };
}

describe('embed service', () => {
  it('builds one provider per profile, however many clients initialize it', async () => {
    const createProvider = vi.fn((profile) => fakeProvider(profile.key));
    const service = createEmbedService({ createProvider });
    const [a, b] = await Promise.all([
      service.handlers.initialize!({ profile: 'granite-97m' }),
      service.handlers.initialize!({ profile: 'granite-97m' }),
    ]);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ max_batch_size: 8, identity: { model_key: 'granite-97m', dims: 384 } });
    expect(service.loaded()).toEqual(['granite-97m']);
  });
  it('holds two providers for two profiles', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await service.handlers.initialize!({ profile: 'granite-97m' });
    await service.handlers.initialize!({ profile: 'harrier-270m' });
    expect(service.loaded().sort()).toEqual(['granite-97m', 'harrier-270m']);
  });
  it('rejects an unknown profile', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await expect(service.handlers.query!({ profile: 'bge-m3', text: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_PROFILE' });
  });
  it('reports a load failure as EMBED_FAILED and retries next time', async () => {
    let fail = true;
    const service = createEmbedService({
      createProvider: (p) => fakeProvider(p.key, { failInit: fail ? 'no weights' : undefined }),
    });
    await expect(service.handlers.initialize!({ profile: 'granite-97m' })).rejects.toMatchObject({ code: 'EMBED_FAILED', message: 'no weights' });
    fail = false;
    await expect(service.handlers.initialize!({ profile: 'granite-97m' })).resolves.toMatchObject({ max_batch_size: 8 });
  });
  it('serves query and documents, validating params', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await expect(service.handlers.query!({ profile: 'granite-97m', text: 'hello' })).resolves.toEqual({ vector: [1, 0, 0] });
    await expect(service.handlers.documents!({ profile: 'granite-97m', texts: ['a', 'b'] })).resolves.toEqual({ vectors: [[0, 1, 0], [0, 1, 0]] });
    await expect(service.handlers.documents!({ profile: 'granite-97m', texts: ['a', ' '] })).rejects.toBeInstanceOf(DaemonRpcError);
    await expect(service.handlers.documents!({ profile: 'granite-97m', texts: new Array<string>(9).fill('t') })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(service.handlers.query!({ profile: 'granite-97m' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
  it('refuses a non-finite vector', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key, { vector: [Number.NaN, 0, 0] }) });
    await expect(service.handlers.query!({ profile: 'granite-97m', text: 'x' })).rejects.toMatchObject({ code: 'EMBED_FAILED' });
  });
  it('serves a query ahead of queued document batches', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = fakeProvider('granite-97m');
    provider.embedDocuments = vi.fn(async (texts: string[]) => { order.push(`docs:${texts[0]}`); await gate; return texts.map(() => [0, 1, 0]); });
    provider.embedQuery = vi.fn(async () => { order.push('query'); return [1, 0, 0]; });
    const service = createEmbedService({ createProvider: () => provider });
    const d1 = service.handlers.documents!({ profile: 'granite-97m', texts: ['one'] });
    const d2 = service.handlers.documents!({ profile: 'granite-97m', texts: ['two'] });
    const q = service.handlers.query!({ profile: 'granite-97m', text: 'q' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([d1, d2, q]);
    expect(order).toEqual(['docs:one', 'query', 'docs:two']);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/daemon/embed-service.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/services/embed.ts
import { createQueuedEmbedder, type QueuedEmbedder } from '../../modules/semantic/embed-queue.js';
import { MODEL_PROFILES, type ModelProfile } from '../../modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from '../../modules/semantic/types.js';
import {
  asRecord,
  DaemonRpcError,
  type EmbedDocumentsResult,
  type EmbedInitializeResult,
  type EmbedQueryResult,
  type ServiceHandlers,
} from '../protocol.js';

interface LoadedProfile {
  provider: EmbeddingProvider;
  queue: QueuedEmbedder;
}

export interface EmbedServiceDeps {
  /** The shared provider factory in non-shared mode (design D7). */
  createProvider: (profile: ModelProfile) => EmbeddingProvider;
}

function readProfile(params: Record<string, unknown>): ModelProfile {
  const key = params.profile;
  if (typeof key !== 'string') throw new DaemonRpcError('INVALID_PARAMS', 'profile must be a string');
  if (!Object.hasOwn(MODEL_PROFILES, key)) throw new DaemonRpcError('UNKNOWN_PROFILE', `unknown profile "${key}"`);
  return MODEL_PROFILES[key];
}

function assertFinite(vector: number[]): number[] {
  if (!vector.every((x) => Number.isFinite(x))) {
    throw new DaemonRpcError('EMBED_FAILED', 'provider returned a non-finite vector');
  }
  return vector;
}

async function failedAs<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DaemonRpcError) throw error;
    throw new DaemonRpcError('EMBED_FAILED', error instanceof Error ? error.message : String(error));
  }
}

/**
 * One provider + one cross-client queue per profile, built on first use. The
 * queue is the same `createQueuedEmbedder` a session uses, so query-first
 * ordering now holds *between* sessions, not only inside one.
 */
export function createEmbedService(deps: EmbedServiceDeps): { handlers: ServiceHandlers; loaded(): string[] } {
  const loaded = new Map<string, LoadedProfile>();
  // Memo of in-flight loads so two concurrent initializes build one provider.
  const loading = new Map<string, Promise<LoadedProfile>>();

  function get(profile: ModelProfile): Promise<LoadedProfile> {
    const ready = loaded.get(profile.key);
    if (ready) return Promise.resolve(ready);
    const pending = loading.get(profile.key);
    if (pending) return pending;
    const provider = deps.createProvider(profile);
    const entry: LoadedProfile = { provider, queue: createQueuedEmbedder(provider) };
    const load = failedAs(async () => {
      await provider.initialize();
      loaded.set(profile.key, entry);
      return entry;
    }).finally(() => loading.delete(profile.key));
    loading.set(profile.key, load);
    return load;
  }

  const handlers: ServiceHandlers = {
    initialize: async (params): Promise<EmbedInitializeResult> => {
      const { provider } = await get(readProfile(asRecord(params)));
      return { identity: provider.identity, max_batch_size: provider.maxBatchSize };
    },
    query: async (params): Promise<EmbedQueryResult> => {
      const record = asRecord(params);
      const profile = readProfile(record);
      if (typeof record.text !== 'string') throw new DaemonRpcError('INVALID_PARAMS', 'text must be a string');
      const text = record.text;
      const { queue } = await get(profile);
      return { vector: assertFinite(await failedAs(() => queue.embedQuery(text))) };
    },
    documents: async (params): Promise<EmbedDocumentsResult> => {
      const record = asRecord(params);
      const profile = readProfile(record);
      const texts = record.texts;
      if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) {
        throw new DaemonRpcError('INVALID_PARAMS', 'texts must be an array of strings');
      }
      const { provider, queue } = await get(profile);
      if (texts.length > provider.maxBatchSize) {
        throw new DaemonRpcError('INVALID_PARAMS', `at most ${provider.maxBatchSize} texts per call`);
      }
      const blank = texts.findIndex((t) => t.trim() === '');
      if (blank !== -1) throw new DaemonRpcError('INVALID_PARAMS', `document ${blank} is blank`);
      const vectors = await failedAs(() => queue.embedDocuments(texts));
      return { vectors: vectors.map(assertFinite) };
    },
  };

  return { handlers, loaded: () => [...loaded.keys()] };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/daemon/embed-service.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/services/embed.ts test/daemon/embed-service.test.ts
git commit -m "feat(daemon): embed service with one provider and queue per profile"
```

### Task 7: The daemon service (`info`, `shutdown`)

**Files:**
- Create: `src/daemon/services/daemon.ts`
- Test: `test/daemon/daemon-service.test.ts`

**Interfaces:**
- Produces: `createDaemonService(deps: { name: string; version: string; pid: number; startedAt: string; idleTimeoutMin: number; clients: () => number; embedLoaded: () => string[]; requestShutdown: () => void }): ServiceHandlers`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/daemon-service.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createDaemonService } from '../../src/daemon/services/daemon.js';

describe('daemon service', () => {
  const deps = {
    name: 'neuro-vault-mcp', version: '18.0.0', pid: 42, startedAt: '2026-10-14T10:00:00.000Z',
    idleTimeoutMin: 30, clients: () => 2, embedLoaded: () => ['granite-97m'], requestShutdown: vi.fn(),
  };
  it('info reports identity, clients and services', async () => {
    const handlers = createDaemonService(deps);
    await expect(handlers.info!(undefined)).resolves.toEqual({
      name: 'neuro-vault-mcp', version: '18.0.0', pid: 42, started_at: deps.startedAt,
      idle_timeout_min: 30, clients: 2, services: { embed: { loaded: ['granite-97m'] } },
    });
  });
  it('shutdown answers then asks the server to stop', async () => {
    const handlers = createDaemonService(deps);
    await expect(handlers.shutdown!(undefined)).resolves.toEqual({});
    expect(deps.requestShutdown).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/services/daemon.ts
import type { DaemonInfoResult, ServiceHandlers } from '../protocol.js';

export interface DaemonServiceDeps {
  name: string;
  version: string;
  pid: number;
  startedAt: string;
  idleTimeoutMin: number;
  clients: () => number;
  embedLoaded: () => string[];
  /** Deferred by the caller so the shutdown response is written first. */
  requestShutdown: () => void;
}

export function createDaemonService(deps: DaemonServiceDeps): ServiceHandlers {
  return {
    info: async (): Promise<DaemonInfoResult> => ({
      name: deps.name,
      version: deps.version,
      pid: deps.pid,
      started_at: deps.startedAt,
      idle_timeout_min: deps.idleTimeoutMin,
      clients: deps.clients(),
      services: { embed: { loaded: deps.embedLoaded() } },
    }),
    shutdown: async () => {
      deps.requestShutdown();
      return {};
    },
  };
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/services/daemon.ts test/daemon/daemon-service.test.ts
git commit -m "feat(daemon): info and shutdown service"
```

### Task 8: The socket server

**Files:**
- Create: `src/daemon/socket-server.ts`
- Test: `test/daemon/socket-server.test.ts`

**Interfaces:**
- Consumes: `ServiceRegistry`, `errorResponse` (Task 5); `Timers` (Task 4).
- Produces: `startDaemonServer(opts: { socketPath: string; registry: ServiceRegistry; idleTimeoutMs: number; onIdle: () => void; timers?: Timers; listen?: (server: net.Server, path: string) => Promise<void> }): Promise<DaemonServerHandle>`; `interface DaemonServerHandle { clients(): number; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests** (a real unix socket under a short path; skipped on Windows)

```ts
// test/daemon/socket-server.test.ts
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';

const posix = process.platform !== 'win32';

class LineClient {
  private readonly buffer = new ReadBuffer();
  private readonly waiting: Array<(m: JSONRPCMessage) => void> = [];
  private readonly queued: JSONRPCMessage[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.readMessage();
        if (!message) break;
        const take = this.waiting.shift();
        if (take) take(message);
        else this.queued.push(message);
      }
    });
  }
  static connect(p: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(p);
      socket.once('connect', () => resolve(new LineClient(socket)));
      socket.once('error', reject);
    });
  }
  send(message: JSONRPCMessage): void {
    this.socket.write(serializeMessage(message));
  }
  next(): Promise<JSONRPCMessage> {
    const queued = this.queued.shift();
    return queued ? Promise.resolve(queued) : new Promise((resolve) => this.waiting.push(resolve));
  }
  closed(): Promise<void> {
    return new Promise((resolve) => this.socket.once('close', () => resolve()));
  }
}

describe.skipIf(!posix)('startDaemonServer', () => {
  let dir: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/nv-sock-');
    socketPath = path.join(dir, 's.sock');
  });
  afterEach(async () => {
    await handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function registryWith(handlers: Record<string, (p: unknown) => Promise<unknown>>): ServiceRegistry {
    const registry = new ServiceRegistry();
    registry.register('t', handlers);
    return registry;
  }

  it('answers requests from two clients and counts them', async () => {
    handle = await startDaemonServer({ socketPath, registry: registryWith({ echo: async (p) => p }), idleTimeoutMs: 0, onIdle: () => {} });
    const a = await LineClient.connect(socketPath);
    const b = await LineClient.connect(socketPath);
    await new Promise((r) => setTimeout(r, 10));
    expect(handle.clients()).toBe(2);
    a.send({ jsonrpc: '2.0', id: 1, method: 't.echo', params: { text: 'line one\nline "two"' } });
    b.send({ jsonrpc: '2.0', id: 2, method: 't.echo', params: { n: 2 } });
    expect(await a.next()).toMatchObject({ id: 1, result: { text: 'line one\nline "two"' } });
    expect(await b.next()).toMatchObject({ id: 2, result: { n: 2 } });
    a.socket.destroy();
    b.socket.destroy();
  });

  it('closes only the client that sends a bad line', async () => {
    handle = await startDaemonServer({ socketPath, registry: registryWith({ echo: async (p) => p }), idleTimeoutMs: 0, onIdle: () => {} });
    const bad = await LineClient.connect(socketPath);
    const good = await LineClient.connect(socketPath);
    bad.socket.write('this is not json\n');
    await bad.closed();
    good.send({ jsonrpc: '2.0', id: 3, method: 't.echo', params: { ok: true } });
    expect(await good.next()).toMatchObject({ id: 3, result: { ok: true } });
    good.socket.destroy();
  });

  it('arms the idle timer when the last client leaves and disarms it on a new one', async () => {
    const onIdle = vi.fn();
    const timers = { setTimeout: vi.fn((fn: () => void) => setTimeout(fn, 1_000_000)), clearTimeout: vi.fn((t: NodeJS.Timeout) => clearTimeout(t)) };
    handle = await startDaemonServer({ socketPath, registry: registryWith({}), idleTimeoutMs: 60_000, onIdle, timers: timers as never });
    const a = await LineClient.connect(socketPath);
    a.socket.destroy();
    await a.closed();
    await new Promise((r) => setTimeout(r, 10));
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    const b = await LineClient.connect(socketPath);
    await new Promise((r) => setTimeout(r, 10));
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    b.socket.destroy();
  });

  it('close() ends connections and answers in-flight requests with SHUTTING_DOWN', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handle = await startDaemonServer({ socketPath, registry: registryWith({ slow: async () => { await gate; return {}; } }), idleTimeoutMs: 0, onIdle: () => {} });
    const a = await LineClient.connect(socketPath);
    a.send({ jsonrpc: '2.0', id: 9, method: 't.slow' });
    await new Promise((r) => setTimeout(r, 10));
    const closing = handle.close();
    expect(await a.next()).toMatchObject({ id: 9, error: { data: { code: 'SHUTTING_DOWN' } } });
    await a.closed();
    release();
    await closing;
    handle = undefined;
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/daemon/socket-server.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/daemon/socket-server.ts
import net from 'node:net';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { errorResponse, type ServiceRegistry } from './protocol.js';
import type { Timers } from './probe.js';

export interface DaemonServerOptions {
  socketPath: string;
  registry: ServiceRegistry;
  /** 0 = never idle out. */
  idleTimeoutMs: number;
  onIdle: () => void;
  timers?: Timers;
}

export interface DaemonServerHandle {
  clients(): number;
  close(): Promise<void>;
}

interface InFlight {
  socket: net.Socket;
  id: Parameters<typeof errorResponse>[0];
  answered: boolean;
}

/**
 * One `ReadBuffer` per connection, one response per request, in whatever
 * order the handlers finish. A connection that sends a line the SDK cannot
 * parse as JSON-RPC is destroyed — its problem, nobody else's.
 */
export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const connections = new Set<net.Socket>();
  const inFlight = new Set<InFlight>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;

  const write = (socket: net.Socket, message: JSONRPCMessage): void => {
    if (!socket.destroyed) socket.write(serializeMessage(message));
  };

  const armIdle = (): void => {
    if (opts.idleTimeoutMs <= 0 || shuttingDown) return;
    idleTimer = timers.setTimeout(() => opts.onIdle(), opts.idleTimeoutMs);
  };
  const disarmIdle = (): void => {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const server = net.createServer((socket) => {
    disarmIdle();
    connections.add(socket);
    const buffer = new ReadBuffer();
    socket.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch {
          socket.destroy();
          return;
        }
        if (!message) return;
        if (!isJSONRPCRequest(message)) continue;
        if (shuttingDown) {
          write(socket, errorResponse(message.id, 'SHUTTING_DOWN', 'daemon is stopping'));
          continue;
        }
        const entry: InFlight = { socket, id: message.id, answered: false };
        inFlight.add(entry);
        void opts.registry.dispatch(message).then((response) => {
          inFlight.delete(entry);
          if (!entry.answered) write(socket, response);
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      if (connections.size === 0) armIdle();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    clients: () => connections.size,
    close: () =>
      new Promise<void>((resolve) => {
        shuttingDown = true;
        disarmIdle();
        for (const entry of inFlight) {
          entry.answered = true;
          write(entry.socket, errorResponse(entry.id, 'SHUTTING_DOWN', 'daemon is stopping'));
        }
        for (const socket of connections) socket.end();
        // `server.close` unlinks the socket file once every connection is gone.
        server.close(() => resolve());
        for (const socket of connections) socket.destroy();
      }),
  };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/daemon/socket-server.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/socket-server.ts test/daemon/socket-server.test.ts
git commit -m "feat(daemon): unix-socket JSON-RPC server with idle timer and orderly close"
```

### Task 9: CLI parsing for `daemon [status|stop]`

**Files:**
- Modify: `src/config.ts`, `src/types.ts`, `src/cli.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `interface DaemonCliOptions { action?: 'status' | 'stop'; idleTimeoutMinutes: number }`; `ParsedCli` gains `{ kind: 'daemon'; options: DaemonCliOptions }`; `DEFAULT_IDLE_TIMEOUT_MINUTES = 30`.
- Consumes (Task 11 later): `runDaemonCommand(options, deps)`.

- [ ] **Step 1: Write the failing tests** (append to the `parseConfig` describe block in `test/config.test.ts`)

```ts
  it('parses `daemon` with the default idle timeout and no vault', async () => {
    const parsed = await parseConfig(['node', 'cli.js', 'daemon']);
    expect(parsed).toEqual({ kind: 'daemon', options: { action: undefined, idleTimeoutMinutes: 30 } });
  });
  it('parses `daemon status` and `daemon stop`', async () => {
    await expect(parseConfig(['node', 'cli.js', 'daemon', 'status'])).resolves.toMatchObject({ kind: 'daemon', options: { action: 'status' } });
    await expect(parseConfig(['node', 'cli.js', 'daemon', 'stop'])).resolves.toMatchObject({ kind: 'daemon', options: { action: 'stop' } });
  });
  it('parses --idle-timeout and rejects bad values', async () => {
    await expect(parseConfig(['node', 'cli.js', 'daemon', '--idle-timeout', '0'])).resolves.toMatchObject({ options: { idleTimeoutMinutes: 0 } });
    await expect(parseConfig(['node', 'cli.js', 'daemon', '--idle-timeout', '-1'])).rejects.toThrow(/non-negative integer/);
    await expect(parseConfig(['node', 'cli.js', 'daemon', '--idle-timeout', 'soon'])).rejects.toThrow(/non-negative integer/);
  });
  it('rejects an unknown daemon action and vault/model options', async () => {
    await expect(parseConfig(['node', 'cli.js', 'daemon', 'restart'])).rejects.toThrow(/status, stop/);
    await expect(parseConfig(['node', 'cli.js', 'daemon', '--vault', vaultPath])).rejects.toThrow(/vault/);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/config.test.ts` → the new cases FAIL.

- [ ] **Step 3: Implement**

In `src/types.ts` add:

```ts
export interface DaemonCliOptions {
  /** Absent: run the daemon. */
  action?: 'status' | 'stop';
  /** 0 = never exit on idle. */
  idleTimeoutMinutes: number;
}
```

In `src/config.ts`:

```ts
import type { DaemonCliOptions, IVaultConfig, ServerConfig } from './types.js';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DAEMON_ACTIONS = ['status', 'stop'] as const;

export type ParsedCli =
  | { kind: 'run'; config: ServerConfig }
  | { kind: 'index'; options: IndexCliOptions }
  | { kind: 'daemon'; options: DaemonCliOptions }
  | { kind: 'handled' };

const IDLE_TIMEOUT_OPTION = {
  type: 'number',
  default: DEFAULT_IDLE_TIMEOUT_MINUTES,
  describe: 'Minutes without a connected client before the daemon exits (0 = never).',
} as const;

function readIdleTimeout(raw: unknown): number {
  if (Array.isArray(raw)) throw new Error('--idle-timeout may be given only once');
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`--idle-timeout: expected a non-negative integer of minutes, got "${String(raw)}"`);
  }
  return minutes;
}

function readDaemonAction(raw: unknown): DaemonCliOptions['action'] {
  if (raw === undefined) return undefined;
  if (raw === 'status' || raw === 'stop') return raw;
  throw new Error(`daemon: unknown action "${String(raw)}" — choose one of: ${DAEMON_ACTIONS.join(', ')}`);
}
```

Add the command to the yargs chain (after `index`):

```ts
    .command(
      'daemon [action]',
      'Run the shared-services daemon (the server starts it on demand); `status` lists daemons, `stop` ends them',
      (y) =>
        y
          .positional('action', { type: 'string', choices: DAEMON_ACTIONS })
          .option('idle-timeout', IDLE_TIMEOUT_OPTION),
    )
```

and branch **before** `validateVaults`:

```ts
  if (args._[0] === 'daemon') {
    return {
      kind: 'daemon',
      options: { action: readDaemonAction(args.action), idleTimeoutMinutes: readIdleTimeout(args['idle-timeout']) },
    };
  }
```

(`.strict()` already rejects `--vault`/`--model` on `daemon`, since the command does not declare them; the yargs `choices` list rejects `restart` naming `status, stop`.)

In `src/cli.ts` `main`, before the `index` branch:

```ts
  if (parsed.kind === 'daemon') {
    const { runDaemonCommand } = await import('./cli-daemon.js');
    process.exitCode = await runDaemonCommand(parsed.options, deps.daemon);
    return;
  }
```

and extend `main`'s `deps` type to `{ server?: NeuroVaultStartupDependencies; daemon?: DaemonCommandDeps }` — adjust the existing call sites (`main(argv, deps)` in tests pass server deps today; wrap them as `{ server: … }`). `runDaemonCommand` and `DaemonCommandDeps` arrive in Task 11; until then export a stub `runDaemonCommand = async () => 0` from a new `src/cli-daemon.ts` so typecheck stays green.

- [ ] **Step 4: Run the config and cli tests** — `npx vitest run test/config.test.ts test/server-modules.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/types.ts src/cli.ts src/cli-daemon.ts test/config.test.ts test/server-modules.test.ts
git commit -m "feat(cli): parse the daemon command and --idle-timeout"
```

### Task 10: Provider factory — the non-shared half (the daemon needs it now)

**Files:**
- Create: `src/modules/semantic/provider-factory.ts`
- Test: `test/semantic/provider-factory.test.ts`

**Interfaces:**
- Produces: `interface ProviderFactoryOptions { profile: ModelProfile; shared: boolean; cliPath?: string; version?: string; env?: NodeJS.ProcessEnv; home?: string; uid?: number; platform?: NodeJS.Platform; stderr?: { write(s: string): boolean }; loader?: LocalModelLoader }`; `createEmbeddingProvider(opts: ProviderFactoryOptions): EmbeddingProvider`. In this task only `shared: false` is implemented; `shared: true` throws `not implemented` and Task 14 fills it in.

- [ ] **Step 1: Write the failing test**

```ts
// test/semantic/provider-factory.test.ts
import { describe, expect, it } from 'vitest';
import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';
import { DEFAULT_MODEL_KEY, resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';
import { createEmbeddingProvider } from '../../src/modules/semantic/provider-factory.js';

describe('createEmbeddingProvider', () => {
  const profile = resolveModelProfile(DEFAULT_MODEL_KEY);
  it('returns the in-process provider when not shared', () => {
    const provider = createEmbeddingProvider({ profile, shared: false });
    expect(provider).toBeInstanceOf(EmbeddingService);
    expect(provider.identity.model_key).toBe(profile.key);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/modules/semantic/provider-factory.ts
import { EmbeddingService } from './embedding-service.js';
import type { LocalModelLoader } from './local-model-loader.js';
import type { ModelProfile } from './model-profiles.js';
import type { EmbeddingProvider } from './types.js';

export interface ProviderFactoryOptions {
  profile: ModelProfile;
  /** false: load the model in this process (also what the daemon itself does). */
  shared: boolean;
  /** Absolute path of the running CLI script; the daemon is spawned from it. */
  cliPath?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  stderr?: { write(chunk: string): boolean };
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

/**
 * The one place a provider is chosen for a profile: the server, `index` and
 * the daemon's embed service all come through here (design D7). A remote
 * provider is a later profile kind handled in this same switch.
 */
export function createEmbeddingProvider(opts: ProviderFactoryOptions): EmbeddingProvider {
  if (!opts.shared) return new EmbeddingService({ profile: opts.profile, loader: opts.loader });
  throw new Error('shared provider not implemented yet');
}
```

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/provider-factory.ts test/semantic/provider-factory.test.ts
git commit -m "feat(semantic): provider factory (in-process half)"
```

### Task 11: The `daemon` command — run, status, stop

**Files:**
- Modify: `src/cli-daemon.ts` (replace the Task 9 stub)
- Test: `test/cli-daemon.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8, 10; `packageMeta`.
- Produces: `interface DaemonCommandDeps { platform?; uid?; env?; home?; pid?; version?; now?: () => Date; fs?: LockFs & { readdir(dir): string[]; rmrf(dir): void; chmod(p, mode): void; exists(p): boolean }; isAlive?; connect?: SocketConnect; startServer?: typeof startDaemonServer; createProvider?: (profile) => EmbeddingProvider; writeInfo?; readInfo?; onSignal?: (signal, handler) => void; exit?: (code: number) => void; timers?: Timers; stdout?; stderr?; kill?: (pid: number, signal: 'SIGTERM') => void }`; `runDaemonCommand(options: DaemonCliOptions, deps?: DaemonCommandDeps): Promise<number>`; `STOP_DEADLINE_MS = 5_000`.

- [ ] **Step 1: Write the failing tests** (every branch through DI; no real sockets)

```ts
// test/cli-daemon.test.ts
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runDaemonCommand, type DaemonCommandDeps } from '../src/cli-daemon.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(overrides: Partial<DaemonCommandDeps> = {}) {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const out: string[] = [];
  const err: string[] = [];
  const handle = { clients: vi.fn(() => 0), close: vi.fn(async () => {}) };
  const startServer = vi.fn(async () => handle);
  const signals = new Map<string, () => void>();
  const exit = vi.fn();
  const deps: DaemonCommandDeps = {
    platform: 'darwin', uid: 501, env: {}, home: '/home/u', pid: 42, version: '18.0.0',
    now: () => new Date('2026-10-14T10:00:00.000Z'),
    fs: {
      mkdirp: (d) => { dirs.add(d); }, openExclusive: (f, c) => (files.has(f) ? false : (files.set(f, c), true)),
      read: (f) => files.get(f), unlink: (f) => { files.delete(f); }, readdir: (d) => [...dirs].filter((x) => x.startsWith(d + '/')).map((x) => x.slice(d.length + 1)),
      rmrf: (d) => { dirs.delete(d); for (const f of [...files.keys()]) if (f.startsWith(d)) files.delete(f); }, chmod: vi.fn(), exists: (p) => files.has(p) || dirs.has(p),
    },
    isAlive: () => false,
    connect: async () => { throw errno('ENOENT'); },
    startServer: startServer as never,
    createProvider: vi.fn(),
    writeInfo: async (f, info) => { files.set(f, JSON.stringify(info)); },
    readInfo: (f) => { const raw = files.get(f); return raw ? (JSON.parse(raw) as never) : undefined; },
    onSignal: (signal, handler) => { signals.set(signal, handler); },
    exit, timers: { setTimeout: vi.fn(() => 0 as never), clearTimeout: vi.fn() } as never,
    stdout: { write: (s: string) => (out.push(s), true) }, stderr: { write: (s: string) => (err.push(s), true) },
    kill: vi.fn(),
    ...overrides,
  };
  return { deps, files, dirs, out, err, handle, startServer, signals, exit };
}

describe('runDaemonCommand (run)', () => {
  it('locks, listens, chmods, writes daemon.json and announces on stderr', async () => {
    const h = harness();
    await expect(runDaemonCommand({ idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(0);
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ socketPath: expect.stringMatching(/^\/tmp\/neuro-vault-501\/[0-9a-f]{12}\.sock$/), idleTimeoutMs: 30 * 60_000 }));
    expect(h.deps.fs!.chmod).toHaveBeenCalledWith(expect.stringMatching(/\.sock$/), 0o600);
    expect([...h.files.keys()].some((f) => f.endsWith('daemon.lock'))).toBe(true);
    expect([...h.files.keys()].some((f) => f.endsWith('daemon.json'))).toBe(true);
    expect(h.err.join('')).toMatch(/neuro-vault-mcp v18\.0\.0 daemon listening/);
    expect(h.out).toEqual([]);
  });
  it('exits 1 when the lock is held by a live pid', async () => {
    const h = harness({ isAlive: (pid) => pid === 7 });
    h.files.set(`/home/u/.cache/neuro-vault/daemons/${keyOf(h)}/daemon.lock`, '7');
    await expect(runDaemonCommand({ idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(1);
    expect(h.err.join('')).toMatch(/already running \(pid 7\)/);
    expect(h.startServer).not.toHaveBeenCalled();
  });
  it('exits 1 when something already listens on the socket', async () => {
    const h = harness({ connect: async () => new PassThrough() });
    await expect(runDaemonCommand({ idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(1);
    expect(h.startServer).not.toHaveBeenCalled();
  });
  it('SIGTERM closes the server, removes the files and exits 0', async () => {
    const h = harness();
    await runDaemonCommand({ idleTimeoutMinutes: 30 }, h.deps);
    h.signals.get('SIGTERM')!();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.handle.close).toHaveBeenCalled();
    expect([...h.files.keys()].some((f) => f.endsWith('daemon.json') || f.endsWith('daemon.lock'))).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(0);
  });
  it('idle expiry stops it the same way', async () => {
    const h = harness();
    await runDaemonCommand({ idleTimeoutMinutes: 1 }, h.deps);
    const opts = h.startServer.mock.calls[0]![0] as { onIdle: () => void };
    opts.onIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.handle.close).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('runDaemonCommand (status / stop)', () => {
  it('status lists a live daemon and sweeps a stale one', async () => {
    const h = harness();
    const base = '/home/u/.cache/neuro-vault/daemons';
    h.dirs.add(`${base}/aaaaaaaaaaaa`).add(`${base}/bbbbbbbbbbbb`);
    h.files.set(`${base}/aaaaaaaaaaaa/daemon.json`, JSON.stringify({ pid: 1, version: '18.0.0', socket: '/tmp/a.sock', started_at: 'x' }));
    h.files.set(`${base}/bbbbbbbbbbbb/daemon.json`, JSON.stringify({ pid: 2, version: '17.0.0', socket: '/tmp/b.sock', started_at: 'x' }));
    h.deps.connect = async (p) => { if (p === '/tmp/a.sock') return fakeInfoSocket({ version: '18.0.0', pid: 1, clients: 2, loaded: ['granite-97m'] }); throw errno('ECONNREFUSED'); };
    await expect(runDaemonCommand({ action: 'status', idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/18\.0\.0 .*pid 1 .*clients 2 .*granite-97m .*alive/);
    expect(h.out.join('')).toMatch(/17\.0\.0 .*stale/);
    expect(h.dirs.has(`${base}/bbbbbbbbbbbb`)).toBe(false);
  });
  it('status with nothing known says so and exits 0', async () => {
    const h = harness();
    await expect(runDaemonCommand({ action: 'status', idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(0);
    expect(h.out.join('')).toMatch(/no daemon/);
  });
  it('stop sends daemon.shutdown and falls back to SIGTERM when it does not answer', async () => {
    const h = harness();
    const base = '/home/u/.cache/neuro-vault/daemons';
    h.dirs.add(`${base}/aaaaaaaaaaaa`);
    h.files.set(`${base}/aaaaaaaaaaaa/daemon.json`, JSON.stringify({ pid: 1, version: '18.0.0', socket: '/tmp/a.sock', started_at: 'x' }));
    h.deps.connect = async () => fakeInfoSocket({ version: '18.0.0', pid: 1, clients: 0, loaded: [] }, { answerShutdown: false });
    await expect(runDaemonCommand({ action: 'stop', idleTimeoutMinutes: 30 }, h.deps)).resolves.toBe(0);
    expect(h.deps.kill).toHaveBeenCalledWith(1, 'SIGTERM');
  });
});
```

Add two helpers at the bottom of the test file: `keyOf(h)` returning `daemonKey(h.deps.version!)` (import from `src/daemon/paths.js`), and `fakeInfoSocket(info, { answerShutdown = true })` returning a `Duplex` that parses incoming lines with `ReadBuffer` and answers `daemon.info` with `{ jsonrpc, id, result: { name: 'neuro-vault-mcp', version, pid, started_at: 'x', idle_timeout_min: 30, clients, services: { embed: { loaded } } } }`, and `daemon.shutdown` with `{}` when `answerShutdown` is true (otherwise never answers).

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/cli-daemon.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/cli-daemon.ts
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCResponse, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { neuroVaultCacheBase } from './lib/cache-dir.js';
import { daemonPaths, type DaemonPaths } from './daemon/paths.js';
import { acquireLock, defaultLockFs, isPidAlive, releaseLock, type LockFs } from './daemon/lock.js';
import { readDaemonInfo, writeDaemonInfo, type DaemonInfo } from './daemon/info.js';
import { cleanStaleSocket, defaultConnect, type SocketConnect, type Timers } from './daemon/probe.js';
import { ServiceRegistry, type DaemonInfoResult } from './daemon/protocol.js';
import { createEmbedService } from './daemon/services/embed.js';
import { createDaemonService } from './daemon/services/daemon.js';
import { startDaemonServer } from './daemon/socket-server.js';
import { createEmbeddingProvider } from './modules/semantic/provider-factory.js';
import type { ModelProfile } from './modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from './modules/semantic/types.js';
import { packageMeta } from './package-meta.js';
import type { DaemonCliOptions } from './types.js';

export const STOP_DEADLINE_MS = 5_000;

interface OutStream {
  write(chunk: string): boolean;
}

export interface DaemonFs extends LockFs {
  readdir(dir: string): string[];
  rmrf(dir: string): void;
  chmod(p: string, mode: number): void;
  exists(p: string): boolean;
}

export interface DaemonCommandDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  pid?: number;
  version?: string;
  now?: () => Date;
  fs?: DaemonFs;
  isAlive?: (pid: number) => boolean;
  connect?: SocketConnect;
  startServer?: typeof startDaemonServer;
  createProvider?: (profile: ModelProfile) => EmbeddingProvider;
  writeInfo?: (file: string, info: DaemonInfo) => Promise<void>;
  readInfo?: (file: string) => DaemonInfo | undefined;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  exit?: (code: number) => void;
  timers?: Timers;
  stdout?: OutStream;
  stderr?: OutStream;
  kill?: (pid: number, signal: 'SIGTERM') => void;
}

function defaultFs(): DaemonFs {
  return {
    ...defaultLockFs(),
    readdir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    rmrf: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    chmod: (p, mode) => fs.chmodSync(p, mode),
    exists: (p) => fs.existsSync(p),
  };
}

function resolve(deps: DaemonCommandDeps) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? os.userInfo().uid;
  const version = deps.version ?? packageMeta.version;
  return {
    env, home, platform, uid, version,
    cacheBase: neuroVaultCacheBase(env, home),
    pid: deps.pid ?? process.pid,
    now: deps.now ?? (() => new Date()),
    fs: deps.fs ?? defaultFs(),
    isAlive: deps.isAlive ?? isPidAlive,
    connect: deps.connect ?? defaultConnect,
    startServer: deps.startServer ?? startDaemonServer,
    createProvider:
      deps.createProvider ?? ((profile: ModelProfile) => createEmbeddingProvider({ profile, shared: false })),
    writeInfo: deps.writeInfo ?? ((file: string, info: DaemonInfo) => writeDaemonInfo(file, info)),
    readInfo: deps.readInfo ?? ((file: string) => readDaemonInfo(file)),
    onSignal:
      deps.onSignal ??
      ((signal: 'SIGINT' | 'SIGTERM', handler: () => void) => {
        process.once(signal, handler);
      }),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    timers: deps.timers ?? { setTimeout, clearTimeout },
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    kill: deps.kill ?? ((pid: number, signal: 'SIGTERM') => process.kill(pid, signal)),
  };
}

export async function runDaemonCommand(options: DaemonCliOptions, deps: DaemonCommandDeps = {}): Promise<number> {
  const r = resolve(deps);
  if (options.action === 'status') return runStatus(r);
  if (options.action === 'stop') return runStop(r);
  return runDaemon(options, r);
}

type Resolved = ReturnType<typeof resolve>;

async function runDaemon(options: DaemonCliOptions, r: Resolved): Promise<number> {
  const paths = daemonPaths({ version: r.version, uid: r.uid, platform: r.platform, cacheBase: r.cacheBase });
  const lock = acquireLock(paths.lockFile, { pid: r.pid, isAlive: r.isAlive, fs: r.fs });
  if (lock.kind === 'held') {
    r.stderr.write(`${packageMeta.name} daemon is already running (pid ${lock.pid})\n`);
    return 1;
  }
  if (r.platform !== 'win32') r.fs.mkdirp(path.dirname(paths.socketPath));
  const cleaned = await cleanStaleSocket(paths.socketPath, {
    connect: r.connect, unlink: (p) => r.fs.unlink(p), platform: r.platform, timers: r.timers,
  });
  if (cleaned === 'listening') {
    releaseLock(paths.lockFile, r.fs);
    r.stderr.write(`${packageMeta.name} daemon is already listening on ${paths.socketPath}\n`);
    return 1;
  }

  const embed = createEmbedService({ createProvider: r.createProvider });
  const registry = new ServiceRegistry();
  registry.register('embed', embed.handlers);

  let stopping = false;
  let handle: Awaited<ReturnType<typeof startDaemonServer>> | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = r.timers.setTimeout(() => r.exit(0), STOP_DEADLINE_MS);
    void (async () => {
      try {
        await handle?.close();
      } finally {
        r.fs.unlink(paths.infoFile);
        if (r.platform !== 'win32') r.fs.unlink(paths.socketPath);
        releaseLock(paths.lockFile, r.fs);
        r.timers.clearTimeout(deadline);
        r.exit(0);
      }
    })();
  };

  const startedAt = r.now().toISOString();
  registry.register(
    'daemon',
    createDaemonService({
      name: packageMeta.name, version: r.version, pid: r.pid, startedAt,
      idleTimeoutMin: options.idleTimeoutMinutes,
      clients: () => handle?.clients() ?? 0,
      embedLoaded: embed.loaded,
      // Deferred one tick so the shutdown response leaves before the socket ends.
      requestShutdown: () => void r.timers.setTimeout(stop, 0),
    }),
  );

  handle = await r.startServer({
    socketPath: paths.socketPath, registry,
    idleTimeoutMs: options.idleTimeoutMinutes * 60_000, onIdle: stop, timers: r.timers,
  });
  if (r.platform !== 'win32') r.fs.chmod(paths.socketPath, 0o600);
  await r.writeInfo(paths.infoFile, { pid: r.pid, version: r.version, socket: paths.socketPath, started_at: startedAt });
  r.onSignal('SIGINT', stop);
  r.onSignal('SIGTERM', stop);
  r.stderr.write(`${packageMeta.name} v${r.version} daemon listening on ${paths.socketPath} (idle timeout ${options.idleTimeoutMinutes} min)\n`);
  return 0;
}

/** One JSON-RPC call on a fresh connection; `undefined` on any failure or timeout. */
async function callOnce<T>(r: Resolved, socketPath: string, method: string, timeoutMs: number): Promise<T | undefined> {
  let socket;
  try {
    socket = await r.connect(socketPath);
  } catch {
    return undefined;
  }
  return new Promise<T | undefined>((resolve) => {
    const buffer = new ReadBuffer();
    const timer = r.timers.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (value: T | undefined): void => {
      r.timers.clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      let message: JSONRPCMessage | null;
      try {
        message = buffer.readMessage();
      } catch {
        return finish(undefined);
      }
      if (message && isJSONRPCResponse(message)) finish(message.result as T);
    });
    socket.on('error', () => finish(undefined));
    socket.write(serializeMessage({ jsonrpc: '2.0', id: 1, method }));
  });
}

interface Known {
  dir: string;
  info: DaemonInfo;
}

function knownDaemons(r: Resolved): Known[] {
  const root = path.join(r.cacheBase, 'daemons');
  return r.fs
    .readdir(root)
    .map((name) => ({ dir: path.join(root, name), info: r.readInfo(path.join(root, name, 'daemon.json')) }))
    .filter((k): k is Known => k.info !== undefined);
}

async function runStatus(r: Resolved): Promise<number> {
  const known = knownDaemons(r);
  if (known.length === 0) {
    r.stdout.write('no daemon known\n');
    return 0;
  }
  for (const { dir, info } of known) {
    const live = await callOnce<DaemonInfoResult>(r, info.socket, 'daemon.info', 2_000);
    if (live) {
      r.stdout.write(
        `${live.version}  pid ${live.pid}  clients ${live.clients}  loaded [${live.services.embed.loaded.join(', ')}]  alive  ${info.socket}\n`,
      );
    } else {
      r.stdout.write(`${info.version}  pid ${info.pid}  stale  (swept)\n`);
      r.fs.rmrf(dir);
    }
  }
  return 0;
}

async function runStop(r: Resolved): Promise<number> {
  const known = knownDaemons(r);
  if (known.length === 0) {
    r.stdout.write('no daemon known\n');
    return 0;
  }
  for (const { info } of known) {
    const answered = await callOnce<Record<string, never>>(r, info.socket, 'daemon.shutdown', 2_000);
    if (answered === undefined && r.isAlive(info.pid)) r.kill(info.pid, 'SIGTERM');
    r.stdout.write(`stopped ${info.version} (pid ${info.pid})\n`);
  }
  return 0;
}
```

- [ ] **Step 4: Run tests and the full gate** — `npx vitest run test/cli-daemon.test.ts` → PASS; `npm test && npm run lint && npm run typecheck && npm run build` → green.

- [ ] **Step 5: Commit**

```bash
git add src/cli-daemon.ts test/cli-daemon.test.ts
git commit -m "feat(cli): daemon command — run, status, stop"
```

### Task 12: Manual verification of PR 1 and docs

**Files:**
- Create: `docs/architecture/shared-daemon.md`; `docs/adr/0018-shared-services-daemon.md` (only after the user's ack)
- Modify: `docs/architecture/README.md`, `docs/adr/INDEX.md`, `docs/architecture/cli-startup.md`

- [ ] **Step 1: Manual check, recorded for verify.md**

```bash
npm run build
node dist/cli.js daemon --idle-timeout 1 &
sleep 1; ls -la /tmp/neuro-vault-$(id -u)/
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"daemon.info"}' '{"jsonrpc":"2.0","id":2,"method":"embed.initialize","params":{"profile":"granite-97m"}}' '{"jsonrpc":"2.0","id":3,"method":"embed.query","params":{"profile":"granite-97m","text":"hello"}}' | nc -U /tmp/neuro-vault-$(id -u)/*.sock
node dist/cli.js daemon; echo "second daemon exit: $?"
node dist/cli.js daemon status
node dist/cli.js daemon stop; sleep 1; node dist/cli.js daemon status
```

Expected: info with `clients 1`; `embed.initialize` answers after the model loads with `dims: 384`; `embed.query` returns a 384-float vector; the second daemon exits 1 naming the pid; `status` shows one alive daemon; after `stop`, `status` says `no daemon known`. Then: start again, `kill -9` it, `node dist/cli.js daemon` must clean the leftovers and listen; and a daemon with `--idle-timeout 1` must exit about a minute after the last `nc` disconnects.

- [ ] **Step 2: Write `docs/architecture/shared-daemon.md`**

Sections, in this order, each a few paragraphs in the voice of the other architecture files: What it is (one shared-services process per installed version; today one service, `embed`); Why it exists (the measured per-session model cost; the pattern Nx/Watchman/pm2 use); Paths and files (the key, `/tmp` socket and why not `os.tmpdir()`, state dir, `daemon.json`, `daemon.log`, `daemon.lock`, modes); Lifecycle (lock → stale probe → listen → info; idle from the last client; stop paths and the 5 s deadline; why the daemon handles signals and the stdio server does not); Protocol (the method table from design D2, error codes, framing via the SDK's `ReadBuffer`); The embed service (one provider + queue per profile, cross-session query priority, `EMBED_FAILED` semantics); How a new service attaches (`registry.register('lexical', …)`; the facade pattern); How a remote embedding provider would fit (design D9); Boundaries (nothing MCP-level lives here; no vault paths in the info file). Add the entry to `docs/architecture/README.md` and a pointer paragraph in `cli-startup.md` (`kind: 'daemon'` outcome, `--idle-timeout`).

- [ ] **Step 3: ADR-0018** (after the user's ack recorded in the conversation): `docs/adr/0018-shared-services-daemon.md` with Status Accepted, Date, Context (the measurement, the research summary with the comparison table, the two earlier designs and why they were withdrawn), Decision (shared-services process per installed version over a unix socket with stdio framing; the embedding provider is its first client; per-version keying instead of killing; profiles on demand; idle from the last client; any doubt → in-process), Consequences (one model per machine; a background process and its files; N watchers and lexical caches remain, named as the next services; `--no-shared`), Alternatives considered (stateless Streamable HTTP + shim; `service install`; share the whole MCP server; kill-on-upgrade). Add the row to `docs/adr/INDEX.md`.

- [ ] **Step 4: Gate and commit**

```bash
npm test && npm run lint && npm run typecheck && npm run build
git add docs/architecture/shared-daemon.md docs/architecture/README.md docs/architecture/cli-startup.md docs/adr/0018-shared-services-daemon.md docs/adr/INDEX.md
git commit -m "docs: shared-services daemon architecture and ADR-0018"
```

- [ ] **Step 5: Open PR 1** — `gh pr create` with `Refs #145`, the manual-check transcript summarised in the body, and the note that nothing uses the daemon yet.

---

## PR 2 — the embedding facade as default (`Closes #145`)

### Task 13: `DaemonConnection` — locate, spawn, poll, request

**Files:**
- Create: `src/modules/semantic/daemon-connection.ts`
- Test: `test/semantic/daemon-connection.test.ts`

**Interfaces:**
- Consumes: `DaemonPaths` (Task 1), `SocketConnect`, `Timers` (Task 4), `DaemonRpcError`, `DaemonErrorCode` (Task 5).
- Produces: `class DaemonUnavailableError extends Error`; `class DaemonConnectionError extends Error`; `interface DaemonConnectionDeps { paths: DaemonPaths; cliPath: string; connect: SocketConnect; spawn: (file: string, args: string[], opts: { detached: true; stdio: ['ignore', number, number]; windowsHide: true }) => { unref(): void }; openLog: (file: string) => number; closeFd: (fd: number) => void; mkdirp: (dir: string) => void; execPath: string; timers?: Timers; pollIntervalMs?: number; pollTimeoutMs?: number }`; `class DaemonConnection { constructor(deps); ensure(): Promise<void>; request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>; close(): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/semantic/daemon-connection.test.ts
import { Duplex, PassThrough } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { daemonPaths } from '../../src/daemon/paths.js';
import { DaemonConnection, DaemonConnectionError, DaemonUnavailableError } from '../../src/modules/semantic/daemon-connection.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** A fake daemon socket: `reply(request)` returns the message to send back, or undefined to stay silent. */
function fakeSocket(reply: (req: JSONRPCMessage & { method: string }) => JSONRPCMessage | undefined): Duplex {
  const buffer = new ReadBuffer();
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      buffer.append(chunk);
      for (;;) {
        const m = buffer.readMessage();
        if (!m) break;
        if (isJSONRPCRequest(m)) {
          const r = reply(m);
          if (r) socket.push(serializeMessage(r));
        }
      }
      cb();
    },
  });
  return socket;
}

const paths = daemonPaths({ version: '18.0.0', uid: 1, platform: 'linux', cacheBase: '/c' });

function deps(overrides: Partial<ConstructorParameters<typeof DaemonConnection>[0]> = {}) {
  return {
    paths, cliPath: '/opt/nv/dist/cli.js', execPath: '/usr/bin/node',
    connect: vi.fn(async () => fakeSocket((m) => ({ jsonrpc: '2.0', id: m.id, result: { ok: m.method } }))),
    spawn: vi.fn(() => ({ unref: vi.fn() })), openLog: vi.fn(() => 7), closeFd: vi.fn(), mkdirp: vi.fn(),
    pollIntervalMs: 1, pollTimeoutMs: 20,
    ...overrides,
  };
}

describe('DaemonConnection', () => {
  it('connects without spawning when the daemon listens', async () => {
    const d = deps();
    const c = new DaemonConnection(d);
    await expect(c.request('daemon.info', {}, 1000)).resolves.toEqual({ ok: 'daemon.info' });
    expect(d.spawn).not.toHaveBeenCalled();
  });
  it('spawns detached with the log fd and polls until the socket answers', async () => {
    let attempts = 0;
    const d = deps({
      connect: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw errno('ENOENT');
        return fakeSocket((m) => ({ jsonrpc: '2.0', id: m.id, result: {} }));
      }),
    });
    const c = new DaemonConnection(d);
    await c.ensure();
    expect(d.mkdirp).toHaveBeenCalledWith(paths.stateDir);
    expect(d.openLog).toHaveBeenCalledWith(paths.logFile);
    expect(d.spawn).toHaveBeenCalledWith('/usr/bin/node', ['/opt/nv/dist/cli.js', 'daemon'], { detached: true, stdio: ['ignore', 7, 7], windowsHide: true });
    expect(d.closeFd).toHaveBeenCalledWith(7);
  });
  it('refuses to spawn from a .ts entry point', async () => {
    const d = deps({ cliPath: '/repo/src/cli.ts', connect: vi.fn(async () => { throw errno('ENOENT'); }) });
    await expect(new DaemonConnection(d).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(d.spawn).not.toHaveBeenCalled();
  });
  it('wraps spawn and log failures and a poll timeout as unavailable', async () => {
    const refused = vi.fn(async () => { throw errno('ECONNREFUSED'); });
    await expect(new DaemonConnection(deps({ connect: refused, spawn: () => { throw new Error('EACCES'); } })).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(new DaemonConnection(deps({ connect: refused, openLog: () => { throw new Error('EROFS'); } })).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(new DaemonConnection(deps({ connect: refused })).ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });
  it('surfaces a JSON-RPC error as DaemonRpcError with its data.code', async () => {
    const d = deps({ connect: vi.fn(async () => fakeSocket((m) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'no weights', data: { code: 'EMBED_FAILED' } } }))) });
    await expect(new DaemonConnection(d).request('embed.initialize', { profile: 'x' }, 1000)).rejects.toMatchObject({ code: 'EMBED_FAILED', message: 'no weights' });
  });
  it('times out a request that is never answered', async () => {
    vi.useFakeTimers();
    const d = deps({ connect: vi.fn(async () => fakeSocket(() => undefined)) });
    const pending = new DaemonConnection(d).request('embed.query', { text: 'x' }, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toThrow(/embed\.query.*timed out/);
    vi.useRealTimers();
  });
  it('rejects pending requests when the socket closes and reconnects on the next call', async () => {
    const sockets: Duplex[] = [];
    const d = deps({ connect: vi.fn(async () => { const s = fakeSocket(() => undefined); sockets.push(s); return s; }) });
    const c = new DaemonConnection(d);
    const pending = c.request('embed.query', { text: 'x' }, 1000);
    await new Promise((r) => setTimeout(r, 0));
    sockets[0]!.destroy();
    await expect(pending).rejects.toBeInstanceOf(DaemonConnectionError);
    void c.request('embed.query', { text: 'y' }, 1000).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(d.connect).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/modules/semantic/daemon-connection.ts
import type { Duplex } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { isJSONRPCErrorResponse, isJSONRPCResponse, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { DaemonPaths } from '../../daemon/paths.js';
import type { SocketConnect, Timers } from '../../daemon/probe.js';
import { DaemonRpcError, type DaemonErrorCode } from '../../daemon/protocol.js';

/** The daemon could not be found or started; the caller falls back in-process. */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/** The connection dropped with requests in flight; the next call reconnects. */
export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonConnectionError';
  }
}

export interface SpawnLike {
  unref(): void;
}

export interface DaemonConnectionDeps {
  paths: DaemonPaths;
  cliPath: string;
  execPath: string;
  connect: SocketConnect;
  spawn: (
    file: string,
    args: string[],
    opts: { detached: true; stdio: ['ignore', number, number]; windowsHide: true },
  ) => SpawnLike;
  openLog: (file: string) => number;
  closeFd: (fd: number) => void;
  mkdirp: (dir: string) => void;
  timers?: Timers;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isNotListening(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export class DaemonConnection {
  private socket?: Duplex;
  private connecting?: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly timers: Timers;

  constructor(private readonly deps: DaemonConnectionDeps) {
    this.timers = deps.timers ?? { setTimeout, clearTimeout };
  }

  /** Connected, spawning the daemon first if nothing listens. Idempotent and coalescing. */
  ensure(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async establish(): Promise<void> {
    let socket: Duplex;
    try {
      socket = await this.deps.connect(this.deps.paths.socketPath);
    } catch (error) {
      if (!isNotListening(error)) throw new DaemonUnavailableError(`cannot reach the daemon: ${String(error)}`);
      this.spawnDaemon();
      socket = await this.poll();
    }
    this.attach(socket);
  }

  private spawnDaemon(): void {
    if (this.deps.cliPath.endsWith('.ts')) {
      throw new DaemonUnavailableError('the daemon cannot be started from a TypeScript entry point (development run)');
    }
    try {
      this.deps.mkdirp(this.deps.paths.stateDir);
      const log = this.deps.openLog(this.deps.paths.logFile);
      try {
        this.deps
          .spawn(this.deps.execPath, [this.deps.cliPath, 'daemon'], {
            detached: true,
            stdio: ['ignore', log, log],
            windowsHide: true,
          })
          .unref();
      } finally {
        this.deps.closeFd(log);
      }
    } catch (error) {
      if (error instanceof DaemonUnavailableError) throw error;
      throw new DaemonUnavailableError(`could not start the daemon: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async poll(): Promise<Duplex> {
    const interval = this.deps.pollIntervalMs ?? 50;
    const budget = this.deps.pollTimeoutMs ?? 10_000;
    for (let waited = 0; waited <= budget; waited += interval) {
      try {
        return await this.deps.connect(this.deps.paths.socketPath);
      } catch (error) {
        if (!isNotListening(error)) break;
      }
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, interval));
    }
    throw new DaemonUnavailableError(`the daemon did not answer within ${budget} ms (see ${this.deps.paths.logFile})`);
  }

  private attach(socket: Duplex): void {
    this.socket = socket;
    const buffer = new ReadBuffer();
    socket.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch {
          socket.destroy();
          return;
        }
        if (!message) return;
        this.settle(message);
      }
    });
    const drop = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const [id, entry] of this.pending) {
        this.timers.clearTimeout(entry.timer);
        entry.reject(new DaemonConnectionError(`daemon connection closed during ${entry.method}`));
        this.pending.delete(id);
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private settle(message: JSONRPCMessage): void {
    if (!isJSONRPCResponse(message) && !isJSONRPCErrorResponse(message)) return;
    const id = typeof message.id === 'number' ? message.id : Number.NaN;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.timers.clearTimeout(entry.timer);
    if (isJSONRPCErrorResponse(message)) {
      const data = message.error.data as { code?: DaemonErrorCode } | undefined;
      entry.reject(new DaemonRpcError(data?.code ?? 'INTERNAL', message.error.message));
    } else {
      entry.resolve(message.result);
    }
  }

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.ensure();
    const socket = this.socket;
    if (!socket) throw new DaemonConnectionError('daemon connection closed');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(serializeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/daemon-connection.ts test/semantic/daemon-connection.test.ts
git commit -m "feat(semantic): daemon connection — locate, spawn, poll, request"
```

### Task 14: `DaemonEmbeddingProvider` and the shared half of the factory

**Files:**
- Create: `src/modules/semantic/daemon-embedding-provider.ts`
- Modify: `src/modules/semantic/provider-factory.ts` (the `shared: true` branch)
- Test: `test/semantic/daemon-embedding-provider.test.ts`, extend `test/semantic/provider-factory.test.ts`

**Interfaces:**
- Produces: `DaemonEmbeddingProvider({ profile, connection, createFallback, stderr, logFile })` implementing `EmbeddingProvider`; `REQUEST_TIMEOUTS = { initialize: 900_000, query: 60_000, documents: 300_000 }`; the factory returns it for `shared: true`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/semantic/daemon-embedding-provider.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DaemonRpcError } from '../../src/daemon/protocol.js';
import { DaemonUnavailableError } from '../../src/modules/semantic/daemon-connection.js';
import { DaemonEmbeddingProvider } from '../../src/modules/semantic/daemon-embedding-provider.js';
import { identityOf, resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from '../../src/modules/semantic/types.js';

const profile = resolveModelProfile('granite-97m');

function fakeConnection(answers: Record<string, unknown | (() => never)>) {
  return {
    ensure: vi.fn(async () => {}),
    request: vi.fn(async (method: string) => {
      const a = answers[method];
      if (typeof a === 'function') (a as () => never)();
      return a;
    }),
    close: vi.fn(),
  };
}

function fallbackProvider(): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, identity: identityOf(profile), maxBatchSize: 8,
    initialize: async () => { calls.push('init'); },
    embedQuery: async () => { calls.push('query'); return [0.5]; },
    embedDocuments: async (t) => { calls.push('docs'); return t.map(() => [0.5]); },
  };
}

describe('DaemonEmbeddingProvider', () => {
  it('reports the local identity and takes the batch size from the daemon', async () => {
    const connection = fakeConnection({ 'embed.initialize': { identity: identityOf(profile), max_batch_size: 4 } });
    const p = new DaemonEmbeddingProvider({ profile, connection, createFallback: fallbackProvider, stderr: { write: () => true }, logFile: '/l' });
    expect(p.identity).toEqual(identityOf(profile));
    expect(p.maxBatchSize).toBe(8);
    await p.initialize();
    expect(p.maxBatchSize).toBe(4);
    expect(connection.request).toHaveBeenCalledWith('embed.initialize', { profile: 'granite-97m' }, 900_000);
  });
  it('embeds through the daemon', async () => {
    const connection = fakeConnection({ 'embed.query': { vector: [1, 0] }, 'embed.documents': { vectors: [[0, 1]] } });
    const p = new DaemonEmbeddingProvider({ profile, connection, createFallback: fallbackProvider, stderr: { write: () => true }, logFile: '/l' });
    await expect(p.embedQuery('hi')).resolves.toEqual([1, 0]);
    await expect(p.embedDocuments(['a'])).resolves.toEqual([[0, 1]]);
    expect(connection.request).toHaveBeenCalledWith('embed.query', { profile: 'granite-97m', text: 'hi' }, 60_000);
    expect(connection.request).toHaveBeenCalledWith('embed.documents', { profile: 'granite-97m', texts: ['a'] }, 300_000);
  });
  it('falls back once when the daemon is unavailable, with one stderr line', async () => {
    const lines: string[] = [];
    const connection = fakeConnection({});
    connection.ensure = vi.fn(async () => { throw new DaemonUnavailableError('no spawn'); });
    const fallback = fallbackProvider();
    const p = new DaemonEmbeddingProvider({ profile, connection, createFallback: () => fallback, stderr: { write: (s) => (lines.push(s), true) }, logFile: '/c/daemon.log' });
    await expect(p.embedQuery('x')).resolves.toEqual([0.5]);
    await expect(p.embedDocuments(['y'])).resolves.toEqual([[0.5]]);
    await p.initialize();
    expect(fallback.calls).toEqual(['query', 'docs', 'init']);
    expect(connection.ensure).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no spawn/);
    expect(lines[0]).toMatch(/\/c\/daemon\.log/);
  });
  it('does not fall back on EMBED_FAILED and retries next time', async () => {
    const connection = fakeConnection({ 'embed.initialize': () => { throw new DaemonRpcError('EMBED_FAILED', 'no weights'); } });
    const fallback = fallbackProvider();
    const p = new DaemonEmbeddingProvider({ profile, connection, createFallback: () => fallback, stderr: { write: () => true }, logFile: '/l' });
    await expect(p.initialize()).rejects.toThrow('no weights');
    await expect(p.initialize()).rejects.toThrow('no weights');
    expect(connection.request).toHaveBeenCalledTimes(2);
    expect(fallback.calls).toEqual([]);
  });
});
```

Extend `test/semantic/provider-factory.test.ts`:

```ts
  it('returns the daemon facade when shared, wired to the version-keyed paths', () => {
    const provider = createEmbeddingProvider({ profile, shared: true, cliPath: '/opt/nv/dist/cli.js', version: '18.0.0', env: {}, home: '/home/u', uid: 1, platform: 'linux' });
    expect(provider).toBeInstanceOf(DaemonEmbeddingProvider);
    expect(provider.identity).toEqual(identityOf(profile));
  });
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/modules/semantic/daemon-embedding-provider.ts
import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';
import type { EmbedDocumentsResult, EmbedInitializeResult, EmbedQueryResult } from '../../daemon/protocol.js';
import { DaemonUnavailableError } from './daemon-connection.js';
import { identityOf, type ModelProfile } from './model-profiles.js';
import type { EmbeddingProvider } from './types.js';

export const REQUEST_TIMEOUTS = {
  /** First run downloads the weights; minutes, not seconds. */
  initialize: 900_000,
  query: 60_000,
  documents: 300_000,
} as const;

/** What the facade needs from a connection — `DaemonConnection` in production. */
export interface DaemonLink {
  ensure(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
  close(): void;
}

export interface DaemonEmbeddingProviderDeps {
  profile: ModelProfile;
  connection: DaemonLink;
  /** The in-process provider, built only if the daemon is unavailable. */
  createFallback: () => EmbeddingProvider;
  stderr: { write(chunk: string): boolean };
  logFile: string;
}

/**
 * `EmbeddingProvider` over the shared daemon. Identity is computed locally:
 * the daemon runs this same code at this same version, so its vectors are
 * ours. The batch size is the daemon's to report (a remote-backed profile has
 * its own limits), so it is taken from `embed.initialize`.
 *
 * Fallback is a one-way switch per process: once the daemon could not be
 * located or started, this process embeds in-process for the rest of its life
 * and says so once on stderr. A daemon that answers but fails to load the
 * model is *not* that case — that error is surfaced like a local load failure
 * and the next call retries through the daemon.
 */
export class DaemonEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  maxBatchSize = 8;
  private fallback?: EmbeddingProvider;

  constructor(private readonly deps: DaemonEmbeddingProviderDeps) {
    this.identity = identityOf(deps.profile);
  }

  private async viaDaemon<T>(work: () => Promise<T>, viaFallback: (p: EmbeddingProvider) => Promise<T>): Promise<T> {
    if (this.fallback) return viaFallback(this.fallback);
    try {
      await this.deps.connection.ensure();
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
      this.fallback = this.deps.createFallback();
      this.maxBatchSize = this.fallback.maxBatchSize;
      this.deps.stderr.write(
        `shared embedding daemon unavailable (${error.message}); embedding in-process for this session — see ${this.deps.logFile}\n`,
      );
      return viaFallback(this.fallback);
    }
    return work();
  }

  async initialize(): Promise<void> {
    await this.viaDaemon(
      async () => {
        const result = await this.deps.connection.request<EmbedInitializeResult>(
          'embed.initialize',
          { profile: this.deps.profile.key },
          REQUEST_TIMEOUTS.initialize,
        );
        this.maxBatchSize = result.max_batch_size;
      },
      (p) => p.initialize(),
    );
  }

  embedQuery(text: string): Promise<number[]> {
    return this.viaDaemon(
      async () =>
        (
          await this.deps.connection.request<EmbedQueryResult>(
            'embed.query',
            { profile: this.deps.profile.key, text },
            REQUEST_TIMEOUTS.query,
          )
        ).vector,
      (p) => p.embedQuery(text),
    );
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.viaDaemon(
      async () =>
        (
          await this.deps.connection.request<EmbedDocumentsResult>(
            'embed.documents',
            { profile: this.deps.profile.key, texts },
            REQUEST_TIMEOUTS.documents,
          )
        ).vectors,
      (p) => p.embedDocuments(texts),
    );
  }
}
```

Replace the `throw` in `provider-factory.ts` with:

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { neuroVaultCacheBase } from '../../lib/cache-dir.js';
import { daemonPaths } from '../../daemon/paths.js';
import { defaultConnect } from '../../daemon/probe.js';
import { DaemonConnection } from './daemon-connection.js';
import { DaemonEmbeddingProvider } from './daemon-embedding-provider.js';
// …
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const paths = daemonPaths({
    version: opts.version ?? '0.0.0',
    uid: opts.uid ?? os.userInfo().uid,
    platform: opts.platform ?? process.platform,
    cacheBase: neuroVaultCacheBase(env, home),
  });
  const connection = new DaemonConnection({
    paths,
    cliPath: opts.cliPath ?? '',
    execPath: process.execPath,
    connect: defaultConnect,
    spawn: (file, args, spawnOpts) => spawn(file, args, spawnOpts),
    openLog: (file) => fs.openSync(file, 'a'),
    closeFd: (fd) => fs.closeSync(fd),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  });
  return new DaemonEmbeddingProvider({
    profile: opts.profile,
    connection,
    createFallback: () => new EmbeddingService({ profile: opts.profile, loader: opts.loader }),
    stderr: opts.stderr ?? process.stderr,
    logFile: paths.logFile,
  });
```

(`version` and `cliPath` are required in practice; the server and `index` pass `packageMeta.version` and the resolved CLI path. An empty `cliPath` can never end in `.ts`, so a caller that forgets it gets a spawn of `node daemon` that fails and a clean fallback — covered by the Task 13 spawn-failure test.)

- [ ] **Step 4: Run tests** — `npx vitest run test/semantic/daemon-embedding-provider.test.ts test/semantic/provider-factory.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/daemon-embedding-provider.ts src/modules/semantic/provider-factory.ts test/semantic/daemon-embedding-provider.test.ts test/semantic/provider-factory.test.ts
git commit -m "feat(semantic): daemon-backed embedding provider with one-way fallback"
```

### Task 15: `--shared` flag and the wiring in the server, `index` and the daemon

**Files:**
- Modify: `src/config.ts`, `src/types.ts`, `src/cli.ts`, `src/server.ts:120-126`, `src/cli-index.ts:38-46`, `src/cli-daemon.ts` (Task 11's `createProvider` default already uses the factory)
- Test: `test/config.test.ts`, `test/server-modules.test.ts`, `test/server-instructions.test.ts`, `test/cli-index.test.ts`

**Interfaces:**
- Produces: `ServerConfig.semantic.shared: boolean`; `IndexCliOptions.shared: boolean`; `NeuroVaultStartupDependencies.cliPath?: string` and `.embeddingProvider?: EmbeddingProvider`; `IndexCommandDeps.cliPath?: string`.

- [ ] **Step 1: Write the failing tests** (append to `test/config.test.ts`)

```ts
  it('defaults --shared to true on the server and index, and honours --no-shared', async () => {
    const run = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    if (run.kind !== 'run') throw new Error('expected run');
    expect(run.config.semantic.shared).toBe(true);
    const off = await parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-shared']);
    if (off.kind !== 'run') throw new Error('expected run');
    expect(off.config.semantic.shared).toBe(false);
    const index = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath, '--no-shared']);
    if (index.kind !== 'index') throw new Error('expected index');
    expect(index.options.shared).toBe(false);
  });
```

Add to `test/server-modules.test.ts` (next to the warmup-gating tests) a test that the server's warmup goes through the injected provider:

```ts
  it('warms up through the injected embedding provider', async () => {
    const vaultPath = await createTempVaultPath();
    const initialize = vi.fn(async () => {});
    const provider = {
      identity: identityOf(resolveModelProfile(DEFAULT_MODEL_KEY)), maxBatchSize: 8, initialize,
      embedQuery: vi.fn(), embedDocuments: vi.fn(),
    };
    await startNeuroVaultServer(
      { vaults: [{ name: path.basename(vaultPath), path: vaultPath }], semantic: { enabled: true, shared: true, model: resolveModelProfile(DEFAULT_MODEL_KEY) } },
      {
        embeddingProvider: provider,
        vaultEntryDeps: { semanticBackendFactory: () => ({ snapshot: () => Promise.reject(new Error('unused')), status: () => ({ state: 'ready' }), dispose: async () => {} }) },
        serverFactory: () => createFakeServer() as never,
        transportFactory: () => ({}) as never,
        stdin: new PassThrough(),
      },
    );
    await settle();
    expect(initialize).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/config.test.ts test/server-modules.test.ts` → the new cases FAIL; `npm run typecheck` reports the missing `shared` field in every fixture (expected).

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
export interface ServerConfig {
  vaults: IVaultConfig[];
  semantic: {
    enabled: boolean;
    /** The one embedding profile this process serves (design D3). */
    model: ModelProfile;
    /** Embed through the shared daemon (default) or load the model in-process. */
    shared: boolean;
  };
}
```

`src/config.ts`: add `shared: boolean` to `IndexCliOptions`; declare once

```ts
const SHARED_OPTION = {
  type: 'boolean',
  default: true,
  describe:
    'Embed through the shared per-machine daemon (started on demand). --no-shared loads the model in this process.',
} as const;
```

attach `.option('shared', SHARED_OPTION)` to both `$0` and `index`; set `shared: (args.shared as boolean | undefined) ?? true` in both outcomes.

`src/cli.ts`: compute the CLI path once and pass it down:

```ts
const CLI_PATH = realpathSync(fileURLToPath(import.meta.url));
// index branch:
process.exitCode = await runIndexCommand(parsed.options, { cliPath: CLI_PATH, ...deps.index });
// run branch:
await startNeuroVaultServer(parsed.config, { cliPath: CLI_PATH, ...deps.server });
```

(`import.meta.url` here is `dist/cli.js` in the bundle and `src/cli.ts` under tsx — the `.ts` suffix is exactly what triggers the development fallback.)

`src/server.ts`: replace lines 124–125 with

```ts
  const provider =
    deps.embeddingProvider ??
    createEmbeddingProvider({
      profile: config.semantic.model,
      shared: config.semantic.shared,
      cliPath: deps.cliPath,
      version: SERVER_VERSION,
    });
  const embedder = createQueuedEmbedder(provider);
  const identity = corpusIdentityOf(provider.identity);
```

drop the `EmbeddingService` import, import `createEmbeddingProvider` and `type EmbeddingProvider`, and add `cliPath?: string; embeddingProvider?: EmbeddingProvider;` to `NeuroVaultStartupDependencies` (documented: the provider override is for tests).

`src/cli-index.ts`: `defaultEmbedder(profile, shared, cliPath)` builds `createEmbeddingProvider({ profile, shared, cliPath, version: packageMeta.version })` and wraps it in the queue as today; `IndexCommandDeps.cliPath?: string`; `runIndexCommand` passes `options.shared`.

Fixtures: add `shared: false` to every `semantic: { enabled, model }` literal in `test/server-modules.test.ts` (7) and `test/server-instructions.test.ts` (1), and `shared: false` to the `IndexCliOptions` literals in `test/cli-index.test.ts`.

- [ ] **Step 4: Run the full gate** — `npm test && npm run lint && npm run typecheck && npm run build` → green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/types.ts src/cli.ts src/server.ts src/cli-index.ts test/config.test.ts test/server-modules.test.ts test/server-instructions.test.ts test/cli-index.test.ts
git commit -m "feat(semantic): embed through the shared daemon by default; --no-shared opts out"
```

### Task 16: Manual verification, measurements, docs, close-out

**Files:**
- Modify: `docs/architecture/shared-daemon.md` (facade section), `docs/architecture/embedding-pipeline.md`, `docs/architecture/semantic-backend.md`, `docs/guide/installation.md`, `docs/guide/configuration.md`, `README.md`
- Create: `verify.md`, `retrospective.md` (via `/opsx:verify`, then the schema's retrospective step)

- [ ] **Step 1: Manual check, recorded for verify.md**

1. Build; start two Claude Code sessions with the existing stdio config; run `search_notes` in both; `node dist/cli.js daemon status` → one daemon, `clients 2`, `loaded [harrier-270m]`.
2. `node dist/cli.js index --vault <v>` while a session is open → `daemon status` still shows one loaded profile; `ps` shows no second model-sized process.
3. Bump the version in `package.json` locally, `npm run build`, open a third session → `daemon status` shows two daemons (two versions); the first two sessions keep answering; close them; after the idle timeout the old daemon is gone from `status`.
4. `--no-shared` in a test config → no daemon spawned (`status` unchanged), `search_notes` works.
5. `npm run dev -- --vault <v>` (tsx) → one stderr line "unavailable … TypeScript entry point … daemon.log"; tools work.
6. `daemon stop` with a session open → the session's next `search_notes` respawns the daemon and succeeds.

- [ ] **Step 2: Measure** (throwaway script in the session scratchpad, numbers into verify.md): RSS (`ps -o rss`) of the daemon plus three sessions after each ran `search_notes` five times, versus three `--no-shared` sessions after the same; p95 latency of `search_notes` with three sessions issuing concurrently, daemon vs `--no-shared`.

- [ ] **Step 3: Docs**

- `docs/architecture/embedding-pipeline.md`: a "Where the model lives" section — the provider factory, the facade, the daemon, `--no-shared`; link to `shared-daemon.md`.
- `docs/architecture/semantic-backend.md`: the shared-queue paragraph now says there are two queues (per process, and per profile in the daemon) and what each orders.
- `docs/architecture/shared-daemon.md`: the facade section (lazy connect, spawn, timeouts, one-way fallback, `EMBED_FAILED` semantics, `index` sharing the model).
- `docs/guide/installation.md`: "What runs" — the first semantic call starts one background `neuro-vault-mcp daemon` per installed version; it exits 30 minutes after the last session; log at `~/.cache/neuro-vault/daemons/<key>/daemon.log`; `neuro-vault-mcp daemon status` / `stop`; `--no-shared` to keep everything in one process.
- `docs/guide/configuration.md`: `--shared` row in the CLI table; `daemon` command section (`status`, `stop`, `--idle-timeout`); the Limitations bullet "One embedding model per process" becomes "one per machine per profile (per process with `--no-shared`)"; a troubleshooting entry "the daemon log says …".
- `README.md`: the "Zero infrastructure" line becomes "no database, no API keys; one shared background process per machine, started on demand and gone when idle".

- [ ] **Step 4: Verify, retrospective, archive, PR**

Run `/opsx:verify` and fix until it passes (the gates: `npm test`, `npm run lint`, `npx tsc --noEmit`; docs updated for the changed CLI surface). Write `retrospective.md`. `npx openspec archive -y`. `gh pr create` with `Closes #145`, release notes in the body (what runs, where the files are, `--no-shared`, `daemon status|stop`, the model-changing-upgrade overlap and `daemon stop`).

```bash
git add docs README.md openspec
git commit -m "docs: shared embedding daemon — guide, architecture, release notes"
```
