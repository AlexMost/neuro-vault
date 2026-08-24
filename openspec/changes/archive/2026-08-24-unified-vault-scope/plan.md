# unified-vault-scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One per-vault scope module answers "which vault files are visible" for every discovery surface, consumed by `vault-reader.scan`; exclusions layer as always-dot → `Templates/` + root `.gitignore` → union with `.neuro-vault/config.json` `"exclusions"`.

**Architecture:** A pure scope module (`createVaultScope`) compiles the three exclusion layers into an `isExcluded(relPath)` picomatch predicate plus an `ignorePatterns` view; an I/O loader (`loadVaultScope`) reads the vault's root `.gitignore` and `.neuro-vault/config.json` and warns on invalid config. The scope hangs off each `IVaultEntry`; `FsVaultReader.scan` post-filters results through the predicate (authoritative) and passes `ignorePatterns` to fast-glob on unprefixed scans as a traversal prune. All eight scan consumers inherit membership untouched.

**Tech Stack:** TypeScript strict ESM, Node ≥ 20, vitest, fast-glob (existing), picomatch (new direct dependency).

**Spec:** `openspec/changes/unified-vault-scope/specs/vault-scope/spec.md`, `openspec/changes/unified-vault-scope/specs/headless-vault-operations/spec.md`; design: `openspec/changes/unified-vault-scope/design.md`.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must pass before every commit (repo gate; typecheck is authoritative, a tsup build is not).
- Strict TS, ESM: relative imports carry `.js` extensions.
- All warnings go to **stderr** (`console.error`) — stdout is the MCP stdio transport and must stay clean.
- Paths handed to the scope are vault-relative POSIX paths (the `scan` output convention).
- No CLI surface change, no MCP parameter change, no ADR in this slice.
- Conventional Commits (`feat:`, `test:`, `docs:` …).

---

### Task 1: Add picomatch as a direct dependency

**Files:**
- Modify: `package.json` (+ lockfile)

`picomatch` is transitive-only today (prod copy nested under `micromatch`); importing it without declaring it is a phantom dependency (design D3).

- [ ] **Step 1: Install**

```bash
npm install picomatch && npm install -D @types/picomatch
```

- [ ] **Step 2: Verify it resolves at the top level**

Run: `node -e "import('picomatch').then(m => console.log(typeof m.default))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add picomatch as a direct dependency"
```

---

### Task 2: Pure scope module — `createVaultScope`

**Files:**
- Create: `src/lib/obsidian/vault-scope.ts`
- Test: `test/lib/obsidian/vault-scope.test.ts`

**Interfaces:**
- Consumes: `picomatch` (Task 1).
- Produces: `VaultScope { ignorePatterns: string[]; isExcluded(relPath: string): boolean }`, `VaultScopeInput { gitignoreLines?: string[]; configExclusions?: string[] }`, `createVaultScope(input?: VaultScopeInput): VaultScope`, `gitignoreLinesToPatterns(lines: string[]): string[]`. Tasks 3–5 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/vault-scope.test.ts
import { describe, expect, it } from 'vitest';

import {
  createVaultScope,
  gitignoreLinesToPatterns,
} from '../../../src/lib/obsidian/vault-scope.js';

describe('gitignoreLinesToPatterns', () => {
  it('skips blank, comment, and negation lines', () => {
    const lines = ['', '# a comment', '!build/keep.md', 'build/', '  '];
    expect(gitignoreLinesToPatterns(lines)).toEqual(['build', 'build/**']);
  });

  it('strips leading and trailing slashes and excludes the subtree', () => {
    expect(gitignoreLinesToPatterns(['/dist/'])).toEqual(['dist', 'dist/**']);
  });
});

