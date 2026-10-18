# daemon-vault-registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move each vault's watcher, reconcile loop and decoded corpus out of every stdio session into one vault entry per vault directory in the shared daemon, and make sessions read the corpus through `corpus.*`.

**Architecture:** A shared module `src/lib/vault-entry/` (vault entry, reconcile loop, scope-aware watcher) runs inside the daemon behind new `vault.*` and `corpus.*` services, and inside the session as the in-process fallback. The corpus becomes the ADR-0019 interface (`ShardCorpus` over `ShardStore`); sessions keep the semantic-leg composition and read through a `SemanticBackend` that is a `ICorpusReader`. Two PRs: PR 1 (Tasks 1–11) is dark; PR 2 (Tasks 12–19) switches the session over.

**Tech Stack:** TypeScript (strict, ESM, `isolatedModules`), Node ≥ 20.9, vitest, chokidar 4, picomatch, `@modelcontextprotocol/sdk` stdio framing.

**Spec:** `openspec/changes/daemon-vault-registry/` — `design.md` (D1–D17), `specs/shared-vault-entry/spec.md`, `specs/shared-corpus-reads/spec.md`, and the deltas for `semantic-backend-lifecycle`, `shared-services-daemon`, `daemon-embedding-provider`, `own-corpus-index`, `hybrid-search`. `brainstorm.md` holds the decisions they come from.

## Global Constraints

- Gates before every commit: `npm test`, `npm run lint`, `npm run typecheck` (authoritative), `npm run format`; `npm run build` before each PR.
- Commits: Conventional Commits, body lines ≤ 100 characters, one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check with `npx commitlint --from origin/main --to HEAD` before pushing.
- A type or signature change lands in the same task as every call site it breaks (the typecheck gate cannot be satisfied across a split).
- Tool tests go through `registerTool(buildXTool(deps))` and `callTool` / `expectToolError` from `test/_gate.ts`, never `buildXTool(deps).handler`.
- Diagnostics go to stderr only; nothing writes to stdout in the session or the daemon.
- Timeouts: `vault.attach` 10 s, `vault.status` 10 s, `corpus.nearest` / `corpus.nearestBlocks` 30 s. Debounce stays `DEBOUNCE_MS = 10_000`. Retry backoff stays 30 s doubling to 15 min. `find_duplicates` anchor batch: 64.
- Wire params are snake_case; every vault-addressed call after attach carries the realpath key returned by `vault.attach`.
- Shard format, manifest format, lock file and `neuro-vault-mcp index` behaviour do not change.
- No private vault paths or note titles in code, tests, docs or commits.
- PR 1 changes no session-visible behaviour. Deliver PR 1, stop for review and merge, then start PR 2.

## Review Focus

- A vault path given with a trailing slash, `..` segments, or through a symlink chain must reach the same entry as its realpath → test in Task 8 (`same key for trailing slash and symlink`).
- An attach that arrives while an entry's or a profile's idle timer is running must cancel the timer and reuse the loaded corpus, not reload it → test in Task 8 (`attach during idle reuses`).
- A connection that closes while its `vault.attach` is still being answered must not leave a phantom client that keeps the entry alive forever → test in Task 8 (`detach before attach settles`).
- A scope change arriving on attach while a pass is running must not start a second, overlapping pass; it queues one → test in Task 7 (`setScope during a pass queues one pass`).
- A vault directory deleted or unmounted while attached must turn its profiles `unavailable` with a reason and keep the daemon serving other vaults → test in Task 11 (`vanished vault directory`).

---

# PR 1 — vault entry in the daemon (dark)

### Task 1: Rename `CorpusStore` to `ShardStore`

**Files:**
- Modify: `src/lib/obsidian/corpus/shard-store.ts` (class and deps type), every importer: `src/lib/obsidian/corpus/{reconcile,snapshot,prune,index}.ts`, `src/modules/semantic/backend/{index,corpus-backend}.ts`, `src/cli-index.ts`, `eval/backends.ts`, and the tests that import it (find them with `grep -rln "CorpusStore" src eval test`).

**Interfaces:**
- Produces: `class ShardStore` and `interface ShardStoreDeps`, same members as before. No alias for the old name.

- [ ] **Step 1:** Rename `CorpusStore` → `ShardStore` and `CorpusStoreDeps` → `ShardStoreDeps` everywhere, including doc comments that name the class.
- [ ] **Step 2:** Run `grep -rn "CorpusStore" src eval test docs/architecture` — expected: no match outside historical ADR text.
- [ ] **Step 3:** Run `npm run typecheck && npx vitest run` — expected: PASS, same test count as before.
- [ ] **Step 4:** Commit `refactor(corpus): rename CorpusStore to ShardStore` (body: ADR-0019 names the durable layer ShardStore).

### Task 2: Corpus interfaces and `shardWriter`

**Files:**
- Create: `src/lib/obsidian/corpus/corpus.ts`, `src/lib/obsidian/corpus/shard-writer.ts`
- Test: `test/lib/obsidian/corpus/shard-writer.test.ts`

**Interfaces:**
- Consumes: `ShardStore` (Task 1), `CorpusShard`, `StoredManifest` (`types.ts`), `CorpusIdentity` (`identity.ts`).
- Produces, in `corpus.ts`:

```ts
export type CorpusAnchor = { vector: ArrayLike<number> } | { path: string };
export interface INoteHit { path: string; similarity: number }
export interface IBlockHit { path: string; heading: string; lines: [number, number]; similarity: number }
export interface INearestOptions {
  threshold: number;
  limit?: number;
  allowed?: readonly string[];
  exclude?: readonly string[];
}
export interface INearestBlocksOptions { paths: readonly string[]; threshold: number; limit?: number }
export interface ICorpusReader {
  /** One list per anchor, in order; null for a path anchor whose note has no vector. */
  nearest(anchors: readonly CorpusAnchor[], opts: INearestOptions): Promise<(INoteHit[] | null)[]>;
  nearestBlocks(anchors: readonly CorpusAnchor[], opts: INearestBlocksOptions): Promise<(IBlockHit[] | null)[]>;
}
export interface ICorpusEntry { content_hash: string; mtime: number; size: number }
export interface ICorpusWriter {
  entries(): Promise<Map<string, ICorpusEntry>>;
  upsert(record: CorpusShard): Promise<void>;
  /** False when the corpus has no record for `path` (the caller re-embeds). */
  touch(path: string, stat: { mtime: number; size: number }): Promise<boolean>;
  delete(path: string): Promise<void>;
  identity(): Promise<StoredManifest | null>;
  /** ADR-0019's identity() + reset() composed as ShardStore.ensureManifest does today. */
  ensureIdentity(expected: CorpusIdentity): Promise<{ rebuilt: boolean; previous: StoredManifest | null }>;
  refresh(): Promise<void>;
}
export interface ICorpus extends ICorpusReader, ICorpusWriter {
  vectorOf(path: string): Float32Array | null;
  dispose(): void;
}
```

