# Per-Model Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each embedding model its own corpus directory per vault, migrate the single-corpus layout in place, serialise reconcile passes across processes with a per-vault lock, and add `neuro-vault-mcp index --prune`.

**Architecture:** A path module (`layout.ts`) names `<vault>/.neuro-vault/corpus/<model_key>/`; `CorpusStore` requires the model key. Three new single-purpose modules — `legacy-migration.ts`, `reconcile-lock.ts`, `prune.ts` — are composed by `reconcileCorpus` (lock → migrate → the existing pass → release) and by `index --prune`. The server backend reloads after a pass that waited and treats a lock timeout as "still contended", never as `unavailable`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 20.9, `node:fs/promises`, `node:timers/promises`, yargs, vitest, eslint (type-aware).

**Spec:** `openspec/changes/per-model-corpus/design.md` (decisions D1–D11) and `openspec/changes/per-model-corpus/specs/*/spec.md`; `brainstorm.md` Q1–Q11 for why. Task numbers match `tasks.md`.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` pass at every commit; `npm run build` passes before the PR. `npm run typecheck` (`tsc --noEmit`) is authoritative.
- A fresh worktree needs `npm ci` before type-aware lint works.
- **Never run `npm run build` in the owner's main checkout** (`/Users/amostovenko/git/neuro-vault`): the global `neuro-vault-mcp` is a symlink into it and live MCP sessions execute its `dist/`. Build only inside the worktree.
- Never write to or delete the repo's `.scratch/` directory. Throwaway files go in the session scratchpad.
- Lock constants, verbatim: lock file `reconcile.lock` directly under `<vault>/.neuro-vault/corpus/`; poll starts at **50 ms**, doubles, capped at **2 000 ms**; total wait bound **600 000 ms (10 min)**; unparseable-content grace **1 000 ms**.
- Model directory name: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and not `notes`.
- The `.gitignore` entry stays exactly `.neuro-vault/corpus/`.
- `src/lib/obsidian/corpus/` never imports from `src/modules/`. `layout.ts` and `errno.ts` import nothing from other corpus modules.
- Nothing in `src/` writes to stdout except the CLI's own help/version/`index` output; library warnings go through an injected `warn` defaulting to `console.error`.
- Tests inject `pid`, `isAlive`, `sleep`, `now` and fs functions through deps. No `vi.mock` of modules. Tool tests (none expected here) go through `test/_gate.ts`.
- No private vault paths or note titles in any committed file; the manual check uses a generated temp vault.
- Commits: Conventional Commits, body lines ≤ 100 chars, each ending with exactly one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One PR to `main` via `gh pr create`, body ends with `Closes #146`. Never push to `main`.

## Review Focus

1. **A lock left by a dead process whose pid this process inherited** (the lock names our own pid): expect it replaced at once, not waited on for 10 minutes. → test in Task 2.2.
2. **A lock caught mid-create** (`wx` created the file, content not yet written): expect the waiter to treat it as held, not delete it, and acquire only after the holder releases. → test in Task 2.2.
3. **A legacy manifest whose `model_key` is a path (`../../outside`)**: expect nothing moved, nothing created outside `.neuro-vault/corpus/`. → test in Task 2.1.
4. **A symlink under `.neuro-vault/corpus/` pointing at a directory elsewhere**, then `--prune`: expect the link left alone and the target directory untouched. → test in Task 2.3.
5. **An `onLockWait` callback that throws** (a caller bug): expect a warning and the pass to continue, like `onProgress`. → test in Task 3.1.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/obsidian/corpus/errno.ts` (new) | `hasErrnoCode(err, code)` | 1.1 |
| `src/lib/obsidian/corpus/layout.ts` (new) | `CORPUS_DIR`, legacy names, `isModelDirName`, `corpusRootOf`, `modelCorpusDir` | 1.1 |
| `src/lib/obsidian/corpus/identity.ts` | gains `isStoredManifest` (moved from `shard-store.ts`) | 1.1 |
| `src/lib/obsidian/corpus/shard-store.ts` | `CorpusStore` requires `modelKey`; imports layout + validator | 1.1, 1.2 |
| `src/lib/obsidian/corpus/legacy-migration.ts` (new) | `migrateLegacyCorpus` | 2.1 |
| `src/lib/obsidian/corpus/reconcile-lock.ts` (new) | `acquireCorpusLock`, `CorpusLock`, `CorpusLockTimeoutError`, `isProcessAlive`, constants | 2.2 |
| `src/lib/obsidian/corpus/prune.ts` (new) | `listModelCorpora`, `pruneOtherCorpora` | 2.3 |
| `src/lib/obsidian/corpus/reconcile.ts` | lock + migration around the pass; `onLockWait` | 3.1 |
| `src/modules/semantic/backend/corpus-backend.ts` | reload after a waited pass; timeout handling | 3.2 |
| `src/modules/semantic/backend/index.ts` | passes `modelKey` | 1.2 |
| `src/config.ts`, `src/cli-index.ts` | `--prune`, wait notice, `modelKey` | 1.2, 3.3 |
| `eval/backends.ts` | per-model directory; names other corpora | 1.2, 3.4 |

---

## Task 1.1: The layout vocabulary and the shared manifest validator

**Files:**
- Create: `src/lib/obsidian/corpus/errno.ts`
- Create: `src/lib/obsidian/corpus/layout.ts`
- Modify: `src/lib/obsidian/corpus/identity.ts` (add `isStoredManifest`)
- Modify: `src/lib/obsidian/corpus/shard-store.ts` (drop `CORPUS_DIR` and `isValidManifest`, import them)
- Test: `test/lib/obsidian/corpus/layout.test.ts` (new), `test/lib/obsidian/corpus/identity.test.ts`

**Interfaces:**
- Consumes: `StoredManifest` from `src/lib/obsidian/corpus/types.ts`.
- Produces:
  - `hasErrnoCode(err: unknown, code: string): boolean` (`errno.ts`)
  - `CORPUS_DIR = '.neuro-vault/corpus'`, `LEGACY_NOTES_DIR = 'notes'`, `LEGACY_MANIFEST_FILE = 'manifest.json'`, `isModelDirName(name: string): boolean`, `corpusRootOf(vaultRoot: string): string`, `modelCorpusDir(vaultRoot: string, modelKey: string): string` (throws `Error` containing `"<key>" is not a valid model directory name`) (`layout.ts`)
  - `isStoredManifest(value: unknown): value is StoredManifest` (`identity.ts`)

- [ ] **Step 1: Write the failing tests**

Create `test/lib/obsidian/corpus/layout.test.ts`:

```ts
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasErrnoCode } from '../../../../src/lib/obsidian/corpus/errno.js';
import {
  CORPUS_DIR,
  corpusRootOf,
  isModelDirName,
  modelCorpusDir,
} from '../../../../src/lib/obsidian/corpus/layout.js';

describe('corpus layout', () => {
  it.each(['harrier-270m', 'granite-97m', 'harrier-0.6b', 'bge-micro-v2', 'a', 'x'.repeat(64)])(
    'accepts %s as a model directory name',
    (name) => {
      expect(isModelDirName(name)).toBe(true);
    },
  );

  it.each(['', '.', '..', '.hidden', 'a/b', 'a\\b', 'notes', '-x', 'x'.repeat(65), 'naïve'])(
    'rejects %j as a model directory name',
    (name) => {
      expect(isModelDirName(name)).toBe(false);
    },
  );

  it('roots every model under the vault corpus directory', () => {
    expect(CORPUS_DIR).toBe('.neuro-vault/corpus');
    expect(corpusRootOf('/v')).toBe(path.join('/v', '.neuro-vault/corpus'));
    expect(modelCorpusDir('/v', 'granite-97m')).toBe(
      path.join('/v', '.neuro-vault/corpus', 'granite-97m'),
    );
  });

  it('refuses to build a path from an invalid key', () => {
    expect(() => modelCorpusDir('/v', '../escape')).toThrow(
      '"../escape" is not a valid model directory name',
    );
  });
});