describe('createVaultScope', () => {
  it('always excludes dot-segment paths, regardless of configuration', () => {
    const scope = createVaultScope();
    expect(scope.isExcluded('.obsidian/workspace.md')).toBe(true);
    expect(scope.isExcluded('.neuro-vault/eval/golden.md')).toBe(true);
    expect(scope.isExcluded('sub/.trash/x.md')).toBe(true);
    expect(scope.isExcluded('Projects/x.md')).toBe(false);
  });

  it('excludes Templates/ by default', () => {
    const scope = createVaultScope();
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(scope.isExcluded('Templates.md')).toBe(false);
  });

  it('excludes gitignore entries and their subtrees', () => {
    const scope = createVaultScope({ gitignoreLines: ['docs/superpowers/'] });
    expect(scope.isExcluded('docs/superpowers/specs/a.md')).toBe(true);
    expect(scope.isExcluded('docs/other.md')).toBe(false);
  });

  it('ignores negation lines (the negated path stays excluded)', () => {
    const scope = createVaultScope({ gitignoreLines: ['build/', '!build/keep.md'] });
    expect(scope.isExcluded('build/keep.md')).toBe(true);
  });

  it('unions config globs with the defaults', () => {
    const scope = createVaultScope({ configExclusions: ['Archive/**'] });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true); // default survives
  });

  it('exposes the same membership via ignorePatterns', () => {
    // Agreement between the two views (spec vault-scope R1): every pattern-
    // excluded path is predicate-excluded; the dot rule is predicate-only
    // because enumeration already runs with dot: false.
    const scope = createVaultScope({ configExclusions: ['Archive/**'] });
    expect(scope.ignorePatterns).toEqual(
      expect.arrayContaining(['Templates', 'Templates/**', 'Archive/**']),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/vault-scope.test.ts`
Expected: FAIL — cannot resolve `src/lib/obsidian/vault-scope.js`

- [ ] **Step 3: Implement the module**

```ts
// src/lib/obsidian/vault-scope.ts
import picomatch from 'picomatch';

/**
 * The single definition of "which vault files are visible" (capability
 * vault-scope). Scope is discovery, not ACL: read_notes by explicit path
 * bypasses it by design.
 */
export interface VaultScope {
  /**
   * Vault-root-anchored exclusion globs, suitable for fast-glob's `ignore`.
   * A traversal prune only — `isExcluded` is the authoritative test (it also
   * carries the unconditional dot-segment rule, which enumeration already
   * handles via `dot: false`).
   */
  ignorePatterns: string[];
  /** Authoritative membership test for a vault-relative POSIX path. */
  isExcluded(relPath: string): boolean;
}

export interface VaultScopeInput {
  /** Raw lines of the vault root's `.gitignore`; omit when the file is absent. */
  gitignoreLines?: string[];
  /** Globs from `.neuro-vault/config.json` `"exclusions"`, unioned with defaults. */
  configExclusions?: string[];
}

const DEFAULT_EXCLUDED_DIRS = ['Templates'];

/**
 * Minimal gitignore subset (design D4): root file only; blank, comment, and
 * negation lines are skipped; each entry, stripped of leading/trailing
 * slashes, excludes the named path and its whole subtree, anchored at the
 * vault root. Deliberately not git's "match at any level" semantics.
 */
export function gitignoreLinesToPatterns(lines: string[]): string[] {
  const patterns: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const entry = line.replace(/^\//, '').replace(/\/$/, '');
    if (entry === '') continue;
    patterns.push(entry, `${entry}/**`);
  }
  return patterns;
}

function hasDotSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

export function createVaultScope(input: VaultScopeInput = {}): VaultScope {
  const patterns = [
    ...DEFAULT_EXCLUDED_DIRS.flatMap((d) => [d, `${d}/**`]),
    ...gitignoreLinesToPatterns(input.gitignoreLines ?? []),
    ...(input.configExclusions ?? []),
  ];
  const matches = picomatch(patterns, { dot: true });
  return {
    ignorePatterns: patterns,
    isExcluded(relPath: string): boolean {
      return hasDotSegment(relPath) || (patterns.length > 0 && matches(relPath));
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/vault-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/vault-scope.ts test/lib/obsidian/vault-scope.test.ts
git commit -m "feat: add vault scope module (dot rule, defaults, gitignore subset, config union)"
```

---

### Task 3: I/O loader — `loadVaultScope` with best-effort config

**Files:**
- Create: `src/lib/obsidian/vault-scope-config.ts`
- Test: `test/lib/obsidian/vault-scope-config.test.ts`

**Interfaces:**
- Consumes: `createVaultScope`, `VaultScope` (Task 2).
- Produces: `SCOPE_CONFIG_PATH = '.neuro-vault/config.json'`, `loadVaultScope(vaultRoot: string, opts?: { readFile?: (p: string, enc: 'utf8') => Promise<string>; warn?: (message: string) => void }): Promise<VaultScope>`. Task 4 wires this as the production `scopeFactory`.

Failure contract (design D5, spec vault-scope R4): missing file → defaults silently (`ENOENT`); unreadable file, invalid JSON, or non-string-array `"exclusions"` → defaults + one stderr warning naming the vault; never throws.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/vault-scope-config.test.ts
import { describe, expect, it, vi } from 'vitest';

import { loadVaultScope } from '../../../src/lib/obsidian/vault-scope-config.js';

function enoent(): Error {
  const err = new Error('ENOENT') as Error & { code?: string };
  err.code = 'ENOENT';
  return err;
}

/** files: vault-relative posix path → content; anything else throws ENOENT. */
function fakeReadFile(files: Record<string, string>) {
  return vi.fn(async (absPath: string) => {
    const hit = Object.entries(files).find(([rel]) => absPath.endsWith(rel));
    if (!hit) throw enoent();
    return hit[1];
  });
}

describe('loadVaultScope', () => {
  it('builds defaults silently when gitignore and config are both absent', async () => {
    const warn = vi.fn();
    const scope = await loadVaultScope('/v', { readFile: fakeReadFile({}), warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(scope.isExcluded('Projects/x.md')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('layers root gitignore entries into the scope', async () => {
    const readFile = fakeReadFile({ '.gitignore': 'docs/superpowers/\n!docs/superpowers/keep.md\n' });
    const scope = await loadVaultScope('/v', { readFile, warn: vi.fn() });
    expect(scope.isExcluded('docs/superpowers/specs/a.md')).toBe(true);
    expect(scope.isExcluded('docs/superpowers/keep.md')).toBe(true); // negation ignored
  });

  it('unions config exclusions with defaults', async () => {
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: ['Archive/**'] }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn: vi.fn() });
    expect(scope.isExcluded('Archive/old.md')).toBe(true);
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
  });

  it('warns and falls back to defaults on invalid JSON', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({ '.neuro-vault/config.json': '{ not json' });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Templates/Daily.md')).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('/v');
  });

  it('warns and falls back when exclusions is not a string array', async () => {
    const warn = vi.fn();
    const readFile = fakeReadFile({
      '.neuro-vault/config.json': JSON.stringify({ exclusions: 'Archive/**' }),
    });
    const scope = await loadVaultScope('/v', { readFile, warn });
    expect(scope.isExcluded('Archive/old.md')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns on an unreadable (non-ENOENT) config', async () => {
    const warn = vi.fn();
    const readFile = vi.fn(async (absPath: string) => {
      if (absPath.endsWith('.neuro-vault/config.json')) {
        const err = new Error('EACCES') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      }
      throw enoent();
    });
    await loadVaultScope('/v', { readFile, warn });
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/vault-scope-config.test.ts`
Expected: FAIL — cannot resolve `src/lib/obsidian/vault-scope-config.js`

- [ ] **Step 3: Implement the loader**

```ts
// src/lib/obsidian/vault-scope-config.ts
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { createVaultScope, type VaultScope } from './vault-scope.js';

/** Vault-relative location of the per-vault scope config. */
export const SCOPE_CONFIG_PATH = '.neuro-vault/config.json';

export interface LoadVaultScopeOptions {
  readFile?: (p: string, enc: 'utf8') => Promise<string>;
  /** Defaults to stderr — stdout is the MCP transport and must stay clean. */
  warn?: (message: string) => void;
}

/**
 * Build a vault's scope from its root `.gitignore` and
 * `.neuro-vault/config.json`. Never throws: a missing file means defaults,
 * silently; an unreadable or invalid config means defaults plus one stderr
 * warning naming the vault (design D5 — a scope typo must be visible, but one
 * bad vault must not kill a multi-vault server).
 */
export async function loadVaultScope(
  vaultRoot: string,
  opts: LoadVaultScopeOptions = {},
): Promise<VaultScope> {
  const readFile = opts.readFile ?? ((p, enc) => fsReadFile(p, enc));
  const warn = opts.warn ?? ((message) => console.error(message));

  let gitignoreLines: string[] | undefined;
  try {
    gitignoreLines = (await readFile(path.join(vaultRoot, '.gitignore'), 'utf8')).split(/\r?\n/);
  } catch {
    gitignoreLines = undefined;
  }

  let configExclusions: string[] | undefined;
  try {
    const raw = await readFile(path.join(vaultRoot, SCOPE_CONFIG_PATH), 'utf8');
    configExclusions = parseExclusions(raw, vaultRoot, warn);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      warn(`neuro-vault: cannot read ${SCOPE_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`);
    }
  }

  return createVaultScope({ gitignoreLines, configExclusions });
}

function parseExclusions(
  raw: string,
  vaultRoot: string,
  warn: (message: string) => void,
): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`neuro-vault: invalid JSON in ${SCOPE_CONFIG_PATH} for vault at ${vaultRoot}; using default scope`);
    return undefined;
  }
  const exclusions = (parsed as { exclusions?: unknown }).exclusions;
  if (exclusions === undefined) return undefined;
  if (!Array.isArray(exclusions) || !exclusions.every((e) => typeof e === 'string')) {
    warn(
      `neuro-vault: "exclusions" in ${SCOPE_CONFIG_PATH} must be a string array (vault at ${vaultRoot}); using default scope`,
    );
    return undefined;
  }
  return exclusions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/vault-scope-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/vault-scope-config.ts test/lib/obsidian/vault-scope-config.test.ts
git commit -m "feat: load per-vault scope from root gitignore and .neuro-vault/config.json"
```

---

### Task 4: Wire scope into the registry and server

**Files:**
- Modify: `src/lib/vault-registry.ts` (`IVaultEntry` ~L13-42, `IVaultEntryDeps` ~L44-63, `VaultRegistry.create` ~L100-154)
- Modify: `src/server.ts` (`buildDefaultVaultEntryDeps` ~L80-96)
- Test: `test/lib/vault-registry.test.ts` (existing fixtures gain the new factory)

**Interfaces:**
- Consumes: `VaultScope` (Task 2), `loadVaultScope` (Task 3).
- Produces: `IVaultEntry.scope: VaultScope`; `IVaultEntryDeps.scopeFactory: (opts: { vaultRoot: string }) => Promise<VaultScope>`; `readerFactory` signature becomes `(opts: { vaultRoot: string; scope: VaultScope }) => VaultReader`. Task 5 relies on the reader receiving `scope`.

- [ ] **Step 1: Write the failing test**

Add to `test/lib/vault-registry.test.ts` (extend the existing deps fixture with `scopeFactory`; the suite's fixture builder must now include it or compilation fails — that compile failure is part of the red step):

```ts
it('builds a scope per entry and passes it to the reader factory', async () => {
  const scope = createVaultScope({ configExclusions: ['Archive/**'] });
  const scopeFactory = vi.fn(async () => scope);
  const readerFactory = vi.fn(({ vaultRoot: _vaultRoot, scope: s }) => fakeReader(s));
  const registry = await VaultRegistry.create(
    { vaults: [vault('A', '/a')], semanticEnabled: false, modelKey: 'k' },
    { ...fakeDeps(), scopeFactory, readerFactory },
  );
  expect(scopeFactory).toHaveBeenCalledWith({ vaultRoot: '/a' });
  expect(readerFactory).toHaveBeenCalledWith({ vaultRoot: '/a', scope });
  expect(registry.require('A').scope).toBe(scope);
});
```

(Adapt `vault`/`fakeDeps`/`fakeReader` helper names to the file's existing helpers — reuse them, do not invent a parallel fixture set.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: FAIL — `scopeFactory` not in `IVaultEntryDeps` (type error) / `scope` missing on entry

- [ ] **Step 3: Implement**

In `src/lib/vault-registry.ts`:

```ts
import type { VaultScope } from './obsidian/vault-scope.js';

// IVaultEntry gains:
  /**
   * This vault's discovery scope (capability vault-scope): the single
   * definition of which files are visible to scan-derived surfaces.
   */
  scope: VaultScope;

// IVaultEntryDeps changes:
  readerFactory: (opts: { vaultRoot: string; scope: VaultScope }) => VaultReader;
  scopeFactory: (opts: { vaultRoot: string }) => Promise<VaultScope>;

// VaultRegistry.create, per vault (before the reader is built):
      const scope = await deps.scopeFactory({ vaultRoot: v.path });
      const reader = deps.readerFactory({ vaultRoot: v.path, scope });
// and push `scope` onto the entry object literal.
```

In `src/server.ts` `buildDefaultVaultEntryDeps`:

```ts
    readerFactory: ({ vaultRoot, scope }) => new FsVaultReader({ vaultRoot, scope }),
    scopeFactory: ({ vaultRoot }) => loadVaultScope(vaultRoot),
```

with `import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';`. (`FsVaultReader` does not accept `scope` until Task 5 — implement Tasks 4 and 5 back-to-back; the intermediate state only needs to compile at the end of Task 5. If you want each task green in isolation, land Task 5's reader change first and flip the two task orders — the tests don't care.)

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: PASS (after Task 5's reader change if you kept this order — see note above)

- [ ] **Step 5: Commit** (may be combined with Task 5's commit if landed together)

```bash
git add src/lib/vault-registry.ts src/server.ts test/lib/vault-registry.test.ts
git commit -m "feat: build a discovery scope per vault entry"
```

---

### Task 5: `FsVaultReader.scan` consumes the scope

**Files:**
- Modify: `src/lib/obsidian/vault-reader.ts` (`FsGlob` type L51-54, `FsVaultReaderOptions` L56-61, constructor L69-75, `scan` L82-113)
- Test: `test/lib/obsidian/vault-reader.test.ts` (exact-options assertions L158-163 and L204-209 change; new cases added)

**Interfaces:**
- Consumes: `VaultScope` (Task 2).
- Produces: `FsVaultReaderOptions.scope?: VaultScope` (optional — absent scope preserves today's behaviour exactly, keeping every existing reader construction valid); `FsGlob` options gain `ignore: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/obsidian/vault-reader.test.ts`:

```ts
import { createVaultScope } from '../../../src/lib/obsidian/vault-scope.js';

it('filters scoped-out paths and passes ignore patterns on unprefixed scans', async () => {
  const scope = createVaultScope({ configExclusions: ['Archive/**'] });
  const glob = vi.fn(async () => ['a.md', 'Archive/old.md', 'Templates/t.md']);
  const reader = new FsVaultReader({ vaultRoot: '/v', glob, scope });

  const out = await reader.scan();

  expect(out).toEqual(['a.md']);
  expect(glob).toHaveBeenCalledWith('**/*.md', {
    cwd: '/v',
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: scope.ignorePatterns,
  });
});

it('filters prefixed scans through the predicate without rewriting patterns', async () => {
  // cwd moves to the prefix dir, so root-anchored ignore globs cannot be
  // passed; the post-filter on re-prefixed paths is the authoritative check.
  const scope = createVaultScope({ gitignoreLines: ['docs/superpowers/'] });
  const stat = fakeStat(new Set(['/v/docs']));
  const glob = vi.fn(async () => ['intro.md', 'superpowers/a.md']);
  const reader = new FsVaultReader({ vaultRoot: '/v', stat, glob, scope });

  const out = await reader.scan({ pathPrefix: 'docs' });

  expect(out).toEqual(['docs/intro.md']);
  expect(glob).toHaveBeenCalledWith('**/*.md', {
    cwd: '/v/docs',
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: [],
  });
});
```

Also update the two existing exact-options assertions (L158-163, L204-209) to include `ignore: []` (a scope-less reader passes an empty ignore list).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/vault-reader.test.ts`
Expected: FAIL — `scope` not a known option; glob called without `ignore`

- [ ] **Step 3: Implement**

In `src/lib/obsidian/vault-reader.ts`:

```ts
import type { VaultScope } from './vault-scope.js';

export type FsGlob = (
  pattern: string,
  options: {
    cwd: string;
    onlyFiles: boolean;
    dot: boolean;
    followSymbolicLinks: boolean;
    ignore: string[];
  },
) => Promise<string[]>;

export interface FsVaultReaderOptions {
  vaultRoot: string;
  scope?: VaultScope;
  readFile?: FsReadFile;
  stat?: FsStat;
  glob?: FsGlob;
}

// constructor: this.scope = opts.scope;  (private readonly scope?: VaultScope)

// scan(), replacing L102-113:
    const cwd = prefix ? path.join(this.vaultRoot, prefix) : this.vaultRoot;
    // Root-anchored ignore globs only make sense when cwd IS the vault root;
    // prefixed scans rely on the predicate post-filter below instead.
    const ignore = !prefix && this.scope ? this.scope.ignorePatterns : [];
    const matches = await this.glob('**/*.md', {
      cwd,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore,
    });
    const rel = prefix
      ? matches.map((m) => `${prefix}/${toPosixSlashes(m)}`)
      : matches.map(toPosixSlashes);
    const scope = this.scope;
    const visible = scope ? rel.filter((p) => !scope.isExcluded(p)) : rel;
    return visible.sort();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/vault-reader.test.ts`
Expected: PASS, including the updated exact-options assertions

- [ ] **Step 5: Run the full gate (Tasks 4+5 touch shared wiring)**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/obsidian/vault-reader.ts test/lib/obsidian/vault-reader.test.ts
git commit -m "feat: scan consumes the vault scope (predicate-filtered, ignore-pruned)"
```

---

### Task 6: End-to-end membership over a real vault

**Files:**
- Create: `test/lib/obsidian/vault-scope-e2e.test.ts`

**Interfaces:**
- Consumes: `FsVaultReader` + `scope` (Task 5), `loadVaultScope` (Task 3), real temp-dir vault (pattern of `test/operations/fs-vault-provider/_helpers.ts` — reuse its temp-vault helper if exported, else `fs.mkdtemp`).

Covers the spec scenarios that unit mocks cannot: agreement of glob view and predicate on a real tree (vault-scope R1), tag/property aggregation skipping excluded notes (headless-vault-operations delta), and read-by-explicit-path (vault-scope R5).

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/obsidian/vault-scope-e2e.test.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../../../src/lib/obsidian/vault-scope-config.js';
import { FsVaultProvider } from '../../../src/modules/operations/fs-vault-provider.js';

let vaultRoot: string;

beforeAll(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'nv-scope-'));
  const write = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(vaultRoot, rel)), { recursive: true });
    await writeFile(path.join(vaultRoot, rel), content, 'utf8');
  };
  await write('Projects/alpha.md', '---\ntags: [kept]\n---\nSee [[beta]].');
  await write('Templates/Daily.md', '---\ntags: [tmpl]\nstatus: draft\n---\nTemplate body');
  await write('docs/superpowers/spec.md', '---\ntags: [ghost]\n---\nHidden');
  await write('Archive/old.md', '---\ntags: [old]\n---\nArchived');
  await write('.gitignore', 'docs/superpowers/\n!docs/superpowers/keep.md\n');
  await write('.neuro-vault/config.json', JSON.stringify({ exclusions: ['Archive/**'] }));
});

afterAll(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe('vault scope end-to-end', () => {
  it('scan sees only in-scope notes', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    expect(await reader.scan()).toEqual(['Projects/alpha.md']);
  });

  it('tag listings skip excluded notes', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const provider = new FsVaultProvider({ vaultRoot, reader });
    const tags = await provider.listTags();
    expect(tags.map((t) => t.name)).toEqual(['kept']);
  });

  it('read_notes by explicit path bypasses scope', async () => {
    const scope = await loadVaultScope(vaultRoot);
    const reader = new FsVaultReader({ vaultRoot, scope });
    const [item] = await reader.readNotes({
      paths: ['Templates/Daily.md'],
      fields: ['content'],
    });
    expect(item).toMatchObject({ path: 'Templates/Daily.md', content: expect.stringContaining('Template body') });
  });
});
```

(Adapt `FsVaultProvider` construction and `listTags` call shape to the real signatures in `src/modules/operations/fs-vault-provider.ts` — check its constructor options and method names before writing; the intent is fixed, the exact call shape follows the source.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/obsidian/vault-scope-e2e.test.ts`
Expected: FAIL on the first assertion until Tasks 3–5 are all in place (if written after them, it should pass immediately — then it is the verification step, not a red step; still keep it)

- [ ] **Step 3: Make it pass / verify**

Run: `npx vitest run test/lib/obsidian/vault-scope-e2e.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/lib/obsidian/vault-scope-e2e.test.ts
git commit -m "test: end-to-end vault scope membership over a real temp vault"
```

---

### Task 7: Docs — concept file and sweep

**Files:**
- Create: `docs/architecture/vault-scope.md`
- Modify: `docs/architecture/README.md` (index + reading order), `docs/architecture/vault-reader.md` (L22-23 scan rule + L13/L27/L32/L37-38/L58), `docs/architecture/lexical-search.md` (L61 "every vault-relative path", L23/L30 `totalNotes`, L35, L65), `docs/architecture/query.md` (L27-L99 scan mentions), `docs/architecture/rank-fusion.md` (L35 — N is now the scoped scan length), `docs/architecture/wikilink-graph.md` (L13, L53), `docs/architecture/vault-provider.md` (L22, L42), `docs/architecture/vault-registry.md` (L81 area — entry construction now loads scope config), `docs/architecture/vault-conventions.md` (L30 — `.neuro-vault/` holds config too), `docs/architecture/obsidian-lib.md` (L18 + module list), `docs/guide/configuration.md` (new `.neuro-vault/config.json` section), `docs/guide/finding-notes.md` (L259 area — some paths are never searchable)

- [ ] **Step 1: Write `docs/architecture/vault-scope.md`**

Follow the house style of `docs/architecture/vault-reader.md` (mechanism-focused, current-state). Must cover: the three layers and union semantics; the gitignore subset rules verbatim (root-only, skip blank/comment/negation, entry + `/**`, root-anchored — deliberately not git's any-level matching); the config contract and its failure behaviour (missing = silent, invalid = stderr warning + defaults); the two views (`ignorePatterns` prune vs authoritative predicate) and why prefixed scans rely on the predicate; the governed surfaces list (lexical search, query, tags/properties, overview, wikilink graph, name resolution — and, from slice #2 on, the semantic indexer); discovery-not-ACL (`read_notes` bypass); the accepted `Untitled.md` diff vs the SC corpus.

- [ ] **Step 2: Sweep every stale scan statement**

For each file in the Modify list: update the sentence(s) that assert the old rule ("scan enumerates every `.md`", "returns every vault-relative path", N = full scan length) to reference the scoped scan, linking `vault-scope.md`. Sweep all of `docs/` including `docs/guide` — grep for `scan` and `dot: false` and `.neuro-vault` to catch stragglers:

```bash
grep -rn "scan\|\.neuro-vault\|dot: false" docs/ --include="*.md" | grep -vi "vault-scope"
```

- [ ] **Step 3: Run the gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit (behaviour-change note in the body — it feeds the CHANGELOG)**

```bash
git add docs/
git commit -m "docs: vault-scope concept file and scan-behaviour sweep" -m "Behaviour change: paths named by the vault root .gitignore (live vault: docs/superpowers/) and Templates/ now leave lexical discovery — search, query_notes, tag/property listings, overview counts, backlinks, and name resolution. read_notes by explicit path is unaffected."
```

---

### Task 8: Final gate and spec validation

- [ ] **Step 1: Full gate**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS

- [ ] **Step 2: OpenSpec validation**

Run: `npx openspec validate --all`
Expected: all items pass

- [ ] **Step 3: Verify no phantom scope surfaces remain**

Run: `grep -rn "dot: false" src/ | grep -v vault-reader.ts`
Expected: no hits (the scan is the only enumeration point; anything else found must be routed through the scope or justified)

---

## Self-review notes

- Spec coverage: vault-scope R1 → Tasks 2/5/6; R2 (dot) → Task 2; R3 (defaults/gitignore) → Tasks 2/3; R4 (config union + failure contract) → Task 3; R5 (discovery-not-ACL) → Task 6; headless-vault-operations delta scenario → Task 6. Docs requirements from design → Task 7.
- Task 4/5 ordering is deliberately soft: the registry wiring and the reader option land together; the note in Task 4 Step 3 tells the executor how to sequence green states.
- The e2e test's `FsVaultProvider` call shapes are the one place the executor must adapt to source signatures; flagged inline.