- `shard-writer.ts`: `export function shardWriter(store: ShardStore): ICorpusWriter`.

- [ ] **Step 1: Write the failing tests** in `shard-writer.test.ts` over a temp vault (`fs.mkdtemp`) and a real `ShardStore`:
  - `entries returns metadata of every shard and no vectors` — write two shards; `entries()` has both paths with `{content_hash, mtime, size}` and no other keys.
  - `touch rewrites mtime and size and keeps the vectors` — after `touch(p, {mtime: 5, size: 9})`, `store.readShard(p)` has `mtime 5`, `size 9` and the original `embedding`.
  - `touch on a missing record returns false and writes nothing`.
  - `ensureIdentity discards shards of another identity` — a manifest with another `model_id` and one shard → `{rebuilt: true}`, `entries()` empty.
  - `refresh is a no-op`.
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/shard-writer.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3:** Write `corpus.ts` (types only) and `shardWriter` (`entries` maps `listShards()`; `touch` = `readShard` + `writeShard`; `ensureIdentity` = `store.ensureManifest`; `identity` = `store.readManifest`).
- [ ] **Step 4:** Run the test file — expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(corpus): corpus interfaces and a shard-only writer`.

### Task 3: Shared scoring and `ShardCorpus`

**Files:**
- Create: `src/lib/obsidian/corpus/scoring.ts`, `src/lib/obsidian/corpus/shard-corpus.ts`
- Modify: `src/modules/semantic/search-engine.ts` (import `cosineSimilarity` and the comparators from `scoring.ts`; exports unchanged)
- Test: `test/lib/obsidian/corpus/shard-corpus.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `ShardStore`, `decodeVector`.
- Produces:
  - `scoring.ts`: `cosineSimilarity(a, b): number`, `compareNoteHits(a: INoteHit, b: INoteHit): number` (similarity desc, then `path.localeCompare`), `compareBlockHits(a: IBlockHit, b: IBlockHit): number` (same rule) — moved, not rewritten.
  - `shard-corpus.ts`: `export class ShardCorpus implements ICorpus` with `constructor(store: ShardStore, deps?: { yieldEvery?: () => Promise<void> })`, `load(): Promise<void>`, `readonly loaded: boolean`, `size(): number` (notes with a vector).

- [ ] **Step 1: Write the failing tests** over a fixture corpus written through `ShardStore` (reuse the helpers in `test/lib/obsidian/corpus/` that build shards, or write 6 notes with 4-dim vectors):
  - `nearest matches findNeighbors for a query vector` — for thresholds `0`, `0.3`, `0.8` and `limit` `undefined`, `2`, `nearest([{vector}], opts)[0]` deep-equals `findNeighbors({queryVector, sources, threshold, limit})` over `loadCorpusSnapshot(store).sources`.
  - `nearestBlocks matches findBlockNeighbors within paths` — same, with `paths` = two notes and `sources` filtered to them.
  - `a path anchor uses the note's own vector; a note without one is null` — a note below `MIN_CHARS` (`embedding: null`) → `null`.
  - `allowed and exclude apply before limit` — `limit: 1`, `allowed: [b, c]` where `a` scores highest → `[b]` or `[c]`, never `a`.
  - `upsert is visible to the next read and replaces the old vectors`.
  - `delete removes the note from reads and entries`.
  - `ensureIdentity with another identity empties memory`.
  - `refresh re-reads shards written by another ShardStore` — write a shard through a second store on the same directory, `refresh()`, read it.
  - `entries includes notes without a vector`.
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/shard-corpus.test.ts` — expected: FAIL.
- [ ] **Step 3:** Move the scoring functions into `scoring.ts`; make `search-engine.ts` import them. Run `npx vitest run test/semantic/search-engine.test.ts` — expected: PASS unchanged.
- [ ] **Step 4:** Implement `ShardCorpus`: memory is `Map<path, {entry: ICorpusEntry, vector: Float32Array | null, blocks: SmartBlock[]}>`; every write calls the store first, then updates memory; `nearest` brute-forces with `cosineSimilarity`, filters `allowed` (as a `Set`) and `exclude` before sorting and slicing `limit`; between anchors it awaits `deps.yieldEvery` (default `() => new Promise(setImmediate)`); reads before `load()` throw `Error('corpus not loaded')`.
- [ ] **Step 5:** Run the test file and `npm run typecheck` — expected: PASS.
- [ ] **Step 6:** Commit `feat(corpus): ShardCorpus, the in-memory corpus over shard files`.

### Task 4: Reconcile split around the lock

**Files:**
- Modify: `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts` (existing cases unchanged), new `test/lib/obsidian/corpus/reconcile-profile.test.ts`

**Interfaces:**
- Consumes: `ICorpusWriter`, `shardWriter`, `ShardCorpus`.
- Produces:

```ts
export interface ILockedPassOptions {
  signal?: AbortSignal;
  onLockWait?: ReconcileOptions['onLockWait'];
  acquireLock?: ReconcileDeps['acquireLock'];
  migrateLegacy?: ReconcileDeps['migrateLegacy'];
  warn?: (message: string) => void;
}
/** Acquire the vault's lock, migrate a legacy layout, run fn, release. Resolves `undefined` when aborted before fn ran. */
export function withReconcileLock<T>(vaultRoot: string, opts: ILockedPassOptions, fn: (ctx: { waited: boolean }) => Promise<T>): Promise<T | undefined>;
export interface IProfileReconcileDeps {
  vaultRoot: string;
  stat: ReconcileDeps['stat'];
  readNote: ReconcileDeps['readNote'];
  embedDocuments: EmbedDocumentsFn;
  identity: CorpusIdentity;
  warn?: (message: string) => void;
}
/** The per-note loop and orphan sweep for one profile; the caller holds the lock and has scanned. */
export function reconcileProfile(deps: IProfileReconcileDeps, corpus: ICorpusWriter, paths: string[], opts: Omit<ReconcileOptions, 'onLockWait'>): Promise<ReconcileSummary>;
```

  `ReconcileSummary` gains `added: number` (notes embedded that had no record and were not a rename; `embedded` keeps counting them too), additive for every existing reader. `reconcileCorpus(deps, opts)` keeps its signature and becomes `withReconcileLock` + `scan()` + `reconcileProfile(…, shardWriter(deps.store), …)` + `ensureCorpusGitignored`; an aborted run still returns the empty summary.

- [ ] **Step 1: Write the failing tests** in `reconcile-profile.test.ts`, driving `reconcileProfile` over a `ShardCorpus` on a temp vault with a fake embedder returning fixed vectors:
  - `embeds a new note into memory and shards alike` — after the pass, `corpus.entries()` and a fresh `ShardStore.listShards()` agree on the path and hash.
  - `touch keeps vectors when only mtime changed`.
  - `rename by hash upserts the new path and deletes the old`.
  - `sweeps an orphan out of memory and disk`.
  - `counts added apart from changed` — one new note and one edited note → `{embedded: 2, added: 1}`.
  - `withReconcileLock reports waited when another holder had the lock` — inject `acquireLock` that calls `onWait` before resolving; `fn` receives `{waited: true}`.
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/reconcile-profile.test.ts` — expected: FAIL.
- [ ] **Step 3:** Split `reconcile.ts` as above. `reconcileLocked`'s body moves into `reconcileProfile`: `ensureIdentity` replaces `store.ensureManifest`, `corpus.entries()` replaces the parsed listing, `corpus.touch` replaces `readShard` + `writeShard` (on `false`, fall through to re-embed), `corpus.upsert` replaces `writeShard`, `corpus.delete` replaces `deleteShard`.
- [ ] **Step 4:** Run `npx vitest run test/lib/obsidian/corpus test/semantic/backend test/cli-index.test.ts` — expected: PASS with every existing case unchanged.
- [ ] **Step 5:** Commit `refactor(corpus): split reconcile around the lock, write through the corpus`.