describe('hasErrnoCode', () => {
  it('matches a system error by code only', () => {
    expect(hasErrnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
    expect(hasErrnoCode(Object.assign(new Error('x'), { code: 'EEXIST' }), 'ENOENT')).toBe(false);
    expect(hasErrnoCode(new Error('x'), 'ENOENT')).toBe(false);
    expect(hasErrnoCode('ENOENT', 'ENOENT')).toBe(false);
  });
});
```

Append to `test/lib/obsidian/corpus/identity.test.ts` (add `isStoredManifest` to its existing import from `identity.js`, and import `TEST_IDENTITY` from `../../../_identity.js` if not already imported):

```ts
describe('isStoredManifest', () => {
  it('accepts a v2 manifest and a legacy v1 one', () => {
    expect(isStoredManifest({ ...TEST_IDENTITY, created: 'x' })).toBe(true);
    expect(
      isStoredManifest({
        embed_version: 1,
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        dims: 384,
        strategy: 'sc-parity-v1',
        created: '2026-08-25T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects a manifest without a model key, or with a mistyped optional field', () => {
    const { model_key: _dropped, ...withoutKey } = { ...TEST_IDENTITY, created: 'x' };
    expect(isStoredManifest(withoutKey)).toBe(false);
    expect(isStoredManifest({ ...TEST_IDENTITY, created: 'x', revision: 7 })).toBe(false);
    expect(isStoredManifest(null)).toBe(false);
    expect(isStoredManifest('manifest')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/layout.test.ts test/lib/obsidian/corpus/identity.test.ts`
Expected: FAIL — cannot resolve `errno.js` / `layout.js`; `isStoredManifest` is not exported.

- [ ] **Step 3: Implement**

Create `src/lib/obsidian/corpus/errno.ts`:

```ts
/** Whether `err` is a Node system error carrying `code` (`ENOENT`, `EEXIST`, …). */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
```

Create `src/lib/obsidian/corpus/layout.ts`:

```ts
import path from 'node:path';

/** Corpus root, relative to the vault root. Each model's corpus is a directory under it. */
export const CORPUS_DIR = '.neuro-vault/corpus';

/**
 * The shard directory and manifest of the single-corpus layout that preceded
 * per-model directories, directly under the corpus root (design D3).
 */
export const LEGACY_NOTES_DIR = 'notes';
export const LEGACY_MANIFEST_FILE = 'manifest.json';

/**
 * One path segment, never `.`/`..` or a dot-directory, never the legacy shard
 * directory. A legacy manifest's `model_key` is data read off disk and becomes
 * a path segment during migration, so it is checked like any other input.
 */
const MODEL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isModelDirName(name: string): boolean {
  return MODEL_DIR_RE.test(name) && name !== LEGACY_NOTES_DIR;
}

/** `<vaultRoot>/.neuro-vault/corpus` — holds every model's directory and the reconcile lock. */
export function corpusRootOf(vaultRoot: string): string {
  return path.join(vaultRoot, CORPUS_DIR);
}

/** `<vaultRoot>/.neuro-vault/corpus/<modelKey>` (design D1). Throws on a name {@link isModelDirName} rejects. */
export function modelCorpusDir(vaultRoot: string, modelKey: string): string {
  if (!isModelDirName(modelKey)) {
    throw new Error(`neuro-vault corpus: "${modelKey}" is not a valid model directory name`);
  }
  return path.join(corpusRootOf(vaultRoot), modelKey);
}
```

In `src/lib/obsidian/corpus/identity.ts`, add (the body is `isValidManifest` from `shard-store.ts`, moved verbatim):

```ts
/**
 * Whether `value` is a readable manifest: every v2 field, with the producer
 * fields a legacy (v1) manifest lacks allowed to be absent. Shared by the
 * store and the legacy migration, so both agree on what "parses" means.
 */
export function isStoredManifest(value: unknown): value is StoredManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optional = (key: string, type: 'string' | 'number') =>
    v[key] === undefined || typeof v[key] === type;
  return (
    typeof v.embed_version === 'number' &&
    typeof v.model_key === 'string' &&
    typeof v.model_id === 'string' &&
    typeof v.dims === 'number' &&
    typeof v.strategy === 'string' &&
    typeof v.created === 'string' &&
    optional('provider', 'string') &&
    optional('revision', 'string') &&
    optional('dtype', 'string') &&
    optional('pooling', 'string') &&
    optional('max_tokens', 'number')
  );
}
```

In `src/lib/obsidian/corpus/shard-store.ts`:
- delete `export const CORPUS_DIR = '.neuro-vault/corpus';` and its comment; add `import { CORPUS_DIR } from './layout.js';`
- delete the `isValidManifest` function; change the import to `import { IDENTITY_FIELDS, isStoredManifest, type CorpusIdentity } from './identity.js';` and the one call in `readManifest` to `if (!isStoredManifest(parsed)) {`.

Then confirm nothing else imported `CORPUS_DIR` from the store:

Run: `grep -rn "CORPUS_DIR" src eval test`
Expected: only `layout.ts` and `shard-store.ts`.

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx vitest run test/lib/obsidian/corpus && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/corpus/errno.ts src/lib/obsidian/corpus/layout.ts \
  src/lib/obsidian/corpus/identity.ts src/lib/obsidian/corpus/shard-store.ts \
  test/lib/obsidian/corpus/layout.test.ts test/lib/obsidian/corpus/identity.test.ts
git commit -m "refactor(corpus): name the per-model corpus layout and share the manifest validator

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.2: `CorpusStore` lives in its model's directory

The type change ships with every call site (the typecheck gate cannot be met across a split).

**Files:**
- Modify: `src/lib/obsidian/corpus/shard-store.ts` (`CorpusStoreDeps.modelKey`, constructor, class doc)
- Modify: `src/cli-index.ts:78` (`reconcileOne` store)
- Modify: `src/modules/semantic/backend/index.ts:98` (store per vault)
- Modify: `eval/backends.ts` (store + `corpusDir`)
- Modify tests: `test/lib/obsidian/corpus/shard-store.test.ts`, `test/lib/obsidian/corpus/reconcile.test.ts`, `test/semantic/backend/corpus-backend.test.ts`, `test/eval/backends.test.ts`, `test/eval/run.test.ts`

**Interfaces:**
- Consumes: `modelCorpusDir` (Task 1.1).
- Produces: `CorpusStoreDeps.modelKey: string` (required). `new CorpusStore(vaultRoot, { modelKey, dims, … })` reads and writes only `<vault>/.neuro-vault/corpus/<modelKey>/{manifest.json, notes/}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/obsidian/corpus/shard-store.test.ts` (inside the file, after the existing `describe('CorpusStore', …)`):

```ts
describe('CorpusStore per-model directories', () => {
  const granite = { ...expected, model_key: 'granite-97m' };
  const harrier = { ...expected, model_key: 'harrier-270m' };

  it('writes shards and the manifest under corpus/<modelKey>/', async () => {
    const root = await tempVault();
    const store = new CorpusStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    await store.writeShard(shard('N.md'));
    await store.writeManifest({ ...granite, created: 'x' });
    const dir = path.join(root, '.neuro-vault/corpus/granite-97m');
    expect((await readdir(dir)).sort()).toEqual(['manifest.json', 'notes']);
    expect(await readdir(path.join(dir, 'notes'))).toEqual([CorpusStore.shardFileName('N.md')]);
    expect((await readdir(path.join(root, '.neuro-vault/corpus'))).sort()).toEqual([
      'granite-97m',
    ]);
  });

  it('keeps two models of one vault apart', async () => {
    const root = await tempVault();
    const a = new CorpusStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    const b = new CorpusStore(root, { modelKey: 'harrier-270m', dims: TEST_DIMS });
    await a.writeShard(shard('A.md'));
    expect(await b.readShard('A.md')).toBeNull();
    expect(await b.listShards()).toEqual(new Map());
    expect(await b.readManifest()).toBeNull();
  });

  it('rebuilding one model leaves the other model untouched', async () => {
    const root = await tempVault();
    const a = new CorpusStore(root, { modelKey: 'granite-97m', dims: TEST_DIMS });
    const b = new CorpusStore(root, { modelKey: 'harrier-270m', dims: TEST_DIMS });
    await a.ensureManifest(granite);
    await a.writeShard(shard('A.md'));
    await b.ensureManifest(harrier);
    await b.writeShard(shard('B.md'));
    const graniteManifest = path.join(root, '.neuro-vault/corpus/granite-97m/manifest.json');
    const before = await readFile(graniteManifest, 'utf8');

    const result = await b.ensureManifest({ ...harrier, embed_version: harrier.embed_version + 1 });

    expect(result.rebuilt).toBe(true);
    expect(await b.listShards()).toEqual(new Map());
    expect([...(await a.listShards()).keys()]).toEqual(['A.md']);
    expect(await readFile(graniteManifest, 'utf8')).toBe(before);
  });

  it('refuses an unsafe model key before any I/O', () => {
    const readdirSpy = vi.fn(async () => []);
    expect(
      () => new CorpusStore('/v', { modelKey: '../x', dims: TEST_DIMS, readdir: readdirSpy }),
    ).toThrow('"../x" is not a valid model directory name');
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: FAIL — vitest strips types, so the unknown `modelKey` is silently ignored and the first test fails: files land under `.neuro-vault/corpus/notes`, not `granite-97m/`.

- [ ] **Step 3: Implement the store change**

In `src/lib/obsidian/corpus/shard-store.ts`:

```ts
import { CORPUS_DIR, modelCorpusDir } from './layout.js';
```

Add to `CorpusStoreDeps` (first field):

```ts
  /**
   * The model profile key. The store lives in
   * `<vault>/.neuro-vault/corpus/<modelKey>/` and never reads or writes outside
   * it (design D1), so processes serving different models cannot discard each
   * other's corpus. Required: a store that fell back to the corpus root would
   * recreate the shared directory.
   */
  modelKey: string;
```

Replace the class doc and the first line of the constructor:

```ts
/** Reads, writes, lists, and deletes per-note shards under `<vaultRoot>/.neuro-vault/corpus/<modelKey>/notes/`. */
export class CorpusStore {
```

```ts
  constructor(vaultRoot: string, deps: CorpusStoreDeps) {
    // Throws on an unsafe key before any I/O.
    const root = modelCorpusDir(vaultRoot, deps.modelKey);
```

(`CORPUS_DIR` stays imported for `ensureCorpusGitignored`, which still appends `.neuro-vault/corpus/`.)

- [ ] **Step 4: Update the production call sites**

`src/cli-index.ts`, in `reconcileOne`:

```ts
  const store = new CorpusStore(vault.path, { modelKey: identity.model_key, dims: identity.dims });
```

`src/modules/semantic/backend/index.ts`, in the returned factory function:

```ts
    const store = new CorpusStore(vaultRoot, {
      warn,
      modelKey: deps.identity.model_key,
      dims: deps.identity.dims,
    });
```

`eval/backends.ts` — replace the `corpusDir` and `store` lines, and import the helper:

```ts
import { modelCorpusDir } from '../src/lib/obsidian/corpus/layout.js';
```

```ts
  const corpusDir = modelCorpusDir(vaultRoot, expected.model_key);
  const rebuild = `neuro-vault-mcp index --vault ${shellQuote(vaultRoot)} --model ${expected.model_key}`;
  const store = new CorpusStore(vaultRoot, { modelKey: expected.model_key, dims: expected.dims });
```

Also change the docstring line `The corpus the server owns, decoded` to `The selected model's corpus the server owns, decoded`.

- [ ] **Step 5: Update the test call sites**

Every `new CorpusStore(` in a test gets the model key of the identity that test later reads it with. Mechanical part (the common `TEST_IDENTITY` case) — run from the worktree root:

```bash
sed -i '' 's/new CorpusStore(\([^,]*\), { dims: TEST_DIMS/new CorpusStore(\1, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS/' \
  test/lib/obsidian/corpus/shard-store.test.ts test/lib/obsidian/corpus/reconcile.test.ts \
  test/semantic/backend/corpus-backend.test.ts test/eval/backends.test.ts
sed -i '' \
  -e "s#'\.neuro-vault/corpus/notes'#'.neuro-vault/corpus/bge-micro-v2/notes'#g" \
  -e "s#'\.neuro-vault/corpus/manifest\.json'#'.neuro-vault/corpus/bge-micro-v2/manifest.json'#g" \
  -e "s#path.join(root, '\.neuro-vault/corpus'), { recursive#path.join(root, '.neuro-vault/corpus/bge-micro-v2'), { recursive#" \
  test/lib/obsidian/corpus/shard-store.test.ts test/lib/obsidian/corpus/reconcile.test.ts
```

(`bge-micro-v2` is `TEST_IDENTITY.model_key`, see `test/_identity.ts`. Leave the `.gitignore` assertions on `.neuro-vault/corpus/` as they are.)

By hand, then:
- `test/eval/run.test.ts` (two stores, lines ~89 and ~112): `new CorpusStore(vaultRoot, { modelKey: GRANITE.key, dims: TEST_DIMS })` — these corpora are read back by eval runs with `model: GRANITE`.
- `test/eval/backends.test.ts`: the stores with `dims: 640` get `modelKey: TEST_IDENTITY.model_key`, except the test below. Replace the test `refuses a corpus built by another profile before listing shards, naming the index command` (another profile now means another directory; Task 3.4 adds that case) with the within-model identity gate:

```ts
  it('refuses a model corpus built with another identity before listing shards, naming the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    // A 640-wide shard under a manifest of another embed_version: the manifest must refuse it.
    const wide = new CorpusStore(vaultRoot, { modelKey: 'harrier-270m', dims: 640 });
    await wide.writeManifest({
      ...TEST_IDENTITY,
      model_key: 'harrier-270m',
      dims: 640,
      embed_version: TEST_IDENTITY.embed_version + 1,
      created: 'x',
    });
    await wide.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(new Array<number>(640).fill(0.01)),
      blocks: [],
    });
    await expect(
      loadSnapshot(vaultRoot, { ...TEST_IDENTITY, model_key: 'harrier-270m' }),
    ).rejects.toThrow(
      `was indexed with harrier-270m (embed_version ${TEST_IDENTITY.embed_version + 1}), not harrier-270m (embed_version ${TEST_IDENTITY.embed_version}) — rebuild it for this model with: neuro-vault-mcp index --vault ${vaultRoot} --model harrier-270m`,
    );
  });
```

Find any remaining unconverted site:

Run: `grep -rn "new CorpusStore(" src eval test | grep -v modelKey`
Expected: no output.

Run: `grep -rn "neuro-vault/corpus/notes\|neuro-vault/corpus/manifest" test`
Expected: no output.

- [ ] **Step 6: Run the gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. If an eval or reconcile test still asserts a message containing `.neuro-vault/corpus` without the model segment, change the expectation to `modelCorpusDir(vaultRoot, <key>)` — the message now names the model's directory by design (D10).

- [ ] **Step 7: Commit**

```bash
git add src/lib/obsidian/corpus/shard-store.ts src/cli-index.ts \
  src/modules/semantic/backend/index.ts eval/backends.ts test
git commit -m "feat(corpus): keep one corpus directory per model

CorpusStore now requires the model key and lives in
.neuro-vault/corpus/<model_key>/, so processes serving different models
never read or discard each other's corpus.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2.1: Migrate the single-corpus layout (parallel-safe with 2.2, 2.3)

**Files:**
- Create: `src/lib/obsidian/corpus/legacy-migration.ts`
- Test: `test/lib/obsidian/corpus/legacy-migration.test.ts`

**Interfaces:**
- Consumes: `corpusRootOf`, `isModelDirName`, `CORPUS_DIR`, `LEGACY_MANIFEST_FILE`, `LEGACY_NOTES_DIR` (`layout.ts`); `isStoredManifest` (`identity.ts`); `hasErrnoCode` (`errno.ts`).
- Produces:
  - `type LegacyMigration = { kind: 'none' } | { kind: 'migrated'; modelKey: string } | { kind: 'skipped'; reason: 'unreadable' | 'target-exists' }`
  - `interface LegacyMigrationDeps { readFile?, rename?, mkdir?, exists?, warn? }`
  - `migrateLegacyCorpus(vaultRoot: string, deps?: LegacyMigrationDeps): Promise<LegacyMigration>`

- [ ] **Step 1: Write the failing tests**

Create `test/lib/obsidian/corpus/legacy-migration.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { migrateLegacyCorpus } from '../../../../src/lib/obsidian/corpus/legacy-migration.js';
import { TEST_IDENTITY } from '../../../_identity.js';

const manifestFor = (modelKey: string) =>
  JSON.stringify({ ...TEST_IDENTITY, model_key: modelKey, created: '2026-10-01T00:00:00.000Z' });

/** A vault whose corpus is in the single-corpus layout: root manifest + notes/. */
async function legacyVault(
  manifest: string | null,
  shards: string[] = ['a.json', 'b.json'],
): Promise<{ root: string; corpus: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-migrate-'));
  const corpus = path.join(root, '.neuro-vault/corpus');
  await mkdir(path.join(corpus, 'notes'), { recursive: true });
  if (manifest !== null) await writeFile(path.join(corpus, 'manifest.json'), manifest);
  for (const shard of shards) await writeFile(path.join(corpus, 'notes', shard), `{"s":"${shard}"}`);
  return { root, corpus };
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('migrateLegacyCorpus', () => {
  it('moves the manifest and every shard into the model directory, warning once', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    const warn = vi.fn();

    expect(await migrateLegacyCorpus(root, { warn })).toEqual({
      kind: 'migrated',
      modelKey: 'harrier-270m',
    });

    expect((await readdir(corpus)).sort()).toEqual(['harrier-270m']);
    expect(await readFile(path.join(corpus, 'harrier-270m/manifest.json'), 'utf8')).toBe(
      manifestFor('harrier-270m'),
    );
    expect((await readdir(path.join(corpus, 'harrier-270m/notes'))).sort()).toEqual([
      'a.json',
      'b.json',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('harrier-270m');
  });

  it('moves a legacy corpus of another model into that model’s directory', async () => {
    const { root, corpus } = await legacyVault(manifestFor('bge-micro-v2'));
    await migrateLegacyCorpus(root, { warn: vi.fn() });
    expect((await readdir(corpus)).sort()).toEqual(['bge-micro-v2']);
  });

  it('reports none when there is no root manifest', async () => {
    const { root, corpus } = await legacyVault(null);
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({ kind: 'none' });
    expect(await exists(path.join(corpus, 'notes'))).toBe(true);
  });

  it('reports none for a vault with no corpus at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-migrate-'));
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({ kind: 'none' });
  });

  it('completes an interrupted migration: shards already moved, manifest not', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    await mkdir(path.join(corpus, 'harrier-270m'));
    await rename(path.join(corpus, 'notes'), path.join(corpus, 'harrier-270m/notes'));

    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toMatchObject({ kind: 'migrated' });
    expect((await readdir(corpus)).sort()).toEqual(['harrier-270m']);
    expect((await readdir(path.join(corpus, 'harrier-270m'))).sort()).toEqual([
      'manifest.json',
      'notes',
    ]);
  });

  it('leaves everything in place when the model directory already has a manifest', async () => {
    const { root, corpus } = await legacyVault(manifestFor('harrier-270m'));
    await mkdir(path.join(corpus, 'harrier-270m'));
    await writeFile(path.join(corpus, 'harrier-270m/manifest.json'), 'newer');

    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
      kind: 'skipped',
      reason: 'target-exists',
    });
    expect(await readFile(path.join(corpus, 'harrier-270m/manifest.json'), 'utf8')).toBe('newer');
    expect(await exists(path.join(corpus, 'manifest.json'))).toBe(true);
    expect(await exists(path.join(corpus, 'notes/a.json'))).toBe(true);
  });

  it('leaves a manifest that is not valid JSON alone, without warning', async () => {
    const { root, corpus } = await legacyVault('{ not json');
    const warn = vi.fn();
    expect(await migrateLegacyCorpus(root, { warn })).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect((await readdir(corpus)).sort()).toEqual(['manifest.json', 'notes']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a model key that is a path, creating nothing outside the corpus', async () => {
    const { root, corpus } = await legacyVault(manifestFor('../../outside'));
    expect(await migrateLegacyCorpus(root, { warn: vi.fn() })).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect((await readdir(corpus)).sort()).toEqual(['manifest.json', 'notes']);
    expect(await exists(path.join(root, 'outside'))).toBe(false);
    expect(await exists(path.join(root, '..', 'outside'))).toBe(false);
  });

  it('treats a source that vanished mid-migration as already moved', async () => {
    const { root } = await legacyVault(manifestFor('harrier-270m'));
    const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const renameGone = vi.fn(async () => {
      throw gone;
    });
    await expect(migrateLegacyCorpus(root, { rename: renameGone, warn: vi.fn() })).resolves.toEqual(
      { kind: 'migrated', modelKey: 'harrier-270m' },
    );
    expect(renameGone).toHaveBeenCalledTimes(2); // notes/, then manifest.json
  });

  it('propagates any other rename failure', async () => {
    const { root } = await legacyVault(manifestFor('harrier-270m'));
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(
      migrateLegacyCorpus(root, {
        rename: async () => {
          throw denied;
        },
        warn: vi.fn(),
      }),
    ).rejects.toBe(denied);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/legacy-migration.test.ts`
Expected: FAIL — cannot resolve `legacy-migration.js`.

- [ ] **Step 3: Implement**

Create `src/lib/obsidian/corpus/legacy-migration.ts`:

```ts
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
} from 'node:fs/promises';
import path from 'node:path';

import { hasErrnoCode } from './errno.js';
import { isStoredManifest } from './identity.js';
import {
  CORPUS_DIR,
  corpusRootOf,
  isModelDirName,
  LEGACY_MANIFEST_FILE,
  LEGACY_NOTES_DIR,
} from './layout.js';

export type LegacyMigration =
  | { kind: 'none' }
  | { kind: 'migrated'; modelKey: string }
  | { kind: 'skipped'; reason: 'unreadable' | 'target-exists' };

export interface LegacyMigrationDeps {
  readFile?: (p: string) => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
  mkdir?: (p: string) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

/**
 * Moves a single-corpus layout — `manifest.json` and `notes/` directly under
 * `.neuro-vault/corpus/` — into `.neuro-vault/corpus/<model_key>/`, taking the
 * key from that manifest (design D3). Renames, never copies or re-embeds.
 *
 * Keyed on the target's manifest, and the manifest moves last: a migration
 * interrupted between the two renames leaves the root manifest behind and the
 * target without one, and the next call completes it. A target that already
 * has a manifest is left alone, as is a legacy manifest that does not parse or
 * names an unsafe key — `index --prune` removes either. Callers hold the
 * vault's reconcile lock (design D4), so two processes never race the renames;
 * a source that vanished anyway is "already moved", never an error.
 */
export async function migrateLegacyCorpus(
  vaultRoot: string,
  deps: LegacyMigrationDeps = {},
): Promise<LegacyMigration> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const rename = deps.rename ?? ((from: string, to: string) => fsRename(from, to));
  const mkdir = deps.mkdir ?? ((p: string) => fsMkdir(p, { recursive: true }).then(() => undefined));
  const exists = deps.exists ?? pathExists;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const root = corpusRootOf(vaultRoot);
  const legacyManifest = path.join(root, LEGACY_MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(legacyManifest);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return { kind: 'none' };
    return { kind: 'skipped', reason: 'unreadable' };
  }

  // Not warned: this runs on every pass, and an unreadable leftover would
  // repeat the line on every debounced tick.
  const modelKey = legacyModelKey(raw);
  if (modelKey === null) return { kind: 'skipped', reason: 'unreadable' };

  const target = path.join(root, modelKey);
  if (await exists(path.join(target, LEGACY_MANIFEST_FILE))) {
    return { kind: 'skipped', reason: 'target-exists' };
  }

  await mkdir(target);
  if (!(await exists(path.join(target, LEGACY_NOTES_DIR)))) {
    await renameIfPresent(rename, path.join(root, LEGACY_NOTES_DIR), path.join(target, LEGACY_NOTES_DIR));
  }
  await renameIfPresent(rename, legacyManifest, path.join(target, LEGACY_MANIFEST_FILE));
  warn(
    `neuro-vault corpus: moved the ${modelKey} corpus of vault ${vaultRoot} into ` +
      `${CORPUS_DIR}/${modelKey}/ (one corpus directory per model)`,
  );
  return { kind: 'migrated', modelKey };
}

/** The legacy manifest's model key, or null when it does not parse or is unsafe as a path segment. */
function legacyModelKey(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredManifest(parsed)) return null;
  return isModelDirName(parsed.model_key) ? parsed.model_key : null;
}

async function renameIfPresent(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return;
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return false;
    throw err;
  }
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/lib/obsidian/corpus/legacy-migration.test.ts && npm run typecheck && npm run lint`
Expected: PASS (run `npx prettier --write` on the two files first if lint reports formatting).

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/corpus/legacy-migration.ts test/lib/obsidian/corpus/legacy-migration.test.ts
git commit -m "feat(corpus): migrate a single-corpus layout into its model directory

Renames manifest.json and notes/ into .neuro-vault/corpus/<model_key>/,
manifest last so an interrupted move resumes; never re-embeds.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2.2: The cross-process reconcile lock (parallel-safe with 2.1, 2.3)

**Files:**
- Create: `src/lib/obsidian/corpus/reconcile-lock.ts`
- Test: `test/lib/obsidian/corpus/reconcile-lock.test.ts`

**Interfaces:**
- Consumes: `hasErrnoCode` (`errno.ts`).
- Produces:
  - `LOCK_FILE = 'reconcile.lock'`, `LOCK_POLL_MIN_MS = 50`, `LOCK_POLL_MAX_MS = 2_000`, `LOCK_MAX_WAIT_MS = 600_000`, `LOCK_UNREADABLE_GRACE_MS = 1_000`
  - `interface CorpusLock { release(): Promise<void> }`
  - `interface CorpusLockDeps { pid?; isAlive?; createExclusive?; readFile?; unlink?; mkdir?; sleep?; now?; maxWaitMs?; warn? }`
  - `interface AcquireOptions { signal?: AbortSignal; onWait?: (wait: { holderPid: number | null }) => void }`
  - `class CorpusLockTimeoutError extends Error { lockFile: string; holderPid: number | null; waitedMs: number }`
  - `isProcessAlive(pid: number, kill?: (pid: number, signal: 0) => void): boolean`
  - `acquireCorpusLock(corpusRoot: string, deps?: CorpusLockDeps, opts?: AcquireOptions): Promise<CorpusLock>`

- [ ] **Step 1: Write the failing tests**

Create `test/lib/obsidian/corpus/reconcile-lock.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  acquireCorpusLock,
  CorpusLockTimeoutError,
  isProcessAlive,
  LOCK_FILE,
} from '../../../../src/lib/obsidian/corpus/reconcile-lock.js';

const ME = 1001;
const HOLDER = 4242;

async function corpusDir(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'nv-lock-')), '.neuro-vault/corpus');
}

async function writeLock(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  await writeFile(file, content);
  return file;
}

const holderContent = (pid: number) => JSON.stringify({ pid, acquired: 'x' });

/** A fake clock whose sleeps advance it; `onSleep` runs after each sleep is recorded. */
function fakeClock(onSleep: (count: number) => Promise<void> | void = () => {}) {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
      await onSleep(sleeps.length);
    },
  };
}

const gone = async (p: string) =>
  stat(p).then(
    () => false,
    () => true,
  );

describe('acquireCorpusLock', () => {
  it('creates the corpus root if needed and records its pid', async () => {
    const dir = await corpusDir();
    const lock = await acquireCorpusLock(dir, { pid: ME });
    const content = JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8')) as {
      pid: number;
    };
    expect(content.pid).toBe(ME);
    await lock.release();
    expect(await gone(path.join(dir, LOCK_FILE))).toBe(true);
  });

  it('release leaves a lock that now names another process', async () => {
    const dir = await corpusDir();
    const lock = await acquireCorpusLock(dir, { pid: ME });
    const file = await writeLock(dir, holderContent(HOLDER));
    await lock.release();
    expect(await readFile(file, 'utf8')).toBe(holderContent(HOLDER));
  });

  it('replaces a dead holder without sleeping', async () => {
    const dir = await corpusDir();
    await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock();
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { pid: ME, isAlive: () => false, ...clock },
      { onWait },
    );
    expect(clock.sleeps).toEqual([]);
    expect(onWait).not.toHaveBeenCalled();
    await lock.release();
  });

  it('replaces a lock naming its own pid — a leftover of a dead predecessor', async () => {
    const dir = await corpusDir();
    await writeLock(dir, holderContent(ME));
    const clock = fakeClock();
    const lock = await acquireCorpusLock(dir, { pid: ME, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([]);
    await lock.release();
  });

  it('waits for a live holder with a doubling backoff, announcing it once', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock(async (count) => {
      if (count === 3) await rm(file);
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { pid: ME, isAlive: () => true, ...clock },
      { onWait },
    );
    expect(clock.sleeps).toEqual([50, 100, 200]);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith({ holderPid: HOLDER });
    expect((JSON.parse(await readFile(file, 'utf8')) as { pid: number }).pid).toBe(ME);
    await lock.release();
  });

  it('caps the backoff at 2 s', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock(async (count) => {
      if (count === 9) await rm(file);
    });
    const lock = await acquireCorpusLock(dir, { pid: ME, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800, 1600, 2000, 2000, 2000]);
    await lock.release();
  });

  it('gives up after the bound, naming the lock file and the holder, leaving its lock', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock();
    const err = await acquireCorpusLock(dir, {
      pid: ME,
      isAlive: () => true,
      maxWaitMs: 1_000,
      ...clock,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorpusLockTimeoutError);
    expect(err).toMatchObject({ lockFile: file, holderPid: HOLDER });
    expect((err as Error).message).toContain(LOCK_FILE);
    expect((err as Error).message).toContain(`pid ${HOLDER}`);
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800]);
    expect(await readFile(file, 'utf8')).toBe(holderContent(HOLDER));
  });

  it('treats a lock caught mid-create as held, never deleting it', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, ''); // created by `wx`, not yet written
    const unlink = vi.fn(async (p: string) => rm(p));
    const clock = fakeClock(async (count) => {
      if (count === 1) await writeFile(file, holderContent(HOLDER)); // the holder finishes its write
      if (count === 3) await rm(file); // ...and later releases
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { pid: ME, isAlive: () => true, unlink, ...clock },
      { onWait },
    );
    expect(unlink).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenCalledWith({ holderPid: null });
    await lock.release();
  });

  it('replaces a lock whose content stays unparseable past the 1 s grace', async () => {
    const dir = await corpusDir();
    await writeLock(dir, 'garbage');
    const clock = fakeClock();
    const lock = await acquireCorpusLock(dir, { pid: ME, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800]); // 1550 ms ≥ 1000 ms grace
    await lock.release();
  });

  it('stops waiting when aborted, leaving the holder’s lock', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    // The default sleep: proves the real timer honours the signal.
    await expect(
      acquireCorpusLock(dir, { pid: ME, isAlive: () => true }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(holderContent(HOLDER));
  });

  it('propagates a create failure other than EEXIST', async () => {
    const dir = await corpusDir();
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(
      acquireCorpusLock(dir, {
        pid: ME,
        createExclusive: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  });
});

describe('isProcessAlive', () => {
  const throwing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('reads ESRCH as dead and EPERM as alive', () => {
    expect(isProcessAlive(HOLDER, throwing('ESRCH'))).toBe(false);
    expect(isProcessAlive(HOLDER, throwing('EPERM'))).toBe(true);
    expect(isProcessAlive(HOLDER, () => {})).toBe(true);
  });

  it('sees this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile-lock.test.ts`
Expected: FAIL — cannot resolve `reconcile-lock.js`.

- [ ] **Step 3: Implement**

Create `src/lib/obsidian/corpus/reconcile-lock.ts`:

```ts
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { hasErrnoCode } from './errno.js';

/** Directly under the corpus root: one lock per vault, shared by every model (design D5). */
export const LOCK_FILE = 'reconcile.lock';
export const LOCK_POLL_MIN_MS = 50;
export const LOCK_POLL_MAX_MS = 2_000;
/** An incremental pass is seconds; a default-profile cold index of ~950 notes is ~9 min. */
export const LOCK_MAX_WAIT_MS = 600_000;
/** How long an unparseable lock counts as "being written" before it counts as stale. */
export const LOCK_UNREADABLE_GRACE_MS = 1_000;

export interface CorpusLock {
  /** Removes the lock if it is still this process's. Never throws. */
  release(): Promise<void>;
}

export interface CorpusLockDeps {
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Defaults to {@link isProcessAlive}. */
  isAlive?: (pid: number) => boolean;
  /** Creates the file only if absent, rejecting with `EEXIST` otherwise. */
  createExclusive?: (p: string, data: string) => Promise<void>;
  readFile?: (p: string) => Promise<string>;
  unlink?: (p: string) => Promise<void>;
  mkdir?: (p: string) => Promise<void>;
  /** Must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Defaults to {@link LOCK_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called once, when a live holder is first seen; `holderPid` is null while its content is unreadable. */
  onWait?: (wait: { holderPid: number | null }) => void;
}

/** The lock stayed held by a live process for the whole bound. */
export class CorpusLockTimeoutError extends Error {
  constructor(
    readonly lockFile: string,
    readonly holderPid: number | null,
    readonly waitedMs: number,
  ) {
    const holder = holderPid === null ? 'an unknown process' : `pid ${holderPid}`;
    super(
      `neuro-vault corpus: ${lockFile} has been held by ${holder} for ` +
        `${Math.round(waitedMs / 1000)} s — giving up this pass (delete the file if that ` +
        `process is not a neuro-vault server or index run)`,
    );
    this.name = 'CorpusLockTimeoutError';
  }
}

/** `kill(pid, 0)`: `ESRCH` means no such process; `EPERM` means it exists under another user. */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => {
    process.kill(p, s);
  },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return !hasErrnoCode(err, 'ESRCH');
  }
}

/**
 * Takes the vault's reconcile lock, waiting for a live holder (design D5).
 *
 * The lock is a file created exclusively with the holder's pid. A holder whose
 * pid is not running, or is this process's own (passes over one vault never
 * overlap within a process, so that is a dead predecessor's pid), is stale and
 * replaced — only if the file still holds what was judged stale. A file whose
 * content does not parse is treated as being written for
 * {@link LOCK_UNREADABLE_GRACE_MS}, then as stale. A live holder is polled with
 * a doubling backoff ({@link LOCK_POLL_MIN_MS}..{@link LOCK_POLL_MAX_MS}) for at
 * most `maxWaitMs`, then {@link CorpusLockTimeoutError}. An abort rejects the
 * wait and leaves the holder's lock alone.
 */
export async function acquireCorpusLock(
  corpusRoot: string,
  deps: CorpusLockDeps = {},
  opts: AcquireOptions = {},
): Promise<CorpusLock> {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? ((p: number) => isProcessAlive(p));
  const createExclusive =
    deps.createExclusive ?? ((p: string, data: string) => fsWriteFile(p, data, { flag: 'wx' }));
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const unlink = deps.unlink ?? ((p: string) => fsUnlink(p));
  const mkdir = deps.mkdir ?? ((p: string) => fsMkdir(p, { recursive: true }).then(() => undefined));
  const sleep =
    deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const now = deps.now ?? (() => Date.now());
  const maxWaitMs = deps.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const lockFile = path.join(corpusRoot, LOCK_FILE);
  await mkdir(corpusRoot);
  const content = `${JSON.stringify({ pid, acquired: new Date(now()).toISOString() })}\n`;
  const started = now();
  let pause = LOCK_POLL_MIN_MS;
  let announced = false;
  let unreadableSince: number | null = null;

  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      await createExclusive(lockFile, content);
      return { release: () => releaseLock(lockFile, pid, readFile, unlink, warn) };
    } catch (err) {
      if (!hasErrnoCode(err, 'EEXIST')) throw err;
    }

    const raw = await readOrNull(readFile, lockFile);
    // Released between our create and our read: try again at once.
    if (raw === null) continue;

    const holderPid = parseHolderPid(raw);
    let stale: boolean;
    if (holderPid === null) {
      unreadableSince ??= now();
      stale = now() - unreadableSince >= LOCK_UNREADABLE_GRACE_MS;
    } else {
      unreadableSince = null;
      stale = holderPid === pid || !isAlive(holderPid);
    }
    if (stale) {
      await removeIfUnchanged(readFile, unlink, lockFile, raw);
      continue;
    }

    if (!announced) {
      announced = true;
      opts.onWait?.({ holderPid });
    }
    const waited = now() - started;
    if (waited >= maxWaitMs) throw new CorpusLockTimeoutError(lockFile, holderPid, waited);
    await sleep(pause, opts.signal);
    pause = Math.min(pause * 2, LOCK_POLL_MAX_MS);
  }
}

async function releaseLock(
  lockFile: string,
  pid: number,
  readFile: (p: string) => Promise<string>,
  unlink: (p: string) => Promise<void>,
  warn: (message: string) => void,
): Promise<void> {
  try {
    const raw = await readOrNull(readFile, lockFile);
    // Someone judged us dead and took over — theirs now, not ours to remove.
    if (raw === null || parseHolderPid(raw) !== pid) return;
    await unlink(lockFile);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return;
    warn(`neuro-vault corpus: failed to release ${lockFile}: ${String(err)}`);
  }
}

/** Unlinks only if the file still holds exactly what was judged stale. */
async function removeIfUnchanged(
  readFile: (p: string) => Promise<string>,
  unlink: (p: string) => Promise<void>,
  lockFile: string,
  judged: string,
): Promise<void> {
  const current = await readOrNull(readFile, lockFile);
  if (current !== judged) return;
  try {
    await unlink(lockFile);
  } catch (err) {
    if (!hasErrnoCode(err, 'ENOENT')) throw err;
  }
}

async function readOrNull(
  readFile: (p: string) => Promise<string>,
  file: string,
): Promise<string | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }
}

function parseHolderPid(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const pid = (parsed as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile-lock.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/corpus/reconcile-lock.ts test/lib/obsidian/corpus/reconcile-lock.test.ts
git commit -m "feat(corpus): add a cross-process reconcile lock

corpus/reconcile.lock is created exclusively with the holder's pid; dead or
self-pid holders are replaced, live ones waited on (50 ms doubling to 2 s,
10 min bound), and an abort stops the wait.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2.3: List and prune model corpora (parallel-safe with 2.1, 2.2)

**Files:**
- Create: `src/lib/obsidian/corpus/prune.ts`
- Test: `test/lib/obsidian/corpus/prune.test.ts`

**Interfaces:**
- Consumes: `corpusRootOf`, `isModelDirName`, `LEGACY_MANIFEST_FILE` (`layout.ts`); `hasErrnoCode` (`errno.ts`).
- Produces:
  - `interface CorpusEntry { name: string; isDirectory: boolean }`
  - `interface PruneDeps { list?: (dir: string) => Promise<CorpusEntry[]>; remove?: (p: string) => Promise<void> }`
  - `listModelCorpora(vaultRoot: string, deps?: PruneDeps): Promise<string[]>` — sorted model directory names
  - `pruneOtherCorpora(vaultRoot: string, keepModelKey: string, deps?: PruneDeps): Promise<string[]>` — sorted names removed; **the caller holds the vault's lock**

- [ ] **Step 1: Write the failing tests**

Create `test/lib/obsidian/corpus/prune.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  listModelCorpora,
  pruneOtherCorpora,
} from '../../../../src/lib/obsidian/corpus/prune.js';

/** A corpus root holding two models, a leftover legacy corpus, the lock and a stray file. */
async function crowdedVault(): Promise<{ root: string; corpus: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
  const corpus = path.join(root, '.neuro-vault/corpus');
  for (const dir of ['granite-97m/notes', 'harrier-270m/notes', 'notes']) {
    await mkdir(path.join(corpus, dir), { recursive: true });
  }
  await writeFile(path.join(corpus, 'granite-97m/manifest.json'), '{}');
  await writeFile(path.join(corpus, 'harrier-270m/manifest.json'), '{}');
  await writeFile(path.join(corpus, 'manifest.json'), '{}');
  await writeFile(path.join(corpus, 'reconcile.lock'), '{"pid":1}');
  await writeFile(path.join(corpus, '.DS_Store'), '');
  return { root, corpus };
}

describe('pruneOtherCorpora', () => {
  it('removes every other model, the legacy root corpus, and reports them sorted', async () => {
    const { root, corpus } = await crowdedVault();
    expect(await pruneOtherCorpora(root, 'harrier-270m')).toEqual([
      'granite-97m',
      'manifest.json',
      'notes',
    ]);
    expect((await readdir(corpus)).sort()).toEqual(['.DS_Store', 'harrier-270m', 'reconcile.lock']);
    expect((await readdir(path.join(corpus, 'harrier-270m'))).sort()).toEqual([
      'manifest.json',
      'notes',
    ]);
  });

  it('removes nothing when only the kept model is present', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    await mkdir(path.join(root, '.neuro-vault/corpus/harrier-270m'), { recursive: true });
    expect(await pruneOtherCorpora(root, 'harrier-270m')).toEqual([]);
  });

  it('returns nothing for a vault with no corpus', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    expect(await pruneOtherCorpora(root, 'harrier-270m')).toEqual([]);
  });

  it('never follows or removes a symlink to a directory elsewhere', async () => {
    const { root, corpus } = await crowdedVault();
    const outside = await mkdtemp(path.join(tmpdir(), 'nv-prune-outside-'));
    await writeFile(path.join(outside, 'precious.md'), 'keep me');
    await symlink(outside, path.join(corpus, 'elsewhere'));

    expect(await pruneOtherCorpora(root, 'harrier-270m')).not.toContain('elsewhere');
    expect(await readdir(outside)).toEqual(['precious.md']);
    expect((await stat(path.join(corpus, 'elsewhere'))).isDirectory()).toBe(true);
  });
});

describe('listModelCorpora', () => {
  it('lists model directories only, sorted, never the legacy notes/', async () => {
    const { root } = await crowdedVault();
    expect(await listModelCorpora(root)).toEqual(['granite-97m', 'harrier-270m']);
  });

  it('returns nothing for a vault with no corpus', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-prune-'));
    expect(await listModelCorpora(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/prune.test.ts`
Expected: FAIL — cannot resolve `prune.js`.

- [ ] **Step 3: Implement**

Create `src/lib/obsidian/corpus/prune.ts`:

```ts
import { readdir as fsReaddir, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';

import { hasErrnoCode } from './errno.js';
import { corpusRootOf, isModelDirName, LEGACY_MANIFEST_FILE } from './layout.js';

export interface CorpusEntry {
  name: string;
  /** False for a symlink, even one pointing at a directory — prune never follows links. */
  isDirectory: boolean;
}

export interface PruneDeps {
  list?: (dir: string) => Promise<CorpusEntry[]>;
  remove?: (p: string) => Promise<void>;
}

async function defaultList(dir: string): Promise<CorpusEntry[]> {
  const entries = await fsReaddir(dir, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
}

async function listCorpusRoot(
  vaultRoot: string,
  list: (dir: string) => Promise<CorpusEntry[]>,
): Promise<CorpusEntry[]> {
  try {
    return await list(corpusRootOf(vaultRoot));
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return [];
    throw err;
  }
}

/** The model corpora present under a vault, sorted — for naming them, never for deciding what to delete. */
export async function listModelCorpora(vaultRoot: string, deps: PruneDeps = {}): Promise<string[]> {
  const entries = await listCorpusRoot(vaultRoot, deps.list ?? defaultList);
  return entries
    .filter((entry) => entry.isDirectory && isModelDirName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Deletes every directory directly under the corpus root except
 * `keepModelKey`'s — other models' corpora and a leftover legacy `notes/` —
 * plus a legacy root `manifest.json` (design D8). Leaves the reconcile lock and
 * every other file. Returns what it removed, sorted. The caller holds the
 * vault's reconcile lock, so no other process is mid-pass in what goes.
 */
export async function pruneOtherCorpora(
  vaultRoot: string,
  keepModelKey: string,
  deps: PruneDeps = {},
): Promise<string[]> {
  const remove = deps.remove ?? ((p: string) => fsRm(p, { recursive: true, force: true }));
  const entries = await listCorpusRoot(vaultRoot, deps.list ?? defaultList);
  const doomed = entries
    .filter((entry) =>
      entry.isDirectory ? entry.name !== keepModelKey : entry.name === LEGACY_MANIFEST_FILE,
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of doomed) {
    await remove(path.join(corpusRootOf(vaultRoot), name));
  }
  return doomed;
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/lib/obsidian/corpus/prune.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/corpus/prune.ts test/lib/obsidian/corpus/prune.test.ts
git commit -m "feat(corpus): list and prune other models' corpora

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.1: Reconcile runs under the lock and migrates first

**Files:**
- Modify: `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts`

**Interfaces:**
- Consumes: `acquireCorpusLock`, `AcquireOptions`, `CorpusLock` (Task 2.2); `migrateLegacyCorpus` (Task 2.1); `corpusRootOf` (Task 1.1).
- Produces:
  - `ReconcileDeps.acquireLock?: (opts: AcquireOptions) => Promise<CorpusLock>`
  - `ReconcileDeps.migrateLegacy?: () => Promise<unknown>`
  - `ReconcileOptions.onLockWait?: (wait: { holderPid: number | null }) => void`
  - `reconcileCorpus` throws `CorpusLockTimeoutError` (unchanged type, from Task 2.2) when the bound expires; returns the empty summary when aborted while waiting.

- [ ] **Step 1: Write the failing tests**

In `test/lib/obsidian/corpus/reconcile.test.ts`:

1. Extend the imports:

```ts
import { mkdtemp, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
```

```ts
import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
} from '../../../../src/lib/obsidian/corpus/reconcile.js';
import { acquireCorpusLock } from '../../../../src/lib/obsidian/corpus/reconcile-lock.js';
```

2. Let `harness` take overrides — change its signature and spread them last into the deps:

```ts
async function harness(files: Record<string, string>, extra: Partial<ReconcileDeps> = {}) {
```

```ts
        store,
        warn,
        ...extra,
      },
```

3. Append a new `describe` block:

```ts
const EMPTY_SUMMARY = { total: 0, embedded: 0, reused: 0, renamed: 0, deleted: 0, failed: 0 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('reconcileCorpus across processes', () => {
  it('migrates under the lock, before reading the manifest, and releases last', async () => {
    const calls: string[] = [];
    const { store, run } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async () => {
          calls.push('acquire');
          return {
            release: async () => {
              calls.push('release');
            },
          };
        },
        migrateLegacy: async () => {
          calls.push('migrate');
        },
      },
    );
    const readManifest = store.readManifest.bind(store);
    vi.spyOn(store, 'readManifest').mockImplementation(async () => {
      calls.push('manifest');
      return readManifest();
    });
    await run();
    expect(calls).toEqual(['acquire', 'migrate', 'manifest', 'release']);
  });

  it('reuses a single-corpus layout after moving it into the model directory', async () => {
    const { root, run, embed, store } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    const corpus = path.join(root, '.neuro-vault/corpus');
    const modelDir = path.join(corpus, TEST_IDENTITY.model_key);
    await rename(path.join(modelDir, 'notes'), path.join(corpus, 'notes'));
    await rename(path.join(modelDir, 'manifest.json'), path.join(corpus, 'manifest.json'));
    embed.mockClear();

    expect(await run()).toMatchObject({ total: 2, embedded: 0, reused: 2, deleted: 0, failed: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect((await readdir(corpus)).sort()).toEqual([TEST_IDENTITY.model_key]);
    expect([...(await store.listShards()).keys()].sort()).toEqual(['A.md', 'B.md']);
  });

  it('releases the lock when the pass throws', async () => {
    const { root, run } = await harness(
      { 'A.md': body('A') },
      {
        scan: async () => {
          throw new Error('scan failed');
        },
      },
    );
    await expect(run()).rejects.toThrow('scan failed');
    await expect(stat(path.join(root, '.neuro-vault/corpus/reconcile.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('returns the empty summary when aborted while waiting for the lock', async () => {
    const controller = new AbortController();
    const { run, embed } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async ({ signal, onWait }) => {
          onWait?.({ holderPid: 4242 });
          controller.abort();
          signal?.throwIfAborted();
          throw new Error('unreachable');
        },
      },
    );
    expect(await run({ signal: controller.signal })).toEqual(EMPTY_SUMMARY);
    expect(embed).not.toHaveBeenCalled();
  });

  it('reports the wait, and survives an onLockWait callback that throws', async () => {
    const { run, warn } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async ({ onWait }) => {
          onWait?.({ holderPid: 4242 });
          return { release: async () => {} };
        },
      },
    );
    const onLockWait = vi.fn(() => {
      throw new Error('caller bug');
    });
    expect(await run({ onLockWait })).toMatchObject({ embedded: 1, failed: 0 });
    expect(onLockWait).toHaveBeenCalledWith({ holderPid: 4242 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onLockWait callback threw'));
  });

  /**
   * Two passes over one temp vault, as two processes would run them: distinct
   * pids, the real lock file. The holder's embed is gated until the other pass
   * has seen the lock held, so the test cannot pass by one finishing first.
   */
  async function twoPasses(files: Record<string, string>, prepare?: (root: string) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-'));
    await prepare?.(root);
    const vault = fakeVault(files);
    const gate = deferred();
    const embed = vi.fn(async (texts: string[]) => {
      await gate.promise;
      return texts.map(vectorFor);
    });
    const waits: number[] = [];
    const rebuilds: number[] = [];
    const corpusRoot = path.join(root, '.neuro-vault/corpus');
    const pass = (pid: number) =>
      reconcileCorpus(
        {
          vaultRoot: root,
          scan: vault.scan,
          stat: vault.stat,
          readNote: vault.readNote,
          embedDocuments: embed,
          identity: TEST_IDENTITY,
          store: new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS }),
          warn: vi.fn(),
          acquireLock: (opts) =>
            acquireCorpusLock(
              corpusRoot,
              {
                pid,
                isAlive: () => true,
                sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
              },
              opts,
            ),
        },
        {
          onLockWait: () => {
            waits.push(pid);
            gate.resolve();
          },
          onRebuild: () => {
            rebuilds.push(pid);
          },
        },
      );
    const results = await Promise.all([pass(1001), pass(1002)]);
    return { results, embed, waits, rebuilds };
  }

  it('serialises two passes over one vault: the second reuses what the first embedded', async () => {
    const { results, embed, waits } = await twoPasses({
      'A.md': body('A'),
      'B.md': body('B'),
      'C.md': body('C'),
    });
    expect(waits).toHaveLength(1);
    expect(results.map((r) => r.embedded).sort()).toEqual([0, 3]);
    expect(results.map((r) => r.reused).sort()).toEqual([0, 3]);
    expect(embed).toHaveBeenCalledTimes(3); // one call per note, across both passes
  });

  it('a pass that waited on a rebuild reads the new manifest and discards nothing', async () => {
    const { results, rebuilds, waits } = await twoPasses(
      { 'A.md': body('A') },
      async (root) => {
        // A corpus of this model at another embed_version, with a shard to lose.
        const stale = new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
        await stale.writeManifest({
          ...TEST_IDENTITY,
          embed_version: TEST_IDENTITY.embed_version + 1,
          created: 'x',
        });
        await stale.writeShard({
          path: 'A.md',
          content_hash: 'old',
          mtime: 0,
          size: 0,
          embedding: null,
          blocks: [],
        });
      },
    );
    expect(waits).toHaveLength(1);
    expect(rebuilds).toHaveLength(1); // the holder rebuilt; the waiter found it compatible
    expect(results.map((r) => r.embedded).sort()).toEqual([0, 1]);
  });
});
```

Note: `vectorFor`, `fakeVault`, `body`, `TEST_DIMS`, `TEST_IDENTITY`, `CorpusStore`, `tmpdir`, `path` are already in scope in this file.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts`
Expected: FAIL — `acquireLock`/`migrateLegacy`/`onLockWait` are ignored: the call-order test records `['manifest']`, the legacy-layout test embeds 2, the two-pass tests time out (nobody waits, so the gate never opens — vitest's 5 s timeout).

- [ ] **Step 3: Implement**

In `src/lib/obsidian/corpus/reconcile.ts`, add imports:

```ts
import { corpusRootOf } from './layout.js';
import { migrateLegacyCorpus } from './legacy-migration.js';
import { acquireCorpusLock, type AcquireOptions, type CorpusLock } from './reconcile-lock.js';
```

Add to `ReconcileDeps` (after `identity`):

```ts
  /**
   * Takes the vault's cross-process reconcile lock (design D5, D6). Defaults to
   * `acquireCorpusLock` on `<vaultRoot>/.neuro-vault/corpus/`.
   */
  acquireLock?: (opts: AcquireOptions) => Promise<CorpusLock>;
  /**
   * Moves a single-corpus layout into its model's directory (design D3, D4).
   * Runs under the lock, before the manifest is read. Defaults to
   * `migrateLegacyCorpus` on the vault.
   */
  migrateLegacy?: () => Promise<unknown>;
```

Add to `ReconcileOptions` (after `onRebuild`):

```ts
  /**
   * Called once, before anything is read, when another live process holds the
   * vault's lock and this pass starts waiting for it (design D7, D9).
   * `holderPid` is null while the lock's content is unreadable.
   */
  onLockWait?: (wait: { holderPid: number | null }) => void;
```

Replace the body of `reconcileCorpus` up to (not including) `const { rebuilt, previous } = await store.ensureManifest(...)` with the lock wrapper, and move the rest of the existing body — from `// First, so an incompatible corpus identity …` through `return summary;` — unchanged into a new `reconcileLocked`:

```ts
export async function reconcileCorpus(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const warn = deps.warn ?? ((message: string) => console.error(message));

  // Before any I/O. The setup below — a lock, a manifest write, a full scan, a
  // full shard listing — is itself seconds of disk work on a large corpus, and
  // a pass kicked off just as the client hung up would otherwise run all of it
  // before reaching the first per-note check.
  if (opts.signal?.aborted) return emptySummary();

  const acquireLock =
    deps.acquireLock ??
    ((lockOpts: AcquireOptions) =>
      acquireCorpusLock(corpusRootOf(deps.vaultRoot), { warn }, lockOpts));
  const migrateLegacy =
    deps.migrateLegacy ?? (() => migrateLegacyCorpus(deps.vaultRoot, { warn }));

  let lock: CorpusLock;
  try {
    lock = await acquireLock({
      signal: opts.signal,
      onWait: (wait) => {
        // Guarded like onProgress: a throwing callback must not abort the run.
        try {
          opts.onLockWait?.(wait);
        } catch (err) {
          warn(`neuro-vault corpus: onLockWait callback threw: ${String(err)}`);
        }
      },
    });
  } catch (err) {
    // An abort while waiting is a shutdown, not a failure — the same empty
    // result as an abort before any I/O. The holder's lock is not ours to touch.
    if (opts.signal?.aborted) return emptySummary();
    throw err;
  }

  // Everything that reads the corpus happens from here on, under the lock: a
  // pass that waited sees what the previous holder wrote (design D6).
  try {
    if (opts.signal?.aborted) return emptySummary();
    await migrateLegacy();
    return await reconcileLocked(deps, opts, warn);
  } finally {
    await lock.release();
  }
}

function emptySummary(): ReconcileSummary {
  return { total: 0, embedded: 0, reused: 0, renamed: 0, deleted: 0, failed: 0 };
}

/** The pass proper (design D6 steps after migration). The caller holds the vault's lock. */
async function reconcileLocked(
  deps: ReconcileDeps,
  opts: ReconcileOptions,
  warn: (message: string) => void,
): Promise<ReconcileSummary> {
  const { vaultRoot, scan, stat, readNote, embedDocuments, store } = deps;

  // First, so an incompatible corpus identity discards the shards before they
  // are read: the shard map below must not see vectors of unknown provenance.
  const { rebuilt, previous } = await store.ensureManifest(deps.identity);
  // ... the rest of the former reconcileCorpus body, unchanged, ending in
  // `await ensureCorpusGitignored(vaultRoot, { warn }); return summary;`
}
```

(The `// ... the rest` comment above is the existing code to move, not new code: cut it from `reconcileCorpus` and paste it here verbatim. Delete the old early-abort `return { total: 0, … }` — `emptySummary()` replaces it.)

Update the `reconcileCorpus` doc comment's first paragraph with one sentence: `Runs under the vault's cross-process lock, after moving a single-corpus layout into its model directory (design D3–D6).`

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts && npm test && npm run typecheck && npm run lint`
Expected: PASS. (Every existing reconcile test now goes through the real lock on its temp vault; they must stay green.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/corpus/reconcile.ts test/lib/obsidian/corpus/reconcile.test.ts
git commit -m "feat(corpus): reconcile under the vault lock, migrating the old layout first

A pass takes corpus/reconcile.lock before it reads anything, so a pass that
waited reuses what the holder built. onLockWait reports the wait.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.2: The server backend under contention (parallel-safe with 3.3, 3.4)

**Files:**
- Modify: `src/modules/semantic/backend/corpus-backend.ts`
- Test: `test/semantic/backend/corpus-backend.test.ts`

**Interfaces:**
- Consumes: `ReconcileOptions.onLockWait` (Task 3.1); `CorpusLockTimeoutError` (Task 2.2).
- Produces: no new exports. Behaviour: reload after a waited pass; a lock timeout keeps `status`/`snapshot`, warns, and schedules a retry.

- [ ] **Step 1: Write the failing tests**

In `test/semantic/backend/corpus-backend.test.ts`, add the import:

```ts
import { CorpusLockTimeoutError } from '../../../src/lib/obsidian/corpus/reconcile-lock.js';
```

and append inside `describe('createCorpusBackend', …)`:

```ts
  it('reloads after a pass that waited for another process, even with nothing changed', async () => {
    const loadSnapshot = vi.fn(async () => snapshotWith(['a.md']));
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      identity: TEST_IDENTITY,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot,
      reconcile: async ({ onLockWait }) => {
        onLockWait?.({ holderPid: 4242 });
        return summary();
      },
    });
    await backend.whenSettled();
    expect(loadSnapshot).toHaveBeenCalledTimes(2); // startup load + after the waited pass
  });

  it('keeps serving through a lock timeout and retries on the backoff', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const warn = vi.fn();
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(
        new CorpusLockTimeoutError('/v/.neuro-vault/corpus/reconcile.lock', 4242, 600_000),
      )
      .mockResolvedValueOnce(summary());
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      identity: TEST_IDENTITY,
      store: fakeStore({ compatible: true, shards: 2 }),
      loadSnapshot: async () => snapshotWith(['a.md', 'b.md']),
      reconcile,
      warn,
      retryBaseMs: 1_000,
      ...fakeTimers(timers),
    });

    await backend.whenSettled();

    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(2);
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('pid 4242');
    expect(logged).toContain('reconcile.lock');
    expect(logged).toContain('"v"');
    expect(timers.map((t) => t.ms)).toEqual([1_000]);

    timers[0].fn();
    await backend.whenSettled();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(backend.status()).toEqual({ state: 'ready' });
  });

  it('stays indexing, not unavailable, when a cold vault’s pass times out on the lock', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      identity: TEST_IDENTITY,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async () => {
        throw new CorpusLockTimeoutError('/v/.neuro-vault/corpus/reconcile.lock', 4242, 600_000);
      },
      warn: vi.fn(),
      retryBaseMs: 1_000,
      ...fakeTimers(timers),
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(timers).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/semantic/backend/corpus-backend.test.ts`
Expected: FAIL — `loadSnapshot` called once; status `unavailable` after the timeout.

- [ ] **Step 3: Implement**

In `src/modules/semantic/backend/corpus-backend.ts`, add the import:

```ts
import { CorpusLockTimeoutError } from '../../../lib/obsidian/corpus/reconcile-lock.js';
```

Add beside `let retryDelay = retryBaseMs;`:

```ts
  /**
   * The last pass gave up waiting for another process's lock (design D7). Not a
   * failure: the vault keeps its state and snapshot, and re-arms like one.
   */
  let lockTimedOut = false;
```

In `runPass`, set `lockTimedOut = false;` as the first statement, then change the `deps.reconcile` call and the reload condition:

```ts
    let waited = false;
    try {
      const summary = await deps.reconcile({
        signal: abort.signal,
        // Another process held the lock and may have changed the corpus — a
        // note it re-embedded is `reused` by this pass, so the counts alone
        // would keep this snapshot stale (design D7).
        onLockWait: () => {
          waited = true;
        },
        onRebuild: ({ stored, active }) => {
```

```ts
      if (
        !snapshotLoaded ||
        waited ||
        summary.embedded + summary.renamed + summary.deleted > 0
      ) {
```

and the `catch`:

```ts
    } catch (err) {
      if (err instanceof CorpusLockTimeoutError) {
        // Someone is still building; this vault is not broken. Reporting
        // `unavailable` would take a serving vault off the air and tell callers
        // to run a competing `index` (design D7).
        lockTimedOut = true;
        warn(
          `neuro-vault corpus: vault "${deps.vaultName}": ${err.lockFile} is still held by ` +
            `${err.holderPid === null ? 'an unknown process' : `pid ${err.holderPid}`} — ` +
            `serving the current corpus and retrying later`,
        );
        return;
      }
      fail(err);
    } finally {
```

In `kick`'s `.finally`, change the re-arm condition:

```ts
      if (status.state === 'unavailable' || lockTimedOut) scheduleRetry();
      else retryDelay = retryBaseMs;
```

Add one sentence to the `createCorpusBackend` doc comment: `A pass that waited for another process's lock reloads unconditionally; one that timed out on it keeps the vault's state and snapshot and re-arms on the same backoff (design D7).`

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/semantic/backend && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/backend/corpus-backend.ts test/semantic/backend/corpus-backend.test.ts
git commit -m "feat(semantic): keep serving while another process holds the corpus lock

Reload after a pass that waited; a lock timeout keeps the vault's state
and snapshot and retries on the backoff instead of reporting unavailable.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.3: `index --prune` and the wait notice (parallel-safe with 3.2, 3.4)

**Files:**
- Modify: `src/config.ts` (`IndexCliOptions.prune`, `PRUNE_OPTION`, `MODEL_OPTION.describe`)
- Modify: `src/cli-index.ts`
- Test: `test/config.test.ts`, `test/cli-index.test.ts`

**Interfaces:**
- Consumes: `acquireCorpusLock` (2.2), `pruneOtherCorpora` (2.3), `corpusRootOf` (1.1), `ReconcileOptions.onLockWait` (3.1).
- Produces: `IndexCliOptions.prune: boolean`; `IndexCommandDeps.prune?: (vaultRoot: string, keepModelKey: string) => Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, inside `describe('index subcommand', …)`:

```ts
    it('parses --prune, defaulting to off', async () => {
      const off = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath]);
      const on = await parseConfig(['node', 'cli.js', 'index', '--prune', '--vault', vaultPath]);
      expect(off.kind === 'index' && off.options.prune).toBe(false);
      expect(on.kind === 'index' && on.options.prune).toBe(true);
    });

    it('the server invocation rejects --prune', async () => {
      await expect(parseConfig(['node', 'cli.js', '--prune', '--vault', vaultPath])).rejects.toThrow();
    });
```

In `test/cli-index.test.ts`, first make every existing call pass the new required option:

```bash
sed -i '' -e 's/model: profile }/model: profile, prune: false }/g' -e 's/model: granite }/model: granite, prune: false }/g' test/cli-index.test.ts
grep -n "runIndexCommand({" test/cli-index.test.ts | grep -v "prune:"
```

Expected from the grep: no output (fix any remaining call by hand). `ReconcileDeps` and `ReconcileOptions` are already imported; add `import { CorpusLockTimeoutError } from '../src/lib/obsidian/corpus/reconcile-lock.js';`, and append inside `describe('runIndexCommand', …)`:

```ts
  it('prunes other models after reconciling, reporting what it removed', async () => {
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push('reconcile');
      return okSummary();
    });
    const prune = vi.fn(async (_root: string, _keep: string) => {
      order.push('prune');
      return ['notes', 'granite-97m'];
    });
    const deps = { ...makeDeps(reconcile), prune };
    const code = await runIndexCommand({ vaults: [vaultA], model: profile, prune: true }, deps);
    expect(code).toBe(0);
    expect(order).toEqual(['reconcile', 'prune']);
    expect(prune).toHaveBeenCalledWith('/abs/VaultA', TEST_EMBEDDING_IDENTITY.model_key);
    expect(deps.stdout.chunks.at(-1)).toBe('pruned VaultA: removed granite-97m, notes\n');
  });

  it('says so when there is nothing to prune', async () => {
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune: vi.fn(async () => []) };
    await runIndexCommand({ vaults: [vaultA], model: profile, prune: true }, deps);
    expect(deps.stdout.chunks.at(-1)).toBe('pruned VaultA: nothing to remove\n');
  });

  it('never prunes without the flag', async () => {
    const prune = vi.fn(async () => []);
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune };
    await runIndexCommand({ vaults: [vaultA], model: profile, prune: false }, deps);
    expect(prune).not.toHaveBeenCalled();
  });

  it('does not prune a vault whose reconcile threw', async () => {
    const reconcile = vi.fn(async (d: ReconcileDeps) => {
      if (d.vaultRoot === '/abs/VaultA') throw new Error('model download failed');
      return okSummary();
    });
    const prune = vi.fn(async () => []);
    const deps = { ...makeDeps(reconcile), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, prune: true },
      deps,
    );
    expect(code).toBe(1);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith('/abs/VaultB', TEST_EMBEDDING_IDENTITY.model_key);
  });

  it('a prune failure is fatal for that vault only', async () => {
    const prune = vi.fn(async (root: string) => {
      if (root === '/abs/VaultA') throw new Error('EACCES');
      return [];
    });
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, prune: true },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.stderr.chunks.join('')).toContain('index VaultA: EACCES');
    expect(deps.stdout.chunks.join('')).toContain('pruned VaultB: nothing to remove');
  });

  it('a lock held past the bound fails that vault, naming the lock file and holder', async () => {
    const reconcile = vi.fn(async (d: ReconcileDeps) => {
      if (d.vaultRoot === '/abs/VaultA') {
        throw new CorpusLockTimeoutError('/abs/VaultA/.neuro-vault/corpus/reconcile.lock', 4242, 600_000);
      }
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, prune: false },
      deps,
    );
    expect(code).toBe(1);
    const stderr = deps.stderr.chunks.join('');
    expect(stderr).toContain('index VaultA:');
    expect(stderr).toContain('reconcile.lock');
    expect(stderr).toContain('pid 4242');
    expect(deps.stdout.chunks.join('')).toContain('indexed VaultB:');
  });

  it('reports a wait for another process on stderr, not stdout', async () => {
    const reconcile = vi.fn(async (_d: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onLockWait?.({ holderPid: 4242 });
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, prune: false }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242) to finish with VaultA…\n',
    ]);
    expect(deps.stdout.chunks.join('')).not.toContain('waiting');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/config.test.ts test/cli-index.test.ts`
Expected: FAIL — `prune` undefined in parsed options; prune never called; no stderr wait line.

- [ ] **Step 3: Implement `config.ts`**

```ts
export interface IndexCliOptions {
  vaults: IVaultConfig[];
  model: ModelProfile;
  /** Delete every other model's corpus under each vault once it is reconciled (design D8). */
  prune: boolean;
}
```

Replace `MODEL_OPTION.describe` and add `PRUNE_OPTION` after it:

```ts
  describe:
    'Embedding model profile, one per process. Each model keeps its own corpus per vault, so switching rebuilds nothing; give `index` the server’s value to pre-warm the corpus the server serves.',
```

```ts
const PRUNE_OPTION = {
  type: 'boolean',
  default: false,
  describe:
    "After reconciling each vault, delete every other model's corpus under it (and a leftover pre-per-model corpus), reporting what was removed.",
} as const;
```

Register it on `index` only:

```ts
    .command('index', 'Build or refresh the embedding corpus for each vault, then exit', (y) =>
      y.option('vault', VAULT_OPTION).option('model', MODEL_OPTION).option('prune', PRUNE_OPTION),
    )
```

and return it:

```ts
  if (args._[0] === 'index') {
    return { kind: 'index', options: { vaults, model, prune: args.prune === true } };
  }
```

- [ ] **Step 4: Implement `cli-index.ts`**

Imports:

```ts
import { corpusRootOf } from './lib/obsidian/corpus/layout.js';
import { pruneOtherCorpora } from './lib/obsidian/corpus/prune.js';
import { acquireCorpusLock } from './lib/obsidian/corpus/reconcile-lock.js';
```

`IndexCommandDeps` gains:

```ts
  /**
   * Deletes every other model's corpus under the vault while holding its lock,
   * returning what it removed (design D8). Defaults to {@link defaultPrune}.
   */
  prune?: (vaultRoot: string, keepModelKey: string) => Promise<string[]>;
```

Add:

```ts
async function defaultPrune(vaultRoot: string, keepModelKey: string): Promise<string[]> {
  // Under the lock, so no other process is mid-pass in a directory that goes.
  const lock = await acquireCorpusLock(corpusRootOf(vaultRoot));
  try {
    return await pruneOtherCorpora(vaultRoot, keepModelKey);
  } finally {
    await lock.release();
  }
}

function writePruned(stdout: OutStream, vaultName: string, removed: string[]): void {
  stdout.write(
    removed.length === 0
      ? `pruned ${vaultName}: nothing to remove\n`
      : `pruned ${vaultName}: removed ${[...removed].sort().join(', ')}\n`,
  );
}
```

`reconcileOne` takes `stderr` and reports the wait (add `stderr: OutStream` as its last parameter):

```ts
      onLockWait: ({ holderPid }) => {
        // Before any progress output, so it never splits a TTY progress line.
        stderr.write(
          `waiting for another neuro-vault process (${
            holderPid === null ? 'pid unknown' : `pid ${holderPid}`
          }) to finish with ${vault.name}…\n`,
        );
      },
```

`runIndexCommand`:

```ts
  const prune = deps.prune ?? defaultPrune;
```

```ts
    try {
      const summary = await reconcileOne(vault, embedder, reconcile, stdout, stderr);
      writeSummary(stdout, vault.name, summary);
      if (summary.failed > 0) complete = false;
      // After the reconcile, so the selected model's corpus is current before the
      // others go; a reconcile that threw skips this — never leave a vault with
      // nothing to serve (design D8).
      if (options.prune) {
        writePruned(stdout, vault.name, await prune(vault.path, embedder.identity.model_key));
      }
    } catch (error) {
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `npx vitest run test/config.test.ts test/cli-index.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If a `--help` snapshot test in `config.test.ts` pins the old `--model` description, update it to the new text.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/cli-index.ts test/config.test.ts test/cli-index.test.ts
git commit -m "feat(cli): add index --prune and report waits for another process

--prune deletes every other model's corpus under the vault after it is
reconciled, under the vault lock, and prints what it removed.

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.4: Eval names the corpora that exist (parallel-safe with 3.2, 3.3)

**Files:**
- Modify: `eval/backends.ts`
- Test: `test/eval/backends.test.ts`

**Interfaces:**
- Consumes: `listModelCorpora` (2.3), `modelCorpusDir` (1.1).
- Produces: `loadSnapshot(vaultRoot, expected)` unchanged signature; its missing-or-empty `BackendError` message gains ` (this vault has corpora for: <keys>)` when others exist.

- [ ] **Step 1: Write the failing tests**

In `test/eval/backends.test.ts`, add `readFile`, `writeFile` and `stat` to the `node:fs/promises` import, and append inside the `describe`:

```ts
  it('names the other models present when the selected one has no corpus, and leaves them alone', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const granite = new CorpusStore(vaultRoot, { modelKey: 'granite-97m', dims: TEST_DIMS });
    await granite.ensureManifest({ ...TEST_IDENTITY, model_key: 'granite-97m' });
    await granite.writeShard({
      path: 'a.md',
      content_hash: 'h',
      mtime: 1,
      size: 1,
      embedding: encodeVector(unitVec(0)),
      blocks: [],
    });
    const manifest = path.join(vaultRoot, '.neuro-vault/corpus/granite-97m/manifest.json');
    const before = await readFile(manifest, 'utf8');

    const err = await loadSnapshot(vaultRoot, { ...TEST_IDENTITY, model_key: 'harrier-270m' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toContain(
      `${path.join(vaultRoot, '.neuro-vault/corpus/harrier-270m')} is missing or empty (this vault has corpora for: granite-97m)`,
    );
    expect((err as Error).message).toContain('--model harrier-270m');
    expect(await readFile(manifest, 'utf8')).toBe(before);
    expect([...(await granite.listShards()).keys()]).toEqual(['a.md']);
  });

  it('neither migrates nor locks: a legacy root corpus is reported missing and left in place', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-gate-'));
    const corpus = path.join(vaultRoot, '.neuro-vault/corpus');
    await mkdir(path.join(corpus, 'notes'), { recursive: true });
    await writeFile(
      path.join(corpus, 'manifest.json'),
      JSON.stringify({ ...TEST_IDENTITY, created: 'x' }),
    );

    await expect(loadSnapshot(vaultRoot, TEST_IDENTITY)).rejects.toThrow('is missing or empty');
    expect((await stat(path.join(corpus, 'manifest.json'))).isFile()).toBe(true);
    await expect(stat(path.join(corpus, 'reconcile.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/eval/backends.test.ts`
Expected: FAIL — the first test's message lacks `(this vault has corpora for: granite-97m)`.

- [ ] **Step 3: Implement**

In `eval/backends.ts`:

```ts
import { listModelCorpora } from '../src/lib/obsidian/corpus/prune.js';
```

Replace the empty-snapshot branch:

```ts
  if (snapshot.sources.size === 0) {
    // Another model's corpus is the usual reason, and naming it says so.
    const others = (await listModelCorpora(vaultRoot)).filter((key) => key !== expected.model_key);
    const present = others.length === 0 ? '' : ` (this vault has corpora for: ${others.join(', ')})`;
    throw new BackendError(
      `own corpus at ${corpusDir} is missing or empty${present} — build it with: ${rebuild}`,
    );
  }
```

Update the function doc: `The selected model's corpus the server owns, decoded — but only if it was built by the profile this run embeds queries with. Eval never builds, migrates, locks or deletes a corpus (design D10), so evaluating one model leaves every model's corpus as it found it.`

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run test/eval && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/backends.ts test/eval/backends.test.ts
git commit -m "feat(eval): read the selected model's corpus and name the others present

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.1: ADR-0017 addendum

**Files:**
- Modify: `docs/adr/0017-embedding-model-profiles.md`
- Modify: `docs/adr/INDEX.md`

- [ ] **Step 1: Status line.** Change `- **Status**: Accepted` to `- **Status**: Accepted; per-profile corpus directories adopted 2026-10-14 (see Revisited)`.
- [ ] **Step 2: Operations bullet.** Replace the first Operations bullet (`A server and an \`index\` run given different \`--model\` values …`) with `- *(Superseded 2026-10-14 — see Revisited.)* A server and an \`index\` run given different \`--model\` values on one vault used to discard and rebuild each other's corpus.`
- [ ] **Step 3: Addendum.** Append after the last Alternatives bullet, as its own paragraph, the text from design D11 verbatim (the block starting `**Revisited 2026-10-14 — per-profile corpus directories adopted.**`).
- [ ] **Step 4: Index.** In `docs/adr/INDEX.md`, ADR-0017's status cell becomes `Accepted; per-profile directories adopted 2026-10-14`.
- [ ] **Step 5: Check and commit**

Run: `npx prettier --check docs/adr/0017-embedding-model-profiles.md docs/adr/INDEX.md` (fix with `--write` if needed).

```bash
git add docs/adr/0017-embedding-model-profiles.md docs/adr/INDEX.md
git commit -m "docs(adr): revisit ADR-0017 — per-profile corpus directories adopted

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.2: Architecture docs

**Files:**
- Modify: `docs/architecture/own-corpus.md`, `docs/architecture/semantic-backend.md`, `docs/architecture/cli-startup.md`

- [ ] **Step 1: `own-corpus.md` § On-disk layout** — replace the tree with:

```
<vault>/.neuro-vault/corpus/
  reconcile.lock               # { pid, acquired } while a pass runs (any model)
  <model_key>/                 # one per model profile, e.g. harrier-270m/
    manifest.json              # { embed_version, provider, model_key, model_id, revision, dtype, dims, pooling, max_tokens, strategy, created }  (manifest v2)
    notes/<sha256(path)[:32]>.json
```

and add after it a paragraph: one directory per model key (readable, stable across a revision bump), the name rule (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, never `notes`), and that the `.gitignore` entry is still `.neuro-vault/corpus/`.

- [ ] **Step 2: new subsection "Migration from the single-corpus layout"** under On-disk layout — design D3/D4 in prose: when (first pass, under the lock), how (rename notes then manifest), the three skip cases, that a pre-per-model build still running rebuilds at the root once, and that `--prune` removes leftovers.
- [ ] **Step 3: § "A model change is a rebuild, and never silent"** — retitle `An identity change within a model is a rebuild, and never silent`; replace "switching `--model`" in the list of mismatch causes with the note that another `--model` selects another directory and discards nothing; replace the closing "Run `index` and the server with the same `--model`, or each will rebuild the other's corpus." with "Give `index` the server's `--model` so it pre-warms the corpus the server serves; any other value builds a separate corpus beside it."
- [ ] **Step 4: new section "Concurrency: the reconcile lock"** before § Measured numbers — design D5–D7, D9: the file, exclusive create, the three stale rules, the backoff and 10-minute bound, what the server and `index` do on timeout, reload after a waited pass, abort; the residual risks (simultaneous stale-steal; pid reuse) from design § Risks.
- [ ] **Step 5: § Reconcile, step list** — insert `0. Take the vault's lock, then migrate a single-corpus layout (see Concurrency, Migration).` before step 1.
- [ ] **Step 6: § Boundaries** — replace the last two sentences ("Cross-process locking is still out of scope …") with: passes over one vault are serialised across processes by `reconcile.lock`; sharing one reconcile or watcher between processes is still out of scope (#145's daemon).
- [ ] **Step 7: `semantic-backend.md`** — in the state table add a row `A pass times out waiting for another process's lock | State and snapshot unchanged; one stderr line names the holder's pid and the lock file; re-armed on the retry backoff.`; in the snapshot paragraph (line ~55) add "or when the pass had to wait for another process's lock" to the reload conditions, with the reason (design D7).
- [ ] **Step 8: `cli-startup.md`** — fix the `--model` sentence (line ~63) as in Step 3, and document `index --prune` (what it removes, under the lock, after the reconcile, the stdout line) and the stderr wait line.
- [ ] **Step 9: Commit**

```bash
git add docs/architecture
git commit -m "docs(architecture): per-model corpus directories, migration and the reconcile lock

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.3: Eval README, guides, README, and the sweep

**Files:**
- Modify: `eval/README.md`, `docs/guide/embedding-models.md`, `docs/guide/installation.md`, `README.md`

- [ ] **Step 1: `eval/README.md`** — the corpus paragraph (line ~85): reads `<vault>/.neuro-vault/corpus/<model_key>/` for `--model`; never builds, migrates, locks or deletes. The "destructive to that vault's corpus by design" paragraph (line ~124) → comparing models is an A/B now: `index --model X` → `eval --model X` → `index --model Y` → `eval --model Y`, both corpora kept; `index --prune` when done. The calibration paragraph (line ~349, "A vault has one corpus directory, so once it is re-indexed …") → the other profile's corpus is still there. The error list (line ~108): "the corpus was indexed with another profile" → "the selected model's corpus is missing (the message lists the models whose corpora exist)" and "the model's corpus was built with another identity (revision, embed_version, …)".
- [ ] **Step 2: `docs/guide/embedding-models.md`** — line ~86 bullet: keep the advice, change the reason (pre-warming; a different value builds a second corpus, it no longer rebuilds the server's); line ~130: comparing on your own vault no longer needs a copy; add a short "Disk: one corpus per model; `index --prune` removes the others" note.
- [ ] **Step 3: `docs/guide/installation.md` (line ~118) and `README.md` (line ~233)** — same correction; mention `--prune` in the README's `index` paragraph.
- [ ] **Step 4: Sweep.** Run:

```bash
grep -rn -i "rebuild each other\|rebuilds the other\|discard and rebuild\|one corpus directory\|one corpus per vault\|destructive\|has one corpus\|each will rebuild" docs README.md eval/README.md
```

Expected after the fixes: hits only inside `docs/adr/0017-embedding-model-profiles.md` (the superseded bullet and the Alternatives text it revisits) and `openspec/` history. Fix any other hit.

- [ ] **Step 5: Commit**

```bash
git add eval/README.md docs/guide README.md
git commit -m "docs: switching models no longer rebuilds the corpus; document index --prune

Refs #146

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5.1: Manual check — two processes on a temp vault

Real processes, real lock, real model. Nothing here is committed except the results summary in `verify.md` (no vault data).

**Files:**
- Write (scratch, not committed): `$SCRATCH/pmc-vault/` and `$SCRATCH/*.out|*.err`
- Later: results summary goes into `openspec/changes/per-model-corpus/verify.md` (Task 5.2)

- [ ] **Step 1: Generate a temp vault** (run from the worktree root; `SCRATCH` is this session's scratchpad directory):

```bash
SCRATCH=<session scratchpad directory>
V="$SCRATCH/pmc-vault"; C="$V/.neuro-vault/corpus"
rm -rf "$V" && mkdir -p "$V/Notes"
for i in $(seq 1 40); do
  { printf '# Note %s\n\n' "$i"; for j in $(seq 1 12); do printf 'Sentence %s about topic %s for the per-model corpus check. ' "$j" "$i"; done; printf '\n'; } > "$V/Notes/note-$i.md"
done
ls "$V/Notes" | wc -l
```

Expected: `40`.

- [ ] **Step 2: Two concurrent `index` runs of one model**

```bash
npm run --silent dev -- index --vault "$V" --model granite-97m > "$SCRATCH/a.out" 2> "$SCRATCH/a.err" &
npm run --silent dev -- index --vault "$V" --model granite-97m > "$SCRATCH/b.out" 2> "$SCRATCH/b.err" &
wait
grep -h "^indexed" "$SCRATCH/a.out" "$SCRATCH/b.out"
grep -h "waiting for another" "$SCRATCH/a.err" "$SCRATCH/b.err"
ls -a "$C"
```

Expected: one summary `embedded=40 reused=0 … failed=0`, the other `embedded=0 reused=40 … failed=0`; exactly one `waiting for another neuro-vault process (pid N) to finish with pmc-vault…`; `$C` holds `granite-97m` (and `.`/`..`) and no `reconcile.lock`.

- [ ] **Step 3: Legacy layout migrates without embedding**

```bash
mv "$C/granite-97m/notes" "$C/notes" && mv "$C/granite-97m/manifest.json" "$C/manifest.json" && rmdir "$C/granite-97m"
npm run --silent dev -- index --vault "$V" --model granite-97m
ls "$C"
```

Expected: stderr `neuro-vault corpus: moved the granite-97m corpus of vault … into .neuro-vault/corpus/granite-97m/`; summary `embedded=0 reused=40`; `ls` shows only `granite-97m`.

- [ ] **Step 4: A second model builds beside the first**

```bash
shasum "$C/granite-97m/manifest.json" > "$SCRATCH/granite.sha"
npm run --silent dev -- index --vault "$V" --model harrier-270m
shasum -c "$SCRATCH/granite.sha" && ls "$C"
npm run --silent dev -- index --vault "$V" --model granite-97m | grep "^indexed"
```

Expected: no `rebuilding` line; `granite-97m/manifest.json: OK`; `ls` shows `granite-97m harrier-270m`; the last granite run reports `embedded=0 reused=40`.

- [ ] **Step 5: A dead holder's lock is replaced** (macOS pids stop at 99 998, so 999 999 is never alive):

```bash
printf '{"pid":999999,"acquired":"x"}\n' > "$C/reconcile.lock"
npm run --silent dev -- index --vault "$V" --model harrier-270m 2>&1 | grep -c "waiting for another" ; ls "$C"
```

Expected: `0`; no `reconcile.lock` afterwards.

- [ ] **Step 6: `--prune`**

```bash
mkdir -p "$C/notes" && printf '{}' > "$C/manifest.json"   # a leftover legacy corpus
npm run --silent dev -- index --vault "$V" --model harrier-270m --prune | tail -1
ls "$C"
```

Expected: `pruned pmc-vault: removed granite-97m, manifest.json, notes`; `ls` shows only `harrier-270m`.

- [ ] **Step 7: Record** each step's expected-vs-observed line (counts and messages only, no paths beyond `pmc-vault`) for `verify.md`. Delete the scratch vault: `rm -rf "$SCRATCH/pmc-vault"` (it is this task's own directory, inside the session scratchpad).

---

## Task 5.2: Verify, retrospective, archive, PR

- [ ] **Step 1:** `/opsx:verify` → `openspec/changes/per-model-corpus/verify.md`, including Task 5.1's results; re-run until no blocking issue.
- [ ] **Step 2:** Write `retrospective.md` per the schema's instruction (before the PR).
- [ ] **Step 3:** `npx openspec archive per-model-corpus -y` (syncs the four delta specs into `openspec/specs/`); commit as `docs(openspec): archive per-model-corpus (#146)` with the trailer.
- [ ] **Step 4: Gates**

```bash
npm test && npm run lint && npm run typecheck && npm run build
npx commitlint --from origin/main --to HEAD
```

Expected: all pass (the build runs in this worktree only).

- [ ] **Step 5:** Push the branch and open the PR via `superpowers:finishing-a-development-branch` → `gh pr create` against `main`. Body: what changed (layout, migration, lock, `--prune`, eval, ADR addendum), the manual check summary, the overlap note with #145 (`config.ts`, `cli-index.ts`, `docs/adr/INDEX.md`), and `Closes #146`, ending with the Claude Code attribution line.