### Task 5: `VaultScope.isSubtreeExcluded`

**Files:**
- Modify: `src/lib/obsidian/vault-scope.ts`
- Test: `test/lib/obsidian/vault-scope.test.ts`

**Interfaces:**
- Produces: `VaultScope.isSubtreeExcluded(relDir: string): boolean` — true when `relDir` has a dot segment, or when picomatch of the prefixes of every pattern ending in `/**` (pattern minus `/**`) matches `relDir`. `''` (the vault root) is never excluded. Test doubles implementing `VaultScope` elsewhere gain the method (grep `isExcluded:` in `test/`).

- [ ] **Step 1: Write the failing table test** `isSubtreeExcluded prunes only provable subtrees` with `createVaultScope({ gitignoreLines: ['build'], configExclusions: ['Archive', 'Drafts/*', '**/private/**'] })`: `'' → false`, `'.obsidian' → true`, `'Notes/.trash' → true`, `'Templates' → true`, `'Templates/Daily' → true`, `'build' → true`, `'Archive' → true`, `'Archive/2024' → true`, `'Drafts' → false`, `'Drafts/x' → false`, `'a/private' → true`, `'Notes' → false`.
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/vault-scope.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement; compile the prefix matcher once in `createVaultScope`.
- [ ] **Step 4:** Run the test file and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(scope): isSubtreeExcluded for subtree pruning`.

### Task 6: Scope-aware watcher

**Files:**
- Create: `src/lib/vault-entry/watcher.ts` (moved from `src/modules/semantic/backend/vault-watcher.ts`)
- Delete: `src/modules/semantic/backend/vault-watcher.ts`
- Modify: `src/modules/semantic/backend/index.ts` (import from the new path; pass `scope`)
- Test: move `test/semantic/backend/vault-watcher.test.ts` to `test/lib/vault-entry/watcher.test.ts`; add `test/lib/vault-entry/watcher-chokidar.test.ts`

**Interfaces:**
- Produces: `startVaultWatcher(deps: VaultWatcherDeps): WatcherHandle` where `VaultWatcherDeps` gains `scope: Pick<VaultScope, 'isExcluded' | 'isSubtreeExcluded'>`; `WatcherFactory` options gain the same `scope`. Exported pure helpers `vaultRelative(vaultRoot: string, p: string): string` (POSIX separators) and `isPrunedDir(scope, vaultRoot, p): boolean`, `isWatchedNote(scope, vaultRoot, p): boolean`. `isIgnoredPath` and `isMarkdownPath` are removed.

- [ ] **Step 1: Write the failing tests:**
  - `vaultRelative converts Windows separators` — `vaultRelative('C:\\vault', 'C:\\vault\\Archive\\n.md')` → `'Archive/n.md'` (use `path.win32` in the helper when the root contains `\\`, so the test runs on POSIX too).
  - `isWatchedNote` table: `.md` in scope → true; `.md` under `Archive/**` → false; `.txt` → false; `Notes/.trash/x.md` → false; `Archive/2024/x.md` with `Archive/*` → true.
  - `isPrunedDir` never prunes the vault root, a vault under a dot directory (`/home/u/.sync/vault` root, `p` = root) is not pruned.
  - chokidar test (`watcher-chokidar.test.ts`, real chokidar, temp vault with `Archive/**` excluded, `debounceMs: 50`): writing `Archive/a.md` fires no `onQuiet` within 500 ms; writing `Notes/b.md` fires one.
- [ ] **Step 2:** Run `npx vitest run test/lib/vault-entry` — expected: FAIL.
- [ ] **Step 3:** Move the watcher; `ignored: (p, stats) => isPrunedDir(scope, vaultRoot, p)` ignoring `stats`; `forward` checks `isWatchedNote`; drop the `.tmp` clause. Update `backend/index.ts` to pass the `scope` it already receives.
- [ ] **Step 4:** Run `npx vitest run test/lib/vault-entry test/semantic/backend` and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(watcher): follow the vault scope (#106)` (body: prune only provable subtrees; filter events by isExcluded).

### Task 7: Reconcile loop for one vault, many profiles

**Files:**
- Create: `src/lib/vault-entry/reconcile-loop.ts`
- Test: `test/lib/vault-entry/reconcile-loop.test.ts` (port of `test/semantic/backend/corpus-backend.test.ts` cases, plus multi-profile cases)

**Interfaces:**
- Consumes: `withReconcileLock`, `reconcileProfile` (Task 4), `ShardCorpus` (Task 3), `BackendStatus` (`semantic-backend.ts`), `isManifestCompatible`, `formatRebuild`, `CorpusLockTimeoutError`, `describeHolder`.
- Produces:

```ts
export interface ILoopProfile {
  key: string;
  identity: CorpusIdentity;
  corpus: ICorpus & { load(): Promise<void>; readonly loaded: boolean };
  embedDocuments: EmbedDocumentsFn;
  enabled: boolean;
}
export interface ILastReconcile { at: string; added: number; changed: number; removed: number; ms: number }
export interface IReconcileLoopDeps {
  vaultRoot: string;
  vaultName: string;
  scan: () => Promise<string[]>;
  stat: ReconcileDeps['stat'];
  readNote: ReconcileDeps['readNote'];
  warn?: (m: string) => void;
  retryBaseMs?: number; retryMaxMs?: number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  now?: () => number;
  /** Injected by tests; production uses withReconcileLock. */
  withLock?: typeof withReconcileLock;
}
export interface IReconcileLoop {
  addProfile(profile: ILoopProfile): void;      // starts its startup selection; picked up by the next pass
  removeProfile(key: string): void;            // leaves the loop; caller disposes the corpus
  status(key: string): BackendStatus;
  lastReconcile(key: string): ILastReconcile | undefined;
  requestPass(): void;                         // coalesces while a pass runs
  whenSettled(): Promise<void>;                // tests only
  dispose(): Promise<void>;                    // aborts the pass in flight
}
export function createReconcileLoop(deps: IReconcileLoopDeps): IReconcileLoop;
```

  `ILastReconcile` from a profile's `ReconcileSummary`: `added` = `summary.added`, `changed` = `summary.embedded - summary.added + summary.renamed`, `removed` = `summary.deleted`. A disabled profile reports `disabled` and is skipped by passes. After the profiles, a pass runs `ensureCorpusGitignored(vaultRoot)` as `reconcileCorpus` does.

- [ ] **Step 1: Port the failing tests.** Each `createCorpusBackend` case becomes a one-profile `createReconcileLoop` case with the same assertion on `status(key)` (snapshot assertions become corpus-read assertions). Add:
  - `one lock acquisition for two profiles` — inject `withLock` counting calls; two profiles, one `requestPass()` → one call, both corpora reconciled, in `addProfile` order.
  - `a profile added mid-pass is built by the next pass`.
  - `a pass that waited refreshes every corpus` — `withLock` passing `{waited: true}`; spy `refresh` on both corpora.
  - `setScope during a pass queues one pass` (Review Focus) — `requestPass()` twice during a pass → exactly one follow-up pass.
  - `the empty-corpus guard per profile` — the "every note fails" case reports `unavailable` for that profile only.
- [ ] **Step 2:** Run `npx vitest run test/lib/vault-entry/reconcile-loop.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement by carrying over `createCorpusBackend`'s state per profile (status, `loaded`, retry timer, `lockTimedOut`); one `currentPass` and one `dirty` flag for the loop; a pass is `withLock(vaultRoot, {signal, onLockWait}, async ({waited}) => { if (waited) refresh all; const paths = await scan(); for (p of enabled profiles in order) reconcileProfile(…) })`. Startup selection per profile: `identity()` + `load()` + `isManifestCompatible(stored, identity, entries.size > 0)` → `ready`.
- [ ] **Step 4:** Run the test file and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(vault-entry): one reconcile loop per vault over many profiles`.

### Task 8: `IVaultEntry` and `VaultEntries`

**Files:**
- Create: `src/lib/vault-entry/vault-entry.ts`, `src/lib/vault-entry/vault-entries.ts`, `src/lib/vault-entry/index.ts`
- Test: `test/lib/vault-entry/vault-entry.test.ts`, `test/lib/vault-entry/vault-entries.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7; `loadVaultConfig`, `loadVaultScope`, `FsVaultReader`, `buildReconcileFsDeps`, `MODEL_PROFILES`, `identityOf`, `corpusIdentityOf`.
- Produces:

```ts
export class VaultEntryError extends Error {
  constructor(readonly code: 'NOT_ATTACHED' | 'VAULT_UNAVAILABLE' | 'UNKNOWN_PROFILE', message: string);
}
export interface IProfileInfo { profile: string; state: BackendState; indexed?: number; total?: number; notes?: number; last_reconcile?: ILastReconcile }
export interface IVaultInfo { vault: string; clients: number; idle_since?: string; profiles: IProfileInfo[] }
export interface IVaultEntriesDeps {
  /** Per profile key: the document embedder (daemon: the embed service's queue). */
  embedderFor: (profileKey: string) => EmbedDocumentsFn;
  idleTimeoutMs: number;               // 0 = never
  realpath?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
  loadScope?: (vaultRoot: string) => Promise<{ scope: VaultScope; semantic: boolean }>;
  createEntry?: (opts: IVaultEntryOptions) => IVaultEntry;   // tests
  timers?: Timers; now?: () => Date; warn?: (m: string) => void;
}
export class VaultEntries {
  constructor(deps: IVaultEntriesDeps);
  attach(connectionId: number, vault: string, profiles: readonly string[]): Promise<{ vault: string; profiles: Record<string, BackendStatus> }>;
  status(connectionId: number, vault: string, profile: string): BackendStatus;
  /** For corpus reads: the attached corpus reader with the scope folded in, or VaultEntryError. */
  reader(connectionId: number, vault: string, profile: string): { reader: ICorpusReader; status: BackendStatus; dims: number };
  detach(connectionId: number): void;
  info(): IVaultInfo[];
  dispose(): Promise<void>;
}
```

  `IVaultEntry` (one directory) owns `scope`, `reader` (`FsVaultReader`), watcher (Task 6, `onQuiet` → `loop.requestPass()`), loop (Task 7), corpora per profile, and the excluded-path cache: `excludedPaths(profile)` is recomputed from `corpus.entries()` filtered by `scope.isExcluded` after each pass and on `setScope`; reads fold it into `exclude` and filter `allowed` by `!isExcluded`. It exposes `addProfile(key)`, `removeProfile(key)`, `setScope(scope)` (restart the watcher, rebuild the reader, `requestPass()`, recompute the cache), `status(key)`, `reader(key)`, `info(clients, idleSince)`, `dispose()`.

- [ ] **Step 1: Write the failing tests** (`vault-entries.test.ts`, fake timers, injected `createEntry` recording calls, injected `realpath`/`isDirectory`/`loadScope`):
  - `same key for trailing slash and symlink` (Review Focus) — `realpath` maps both inputs to `/v`; one `createEntry` call; both attach results carry `vault: '/v'`.
  - `VAULT_UNAVAILABLE for a missing path` and `for a file`.
  - `UNKNOWN_PROFILE for a key outside MODEL_PROFILES`.
  - `disabled when the vault's semantic key is false` — `loadScope` returns `{semantic: false}` → `{ 'harrier-270m': {state: 'disabled'} }`.
  - `profiles: [] attaches without a corpus`.
  - `NOT_ATTACHED for another connection's vault` (`status` and `reader`).
  - `detach starts the entry and profile timers; firing drops them` — after `idleTimeoutMs`, `info()` is empty and the entry's `dispose` ran.
  - `attach during idle reuses` (Review Focus) — detach, advance half the timeout, attach again: no second `createEntry`, timer cancelled, `dispose` never called.
  - `detach before attach settles` (Review Focus) — start `attach`, call `detach(conn)` before awaiting it; after the timeout the entry is dropped.
  - `an unused profile is freed on its own` — two connections, two profiles; detaching one frees only its profile after the timeout.
  - `scope change on attach calls setScope` — second `loadScope` returns different `ignorePatterns`.
  - `idleTimeoutMs 0 never drops`.
  - `vault-entry.test.ts`: `reads fold the scope` — a corpus holding `Archive/x.md` and `Notes/y.md`, scope excluding `Archive/**`: `reader('p').nearest` never returns `Archive/x.md`, with and without `allowed`.
- [ ] **Step 2:** Run `npx vitest run test/lib/vault-entry` — expected: FAIL.
- [ ] **Step 3:** Implement. Default `loadScope` = `loadVaultConfig` + `loadVaultScope(root, {config})`, `semantic = config.semantic !== false`. Default `realpath` = `fs.promises.realpath`. `ShardStore` per profile under the realpath with `modelKey` and `dims` from `identityOf(MODEL_PROFILES[key])`.
- [ ] **Step 4:** Run the tests and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(vault-entry): vault entries keyed by realpath, with attach and idle`.

### Task 9: Connection context, error codes and `data`

**Files:**
- Modify: `src/daemon/protocol.ts`, `src/daemon/socket-server.ts`, `src/daemon/services/{daemon,embed}.ts` (handler signature only)
- Test: `test/daemon/protocol.test.ts`, `test/daemon/socket-server.test.ts`

**Interfaces:**
- Produces:

```ts
export interface IConnectionContext { readonly id: number; onClose(fn: () => void): void }
export type MethodHandler = (params: unknown, ctx: IConnectionContext) => Promise<unknown>;
// ServiceRegistry.dispatch(request: JSONRPCRequest, ctx: IConnectionContext): Promise<JSONRPCMessage>
export type DaemonErrorCode = … | 'NOT_ATTACHED' | 'VAULT_UNAVAILABLE';   // both → ErrorCode.InvalidParams
export class DaemonRpcError extends Error { constructor(code: DaemonErrorCode, message: string, data?: Record<string, unknown>) }
export function errorResponse(id: RequestId, code: DaemonErrorCode, message: string, data?: Record<string, unknown>): JSONRPCMessage; // data merged beside code
```

- [ ] **Step 1: Write the failing tests:**
  - protocol: `errorResponse merges data beside code` → `error.data` equals `{ code: 'NOT_ATTACHED', extra: 1 }`; `dispatch passes ctx to the handler`; `a DaemonRpcError's data reaches the response`.
  - socket-server: `each connection gets its own context id`; `onClose callbacks run when that socket closes, not another`.
- [ ] **Step 2:** Run `npx vitest run test/daemon/protocol.test.ts test/daemon/socket-server.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement; `startDaemonServer` keeps a counter for ids and runs the socket's callbacks in its `'close'` handler, each guarded so one throw does not skip the rest.
- [ ] **Step 4:** Run `npx vitest run test/daemon` and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(daemon): per-connection context and error data for services`.

### Task 10: The `vault` service, `daemon.info` and `daemon status`

**Files:**
- Create: `src/daemon/services/vault.ts`
- Modify: `src/daemon/services/embed.ts` (expose `documentsFor(profileKey): EmbedDocumentsFn`), `src/daemon/services/daemon.ts` and `src/daemon/protocol.ts` (`DaemonInfoResult.services.vault: IVaultInfo[]`), `src/cli-daemon.ts` (build `VaultEntries`, register `vault`, dispose entries on stop), `src/daemon/admin.ts` (print entry and profile lines)
- Test: `test/daemon/vault-service.test.ts`, `test/daemon/embed-service.test.ts`, `test/daemon/daemon-service.test.ts`, `test/cli-daemon.test.ts` (status output)

**Interfaces:**
- Consumes: `VaultEntries` (Task 8), `IConnectionContext` (Task 9).
- Produces: `createVaultService(entries: VaultEntries): ServiceHandlers` with `attach` (params `{vault: string, profiles: string[]}`; `INVALID_PARAMS` for anything else; `VaultEntryError` → `DaemonRpcError` of the same code; registers `ctx.onClose(() => entries.detach(ctx.id))` once per connection) and `status` (params `{vault, profile}`). `documentsFor(key)` returns an `EmbedDocumentsFn` that loads the profile through the existing `get()` on first use and embeds on the documents lane of its queue.
- `daemon status` lines (exact shape, two-space indent):

```text
17.2.0  pid 4242  clients 2  loaded [harrier-270m]  alive  /tmp/neuro-vault-501/abc.sock
  vault /vaults/notes  clients 2
    harrier-270m  ready  955 notes  last reconcile 2026-10-16T09:00:00Z +1 ~0 -0 340 ms
  vault /vaults/work  idle since 2026-10-16T08:55:00Z
    harrier-270m  indexing 120/840
```

- [ ] **Step 1: Write the failing tests:**
  - vault service: `attach validates params` (`INVALID_PARAMS` for a missing `vault`, a non-array `profiles`); `maps VaultEntryError codes`; `closing the connection detaches it` (fire the ctx's `onClose`, then `entries.detach` was called with the id).
  - embed service: `documentsFor loads the profile once and embeds documents`.
  - daemon service: `info lists vault entries`.
  - cli-daemon status: the printed lines above for a fake `daemon.info` answer.
- [ ] **Step 2:** Run `npx vitest run test/daemon test/cli-daemon.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement; in `startServing` build `VaultEntries({ embedderFor: embed.documentsFor, idleTimeoutMs: options.idleTimeoutMinutes * 60_000, timers: r.timers })`, register `vault`, and make `createStop` await `entries.dispose()` before closing the server.
- [ ] **Step 4:** Run the tests and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(daemon): vault service and vault entries in daemon status`.

### Task 11: Socket-level integration test, docs, PR 1

**Files:**
- Create: `test/integration/daemon-vault-entry.test.ts`, `docs/architecture/vault-entry.md`
- Modify: `docs/architecture/shared-daemon.md`, `docs/architecture/own-corpus.md`, `docs/architecture/vault-scope.md`, `docs/architecture/README.md`

**Interfaces:**
- Consumes: everything above, through a real `startDaemonServer` on a temp socket path with `ServiceRegistry` holding `vault` over `VaultEntries` with a fake `embedderFor` (fixed 4-dim vectors, so no model loads).

- [ ] **Step 1: Write the failing integration tests** with the `LineClient` pattern of `test/daemon/socket-server.test.ts` over a temp vault of three notes:
  - `attach then status goes indexing to ready`.
  - `two connections share one entry` — `daemon.info`-equivalent `entries.info()[0].clients === 2`.
  - `profiles [] attaches without a corpus` — no `.neuro-vault/corpus/` directory appears.
  - `a note write triggers one pass; an excluded write triggers none` (config `"exclusions": ["Archive"]`, `debounceMs` injected small).
  - `close plus idle timeout drops the entry` (idle 200 ms).
  - `NOT_ATTACHED` and `VAULT_UNAVAILABLE` over the wire, with `data.code`.
  - `vanished vault directory` (Review Focus) — attach, delete the vault directory, request a pass → `status` is `unavailable` with a reason; a second vault on the same daemon still answers `ready`.
- [ ] **Step 2:** Run `npx vitest run test/integration/daemon-vault-entry.test.ts` — expected: FAIL first, then PASS once wiring gaps found here are fixed (fix them in the owning module, with a unit test there).
- [ ] **Step 3:** Write `docs/architecture/vault-entry.md` (what a vault entry holds; attach without detach; idle per entry and per corpus; one reconcile loop and lock acquisition per pass; the watcher's prune and filter rules; the excluded-path fold; how it differs from the session's `IRegisteredVault`). Update `shared-daemon.md` (the `vault` service, connection context, error `data`, status lines), `own-corpus.md` (`ShardStore`, the corpus interface, `withReconcileLock` + `reconcileProfile`, `shardWriter` for `index`), `vault-scope.md` (`isSubtreeExcluded`, the watcher), and the `docs/architecture/README.md` map.
- [ ] **Step 4:** Run `npm test && npm run lint && npm run typecheck && npm run format && npm run build` — expected: all PASS.
- [ ] **Step 5:** Commit `test(daemon): vault entry over a real socket` and `docs(architecture): vault entry and the corpus interface`.
- [ ] **Step 6:** Push and open PR 1 to `main` with `Refs #158` and `Refs #175` (no `Closes`). Stop here until PR 1 is reviewed and merged.

---

# PR 2 — sessions read through the daemon

Start from `main` after PR 1 merged. Each task below states its interfaces; the PR 1 types are the ones defined in Tasks 2–10.

### Task 12: `SharedServices` — one connection, one switch

**Files:**
- Create: `src/modules/semantic/shared-services.ts`
- Modify: `src/modules/semantic/provider-factory.ts`, `src/modules/semantic/daemon-embedding-provider.ts`, `src/modules/semantic/daemon-connection.ts` (surface `data` on `DaemonRpcError`), `src/server.ts`, `src/cli-index.ts`
- Test: `test/semantic/shared-services.test.ts`, existing `test/semantic/{provider-factory,daemon-embedding-provider,daemon-connection}.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SharedServices {
  readonly mode: 'pending' | 'daemon' | 'local';
  readonly connection: IDaemonLink;
  /** ensure() the connection; on DaemonUnavailableError flip to 'local' once, write one stderr line, and return 'local'. */
  ensure(): Promise<'daemon' | 'local'>;
  close(): void;
}
export function createSharedServices(opts: ProviderFactoryOptions): SharedServices;  // `shared: false` → mode 'local' from the start, no line
// createEmbeddingProvider(opts, services?: SharedServices): EmbeddingProvider
```

  `DaemonEmbeddingProvider` takes `services` instead of `connection` and asks `services.ensure()`; its own `switchToFallback` and stderr line go. The stderr line text is today's, with "shared embedding daemon" replaced by "shared daemon".

- [ ] **Step 1: Write the failing tests:** `one stderr line for two facades` (two callers of `ensure()` both get `'local'`, one line); `a connection error does not flip` (`ensure` resolves `'daemon'` again after a `DaemonConnectionError` on a request); `shared: false is local without a line`; daemon-connection `rejects with DaemonRpcError carrying data`.
- [ ] **Step 2:** Run `npx vitest run test/semantic` — expected: the new tests FAIL.
- [ ] **Step 3:** Implement and update `server.ts` and `cli-index.ts` to build one `SharedServices` and pass it to `createEmbeddingProvider`.
- [ ] **Step 4:** Run `npx vitest run test/semantic test/cli-index.test.ts test/server-modules.test.ts` and `npm run typecheck` — expected: PASS, existing fallback scenarios unchanged.
- [ ] **Step 5:** Commit `refactor(semantic): one daemon connection and one fallback switch per process`.

### Task 13: The `corpus` service (parallel-safe with Tasks 14–15)

**Files:**
- Create: `src/daemon/services/corpus.ts`
- Modify: `src/daemon/protocol.ts` (codes `CORPUS_NOT_READY` → `InternalError` with `data.status`, `CORPUS_FAILED` → `InternalError`; param and result types `CorpusNearestParams/Result`, `CorpusNearestBlocksParams/Result`), `src/cli-daemon.ts`
- Test: `test/daemon/corpus-service.test.ts`, `test/integration/daemon-vault-entry.test.ts`

**Interfaces:**
- Consumes: `VaultEntries.reader(connectionId, vault, profile)` (Task 8).
- Produces: `createCorpusService(entries: VaultEntries): ServiceHandlers` with `nearest` and `nearestBlocks`. Params: `{vault, profile, anchors: ({vector: number[]} | {path: string})[], threshold: number, limit?, allowed?, exclude?}` / `{…, paths: string[]}`. Results `{hits}`. Order of checks: params shape (`INVALID_PARAMS`), attachment (`NOT_ATTACHED`), profile (`UNKNOWN_PROFILE`), status not `ready` (`CORPUS_NOT_READY`, `data: {status}`), vector length ≠ `dims` (`INVALID_PARAMS`), reader throws (`CORPUS_FAILED`).

- [ ] **Step 1: Write the failing tests:** one per error in the order above; `one list per anchor with null for a short note`; `allowed narrows before limit`; over the socket: `corpus.nearest returns no vectors` (assert no number array of length `dims` anywhere in the answer).
- [ ] **Step 2:** Run `npx vitest run test/daemon/corpus-service.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement; register `corpus` in `startServing`.
- [ ] **Step 4:** Run `npx vitest run test/daemon test/integration` and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(daemon): corpus.nearest and corpus.nearestBlocks`.

### Task 14: `executeRetrieval` over `ICorpusReader`

**Files:**
- Create: `test/semantic/_legacy-retrieval.ts` (a frozen copy of today's `executeRetrieval` with its helpers, imports pointed at `src/`), `src/modules/semantic/snapshot-reader.ts` (temporary: a `ICorpusReader` over `Map<string, SmartSource>`, deleted in Task 16)
- Modify: `src/modules/semantic/retrieval-policy.ts`, `src/modules/semantic/retrieval-pipeline.ts`, `eval/pipelines.ts`
- Test: `test/semantic/retrieval-parity.test.ts`, existing `test/semantic/{retrieval-policy,retrieval-pipeline}.test.ts`

**Interfaces:**
- Produces: `RetrievalInput` drops `sources` and `searchEngine`, gains `corpus: ICorpusReader` and `allowed?: readonly string[]`. `executeRetrieval(input): Promise<RetrievalOutput>` with `RetrievalOutput` unchanged. `RetrievalPipelineDeps` replaces `snapshot` + `searchEngine` with `corpus?: ICorpusReader`. `snapshotReader(sources: Map<string, SmartSource>): ICorpusReader`.
- Composition, per design D13: seeds = one `nearest(queryVectors, {threshold, limit: limit + 1, allowed})`; fallback = one `nearest` over the vectors of queries left empty, only when the threshold is a default and above `similarity.fallback`; blocks = one `nearestBlocks(queryVectors, {paths: seedPaths, threshold: quick ? 0 : similarity.deep, limit: quick ? QUICK_BLOCK_LIMIT : limit})`; backfill = per starved seed one `nearestBlocks(queryVectors, {paths: [seed], threshold: 0, limit: 1})`, best over anchors; expansion = one `nearest(seedPaths.map(path => ({path})), {threshold: expansionFloor, limit: expansionLimit, exclude: seedPaths, allowed})`.

- [ ] **Step 1: Write the failing parity test** `retrieval-parity.test.ts`: over a 30-note fixture with 8-dim vectors and blocks, for `mode` ∈ {`quick`, `deep`} × `allowed` ∈ {none, 10 paths} × threshold ∈ {default, explicit `0.9`} × queries ∈ {1, 3, one with no hit above default}, `executeRetrieval({…, corpus: snapshotReader(sources), allowed})` deep-equals `legacyExecuteRetrieval({…, sources: narrowed, searchEngine})`. Also `one nearest call carries every query vector` (spy on the reader: the first call has 3 anchors).
- [ ] **Step 2:** Run `npx vitest run test/semantic/retrieval-parity.test.ts` — expected: FAIL.
- [ ] **Step 3:** Implement; `runRetrievalPipeline` passes `input.allowed` as an array and drops `narrowSources`; `search-notes.ts` builds `corpus: snapshotReader(snapshot.sources)` from the backend until Task 16; `eval/pipelines.ts` likewise.
- [ ] **Step 4:** Run `npx vitest run test/semantic test/eval` and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `refactor(retrieval): compose the semantic leg over corpus reads`.

### Task 15: `get_similar_notes` and `find_duplicates` over `ICorpusReader`

**Files:**
- Modify: `src/modules/semantic/tools/get-similar-notes.ts`, `src/modules/semantic/tools/find-duplicates.ts`
- Test: `test/semantic/tools/get-similar-notes.test.ts`, `test/semantic/tools/find-duplicates.test.ts`

**Interfaces:**
- Consumes: `snapshotReader` (Task 14) until Task 16.
- Produces: deps lose `searchEngine`; both read `corpus` from the backend (through `snapshotReader` for now). `DUPLICATE_ANCHOR_BATCH = 64` exported from `find-duplicates.ts`.

- [ ] **Step 1: Write the failing tests** through `test/_gate.ts`: `a link to a short note is a forward_link` (the linked note has `embedding: null`); `NOT_FOUND when the note has no vector`; `find_duplicates reports a pair once, note_a before note_b`; `find_duplicates batches anchors by 64` (spy: 130 notes → 3 `nearest` calls); existing ranking cases unchanged.
- [ ] **Step 2:** Run `npx vitest run test/semantic/tools` — expected: the new tests FAIL.
- [ ] **Step 3:** Implement per design D14; the basename index comes from `buildBasenameIndex(await entry.reader.scan())`.
- [ ] **Step 4:** Run the tool tests and `npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `refactor(semantic): similar notes and duplicates over corpus reads` (body names the forward_link change).

### Task 16: The new `SemanticBackend`, local and daemon implementations

**Files:**
- Create: `src/modules/semantic/backend/local-backend.ts`, `src/modules/semantic/backend/daemon-backend.ts`
- Modify: `src/lib/obsidian/semantic-backend.ts`, `src/modules/semantic/backend/index.ts`, `src/lib/vault-registry.ts`, `src/lib/resolve-vault.ts`, `src/lib/single-vault-tool.ts`, `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/index.ts`, `src/server.ts`, `eval/backends.ts`
- Delete: `src/modules/semantic/backend/corpus-backend.ts`, `src/lib/obsidian/corpus/snapshot.ts`, `src/modules/semantic/snapshot-reader.ts`, their tests; `SearchEngine` from tool deps
- Test: `test/semantic/backend/local-backend.test.ts`, `test/semantic/backend/daemon-backend.test.ts`, updated tool, registry and server tests

**Interfaces:**
- Produces:

```ts
export interface SemanticBackend extends ICorpusReader {
  status(): Promise<BackendStatus>;
  dispose(): Promise<void>;
}
export function createLocalSemanticBackend(opts: { entries: VaultEntries; connectionId: number; vaultRoot: string; profile: string }): SemanticBackend;
export function createDaemonSemanticBackend(opts: { services: SharedServices; vaultRoot: string; profile: string; local: () => SemanticBackend }): SemanticBackend;
```

  The daemon backend: per connection epoch, `vault.attach {vault: vaultRoot, profiles: [profile]}` before the first call (10 s), remembering the realpath key; `status()` = `vault.status` (10 s; timeout → `{state: 'unavailable', reason: 'daemon did not answer'}`); reads = `corpus.*` (30 s); `CORPUS_NOT_READY` → a readiness error carrying `data.status` that `resolveSemanticVault` and `search_notes` map as today; `CORPUS_FAILED` / `NOT_ATTACHED` → `DEPENDENCY_ERROR`; when `services.ensure()` returns `'local'`, every call delegates to `local()` (built once). `semanticBackendFactory` builds the daemon backend when `--shared` (default) and the local one under `--no-shared`; both are given the same lazily created in-process `VaultEntries` for the fallback.

- [ ] **Step 1: Write the failing tests:** local backend `serves reads after the vault is ready`, `status is async`; daemon backend with a fake `IDaemonLink`: `attaches once per epoch`, `re-attaches after a new epoch`, `status timeout reads unavailable`, `CORPUS_NOT_READY maps to the readiness error`, `switches to local once services is local`; `search_notes` `a status timeout degrades to lexical with unavailable`; `get_similar_notes` `SEMANTIC_INDEX_BUILDING while indexing` through the new status.
- [ ] **Step 2:** Run `npx vitest run test` — expected: the new tests FAIL.
- [ ] **Step 3:** Swap the interface and every call site in this one task; delete the files listed above.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run lint` — expected: PASS.
- [ ] **Step 5:** Commit `feat(semantic): sessions read the corpus through the vault entry` (no `!`: no tool contract changes).

### Task 17: Startup attach and teardown

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-modules.test.ts`, `test/integration/session-daemon.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 12, 16.
- Produces: `startNeuroVaultServer` calls `void backend.status()` for every semantically enabled vault right after `server.connect` (the first call triggers the attach); `dispose` closes `services` (detaching from every entry) and disposes the in-process `VaultEntries` if it was built.

- [ ] **Step 1: Write the failing tests:** `startup does not wait for attach` (a daemon link whose attach never answers; `initialize` completes); `status reads indexing 0/0 before attach answers`; `one fallback line when the daemon cannot start` (embedding and corpus both local); `transport close detaches` (the fake daemon sees the connection close); `--no-shared builds local entries and no connection`; integration over a real daemon process built from `dist/` is out of scope for CI — the integration test uses an in-test `startDaemonServer` with `vault` + `corpus` + a fake `embed`, and a `SharedServices` pointed at its socket: `two sessions share one entry` and `a killed server socket is reconnected on the next call`.
- [ ] **Step 2:** Run `npx vitest run test/server-modules.test.ts test/integration` — expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck` — expected: PASS.
- [ ] **Step 5:** Commit `feat(server): attach every vault in the background at startup`.

### Task 18: ADR-0020 and the docs sweep

**Files:**
- Create: `docs/adr/0020-per-vault-state-in-the-daemon.md` (only after the owner's ack, design D17)
- Modify: `docs/adr/INDEX.md`, `docs/architecture/{semantic-backend,search-engine,vault-registry,shared-daemon,vault-entry,own-corpus}.md`, `docs/guide/**`, `README.md`

- [ ] **Step 1:** Ask the owner to ack ADR-0020's scope (vault entry, attach without detach, idle per entry and corpus, one connection and switch, supersedes ADR-0014's in-process watcher in part). Write it on ack; otherwise record the decisions in `vault-entry.md` only.
- [ ] **Step 2:** `grep -rn "snapshot()\|CorpusSnapshot\|in-process watcher\|SearchEngine\|per session" docs README.md` and fix every hit that the change made untrue, including `docs/guide/`.
- [ ] **Step 3:** Run `npm run format` — expected: PASS.
- [ ] **Step 4:** Commit `docs: per-vault state in the daemon's vault entry`.

### Task 19: Verify, retrospective, archive, PR 2

- [ ] **Step 1:** `/opsx:verify` → `verify.md`: gates; `npm run eval` scores before (PR 1 merge commit) and after, identical; by hand on the owner's vault with `npm run build` and `node dist/cli.js`: three sessions → `daemon status` shows one entry with `clients 3` and one corpus, and no session has a chokidar watcher (`lsof -p <pid>` shows no vault directory handles); `kill` the daemon → the next `search_notes` succeeds after respawn; `--no-shared` serves in-process; per-session footprint at +300 s for N = 1, 3, 5 against the settled table on #158, posted on #158 as a percentage.
- [ ] **Step 2:** `retrospective.md`.
- [ ] **Step 3:** `npx openspec archive -y`; `npx openspec validate --all`.
- [ ] **Step 4:** Run all gates and `npm run build`; push; open PR 2 to `main` with `Refs #158`, `Closes #175`, `Closes #106`.
