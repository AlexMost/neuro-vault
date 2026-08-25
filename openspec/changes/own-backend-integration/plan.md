# Own-Backend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server serve every semantic call from the embedding corpus it owns — building it in the background when it is missing, promoting it live when it is ready, keeping it fresh with a watcher, and telling the client which of the four states each vault is in.

**Architecture:** Each vault entry holds a `SemanticBackend` — `snapshot()` for the ranking code, `status()` for the contract surfaces, `dispose()` for shutdown. A per-vault lifecycle object implements it over `CorpusStore` + `reconcileCorpus`, decides at startup whether it can serve immediately or must build first, promotes a finished index by swapping one in-memory snapshot, and re-reconciles after a debounced file-watcher signal. One embedding model serves the whole process through a two-lane queue that puts query embeds ahead of indexing work.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 20, vitest, chokidar (new), `@xenova/transformers` (existing), `write-file-atomic` (existing).

**Spec:** `openspec/changes/own-backend-integration/` — `proposal.md` (why), `design.md` (D1–D13, the decision each task implements), `specs/semantic-backend-lifecycle/spec.md`, `specs/hybrid-search/spec.md`, `specs/corpus-staleness-filtering/spec.md`, `tasks.md`.

## Global Constraints

- **Node ≥ 20**, ESM, strict TypeScript. `npm run typecheck` (`tsc --noEmit`) is authoritative — a `tsup` build is not (isolatedModules).
- **Gates before any commit is considered done:** `npm test`, `npm run lint`, `npm run typecheck`. All three must pass.
- **stdout is the MCP transport.** Every diagnostic goes to stderr (`console.error` or an injected `warn`). A `console.log` anywhere in `src/` is a defect.
- **No native dependencies, no install-time build** — `npx` distribution (ADR-0013).
- **Dependency injection over module mocks.** Every new module takes its clock, filesystem, watcher and embedder as constructor/factory arguments so tests never touch the real ones.
- **Never block startup.** No `await` on indexing or reconcile work on the path from `main()` to `server.connect()`.
- **The corpus library (`src/lib/obsidian/corpus/`) imports nothing from `src/modules/`.** It sees the model only as `EmbedFn = (text: string) => Promise<number[]>`.
- **Smart Connections files are not edited or deleted here** (`smart-connections-loader.ts`, `smart-connections-corpus-index.ts`, `docs/architecture/smart-connections-corpus.md`, ADR-0006). They stop being wired; #88 removes them.
- **Conventional Commits**, one commit per task step group as written below.

---

## Task 1: The backend contract in a neutral home

Implements design D1.

**Files:**

- Create: `src/lib/obsidian/semantic-backend.ts`
- Modify: `src/lib/obsidian/smart-connections-corpus-index.ts` (import `CorpusSnapshot` instead of declaring it)
- Test: none of its own — this task's test is `npm run typecheck`

**Interfaces:**

- Consumes: `BasenameIndex` from `src/lib/obsidian/link-resolver.js`, `SmartSource` from `src/lib/obsidian/smart-connections-types.js`
- Produces: `CorpusSnapshot`, `BackendState`, `BackendStatus`, `SemanticBackend` — every later task imports these from `src/lib/obsidian/semantic-backend.js`

- [ ] **Step 1: Create the contract module**

```ts
// src/lib/obsidian/semantic-backend.ts
import type { BasenameIndex } from './link-resolver.js';
import type { SmartSource } from './smart-connections-types.js';

/** What every semantic tool ranks against: notes keyed by vault-relative path. */
export interface CorpusSnapshot {
  sources: Map<string, SmartSource>;
  basenameIndex: BasenameIndex;
}

/**
 * `disabled` is deliberate (the vault turned semantics off); `unavailable` is
 * broken. Never report a failure as `disabled`.
 */
export type BackendState = 'ready' | 'indexing' | 'disabled' | 'unavailable';

export interface BackendStatus {
  state: BackendState;
  /** Present exactly while `state === 'indexing'`. 0/0 until the scan lands. */
  indexed?: number;
  total?: number;
  /** Present for `unavailable`: why the corpus could not be served. */
  reason?: string;
}

/**
 * One backend per vault entry, read by all three semantic tools of that vault.
 * `snapshot()` is what ranking consumes; `status()` is what the contract
 * surfaces report; `dispose()` releases background resources at shutdown.
 */
export interface SemanticBackend {
  snapshot(): Promise<CorpusSnapshot>;
  status(): BackendStatus;
  dispose(): Promise<void>;
}
```

- [ ] **Step 2: Re-point the Smart Connections corpus index at it**

In `src/lib/obsidian/smart-connections-corpus-index.ts`, delete the local
`export interface CorpusSnapshot { ... }` declaration and add:

```ts
import type { CorpusSnapshot } from './semantic-backend.js';

export type { CorpusSnapshot };
```

Leave everything else in that file untouched — the whole file is deleted in
Task 11; this keeps every intermediate commit compiling.

- [ ] **Step 3: Verify nothing broke**

Run: `npm run typecheck && npm test`
Expected: PASS, unchanged test count.

- [ ] **Step 4: Commit**

```bash
git add src/lib/obsidian/semantic-backend.ts src/lib/obsidian/smart-connections-corpus-index.ts
git commit -m "refactor(semantic): give the backend contract a home of its own"
```

---

## Task 2: One owner for `.neuro-vault/config.json`

Implements design D8.

**Files:**

- Create: `src/lib/obsidian/vault-config.ts`
- Modify: `src/lib/obsidian/vault-scope-config.ts` (built on the new loader)
- Test: create `test/lib/obsidian/vault-config.test.ts`; keep `test/lib/obsidian/vault-scope-config.test.ts` passing unchanged

**Interfaces:**

- Produces:
  - `VAULT_CONFIG_PATH = '.neuro-vault/config.json'`
  - `interface VaultConfigFile { exclusions?: string[]; semantic?: boolean }`
  - `loadVaultConfig(vaultRoot: string, opts?: { readFile?; warn? }): Promise<VaultConfigFile>`
  - `loadVaultScope(vaultRoot: string, opts?: { readFile?; warn?; config?: VaultConfigFile }): Promise<VaultScope>` — same signature as today plus an optional pre-parsed `config`, so the registry parses the file once.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/vault-config.test.ts
import { describe, expect, it, vi } from 'vitest';

import { loadVaultConfig } from '../../../src/lib/obsidian/vault-config.js';

function reader(files: Record<string, string>) {
  return async (p: string) => {
    const hit = Object.entries(files).find(([name]) => p.endsWith(name));
    if (!hit) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return hit[1];
  };
}

describe('loadVaultConfig', () => {
  it('reads semantic: false', async () => {
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"semantic": false}' }),
    });
    expect(config.semantic).toBe(false);
  });

  it('leaves semantic undefined when the key is absent', async () => {
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"exclusions": ["Archive/**"]}' }),
    });
    expect(config.semantic).toBeUndefined();
    expect(config.exclusions).toEqual(['Archive/**']);
  });

  it('warns and ignores a non-boolean semantic value', async () => {
    const warn = vi.fn();
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{"semantic": "no"}' }),
      warn,
    });
    expect(config.semantic).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"semantic"'));
  });

  it('returns an empty config when the file is missing', async () => {
    const config = await loadVaultConfig('/v', { readFile: reader({}) });
    expect(config).toEqual({});
  });

  it('warns once and returns an empty config on invalid JSON', async () => {
    const warn = vi.fn();
    const config = await loadVaultConfig('/v', {
      readFile: reader({ 'config.json': '{oops' }),
      warn,
    });
    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/lib/obsidian/vault-config.test.ts`
Expected: FAIL — cannot resolve `src/lib/obsidian/vault-config.js`.

- [ ] **Step 3: Implement the loader**

Create `src/lib/obsidian/vault-config.ts` holding `VAULT_CONFIG_PATH`, the
`VaultConfigFile` shape, and `loadVaultConfig`. Move the JSON read, the
object-shape check and the `exclusions` validation out of
`vault-scope-config.ts` verbatim — the warning strings must not change, since
`test/lib/obsidian/vault-scope-config.test.ts` asserts them. Add only the
`semantic` branch:

```ts
const semanticRaw = (parsed as { semantic?: unknown }).semantic;
if (semanticRaw !== undefined && typeof semanticRaw !== 'boolean') {
  warn(
    `neuro-vault: "semantic" in ${VAULT_CONFIG_PATH} must be true or false ` +
      `(vault at ${vaultRoot}); treating the vault as semantically enabled`,
  );
}
const semantic = typeof semanticRaw === 'boolean' ? semanticRaw : undefined;
```

- [ ] **Step 4: Rebuild `loadVaultScope` on it**

`vault-scope-config.ts` keeps `SCOPE_CONFIG_PATH` (re-exported from
`VAULT_CONFIG_PATH` so nothing importing it breaks), reads `.gitignore` as it
does today, and takes its exclusions from `opts.config ?? await loadVaultConfig(vaultRoot, opts)`.

- [ ] **Step 5: Run both suites**

Run: `npx vitest run test/lib/obsidian/vault-config.test.ts test/lib/obsidian/vault-scope-config.test.ts test/lib/obsidian/vault-scope-e2e.test.ts`
Expected: PASS — the scope tests unchanged, the new ones green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/obsidian/vault-config.ts src/lib/obsidian/vault-scope-config.ts test/lib/obsidian/vault-config.test.ts
git commit -m "feat(config): one owner for the per-vault config file"
```

---

## Task 3: The process-wide embed queue

Implements design D7.

**Files:**

- Create: `src/modules/semantic/embed-queue.ts`
- Test: create `test/semantic/embed-queue.test.ts`

**Interfaces:**

- Consumes: `EmbeddingProvider` from `src/modules/semantic/types.js` (`{ initialize(): Promise<void>; embed(text: string): Promise<number[]> }`)
- Produces:

  ```ts
  interface QueuedEmbedder {
    initialize(): Promise<void>;
    /** Query lane — jumps ahead of queued indexing work. */
    embedQuery(text: string): Promise<number[]>;
    /** Indexing lane — FIFO behind every pending query. */
    embedIndex(text: string): Promise<number[]>;
    /** `EmbeddingProvider` view for the retrieval path. */
    asProvider(): EmbeddingProvider;
    /** `EmbedFn` view for `reconcileCorpus`. */
    asIndexEmbedFn(): (text: string) => Promise<number[]>;
  }
  function createQueuedEmbedder(provider: EmbeddingProvider): QueuedEmbedder;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/semantic/embed-queue.test.ts
import { describe, expect, it } from 'vitest';

import { createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';

/** A provider whose in-flight embed is released by hand. */
function controllableProvider() {
  const order: string[] = [];
  let release: (() => void) | null = null;
  return {
    order,
    releaseOne(): void {
      const fn = release;
      release = null;
      fn?.();
    },
    provider: {
      initialize: async () => {},
      embed: async (text: string) => {
        order.push(text);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [1];
      },
    },
  };
}

describe('createQueuedEmbedder', () => {
  it('runs one embed at a time', async () => {
    const c = controllableProvider();
    const q = createQueuedEmbedder(c.provider);
    void q.embedIndex('a');
    void q.embedIndex('b');
    await Promise.resolve();
    expect(c.order).toEqual(['a']);
  });

  it('serves a query ahead of queued indexing work', async () => {
    const c = controllableProvider();
    const q = createQueuedEmbedder(c.provider);
    const first = q.embedIndex('index-1');
    void q.embedIndex('index-2');
    void q.embedQuery('query');
    c.releaseOne(); // finish index-1
    await first;
    await Promise.resolve();
    expect(c.order).toEqual(['index-1', 'query']);
  });

  it('a rejected embed does not wedge the queue', async () => {
    const failing = {
      initialize: async () => {},
      embed: async (text: string) => {
        if (text === 'bad') throw new Error('boom');
        return [2];
      },
    };
    const q = createQueuedEmbedder(failing);
    await expect(q.embedIndex('bad')).rejects.toThrow('boom');
    await expect(q.embedIndex('good')).resolves.toEqual([2]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/semantic/embed-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the queue**

Two arrays (`queryLane`, `indexLane`) of `{ text, resolve, reject }`, a
`running` flag, and a `pump()` that always drains `queryLane` first, awaits
`provider.embed`, settles the entry in a `try/finally`, and re-pumps. `finally`
is what keeps a rejection from wedging it. `asProvider()` returns
`{ initialize, embed: embedQuery }`; `asIndexEmbedFn()` returns `embedIndex`
bound.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/semantic/embed-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/embed-queue.ts test/semantic/embed-queue.test.ts
git commit -m "feat(semantic): queue embeddings process-wide, queries first"
```

---

## Task 4: Shards to a snapshot

Implements design D2 (the loading half). Depends on Task 1.

**Files:**

- Create: `src/lib/obsidian/corpus/snapshot.ts`
- Modify: `eval/backends.ts` (its `loadOwn` calls the new function)
- Test: create `test/lib/obsidian/corpus/snapshot.test.ts`

**Interfaces:**

- Consumes: `CorpusStore` (`listShards(): Promise<Map<string, CorpusShard>>`), `decodeVector`, `buildBasenameIndex`
- Produces: `loadCorpusSnapshot(store: CorpusStore): Promise<CorpusSnapshot>`

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/obsidian/corpus/snapshot.test.ts
import { describe, expect, it } from 'vitest';

import { loadCorpusSnapshot } from '../../../../src/lib/obsidian/corpus/snapshot.js';
import { encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';
import type { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';

function shard(
  path: string,
  embedding: string | null,
  blocks: CorpusShard['blocks'] = [],
): CorpusShard {
  return { path, content_hash: 'h', mtime: 1, size: 1, embedding, blocks };
}

function storeWith(shards: CorpusShard[]): CorpusStore {
  return {
    listShards: async () => new Map(shards.map((s) => [s.path, s])),
  } as unknown as CorpusStore;
}

describe('loadCorpusSnapshot', () => {
  it('decodes a shard into a source with its blocks', async () => {
    const snap = await loadCorpusSnapshot(
      storeWith([
        shard('Notes/a.md', encodeVector([0.5, 0.25]), [
          { key: '#Top', heading: 'Top', lines: [1, 4], embedding: encodeVector([0.125, 0]) },
        ]),
      ]),
    );
    const source = snap.sources.get('Notes/a.md');
    expect(source?.embedding).toEqual([0.5, 0.25]);
    expect(source?.blocks[0]).toMatchObject({ key: '#Top', heading: 'Top', lines: [1, 4] });
    expect(source?.blocks[0].embedding).toEqual([0.125, 0]);
  });

  it('skips a note with no note-level vector', async () => {
    const snap = await loadCorpusSnapshot(storeWith([shard('Notes/tiny.md', null)]));
    expect(snap.sources.size).toBe(0);
  });

  it('indexes basenames of the notes it kept', async () => {
    const snap = await loadCorpusSnapshot(storeWith([shard('Notes/a.md', encodeVector([1]))]));
    expect(snap.basenameIndex.resolve('a')).toBe('Notes/a.md');
  });

  it('returns an empty snapshot rather than throwing on an empty corpus', async () => {
    const snap = await loadCorpusSnapshot(storeWith([]));
    expect(snap.sources.size).toBe(0);
    expect(snap.basenameIndex.resolve('a')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/lib/obsidian/corpus/snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

```ts
// src/lib/obsidian/corpus/snapshot.ts
import { buildBasenameIndex } from '../link-resolver.js';
import type { CorpusSnapshot } from '../semantic-backend.js';
import type { SmartSource } from '../smart-connections-types.js';
import type { CorpusStore } from './shard-store.js';
import { decodeVector } from './vector-codec.js';

/**
 * Decodes the whole corpus into the shape the ranking code consumes. A note
 * below the size gate carries no note vector and cannot participate in note
 * ranking, so it contributes no source — same rule the replaced loader applied.
 */
export async function loadCorpusSnapshot(store: CorpusStore): Promise<CorpusSnapshot> {
  const sources = new Map<string, SmartSource>();
  for (const shard of (await store.listShards()).values()) {
    if (shard.embedding === null) continue;
    sources.set(shard.path, {
      path: shard.path,
      embedding: decodeVector(shard.embedding),
      blocks: shard.blocks.map((b) => ({
        key: b.key,
        heading: b.heading,
        lines: b.lines,
        embedding: decodeVector(b.embedding),
      })),
    });
  }
  return { sources, basenameIndex: buildBasenameIndex(sources.keys()) };
}
```

- [ ] **Step 4: Point the eval harness at it**

In `eval/backends.ts`, replace the body of `loadOwn` with a call to
`loadCorpusSnapshot(new CorpusStore(vaultRoot))`, returning `snapshot.sources`
and keeping the existing empty-corpus `BackendError` (message unchanged —
`test/eval/backends.test.ts` asserts it).

- [ ] **Step 5: Run both suites**

Run: `npx vitest run test/lib/obsidian/corpus/snapshot.test.ts test/eval/backends.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/obsidian/corpus/snapshot.ts eval/backends.ts test/lib/obsidian/corpus/snapshot.test.ts
git commit -m "feat(corpus): load a ranking snapshot from the owned shards"
```

---

## Task 5: The per-vault lifecycle

Implements design D2 (invalidation), D3 (startup selection), D4's state source, and the promotion half of the capability spec. Depends on Tasks 1, 3, 4.

**Files:**

- Create: `src/modules/semantic/backend/corpus-backend.ts`
- Test: create `test/semantic/backend/corpus-backend.test.ts`

**Interfaces:**

- Consumes: `SemanticBackend`, `BackendStatus`, `CorpusSnapshot` (Task 1); `loadCorpusSnapshot` (Task 4); `CorpusStore`, `isManifestCompatible`, `reconcileCorpus`, `ReconcileSummary`, and the corpus identity constants `EMBED_VERSION`, `MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS`, `SC_PARITY_STRATEGY`
- Produces:

  ```ts
  interface CorpusBackendDeps {
    vaultRoot: string;
    vaultName: string;
    enabled: boolean; // global --semantic AND per-vault config
    store: CorpusStore;
    loadSnapshot: (store: CorpusStore) => Promise<CorpusSnapshot>;
    reconcile: (opts: {
      onProgress?: (p: { indexed: number; total: number }) => void;
    }) => Promise<ReconcileSummary>;
    warn?: (message: string) => void; // defaults to console.error
  }
  interface CorpusBackend extends SemanticBackend {
    /** Resolves when the current background pass settles. Tests only. */
    whenSettled(): Promise<void>;
    /** Requests another reconcile; coalesces while one is running. */
    requestReconcile(): void;
  }
  function createCorpusBackend(deps: CorpusBackendDeps): CorpusBackend;
  ```

  Note `reconcile` is pre-bound per vault — the backend never assembles
  scan/stat/read/embed itself; Task 8 wires the real one.

- [ ] **Step 1: Write the failing tests**

```ts
// test/semantic/backend/corpus-backend.test.ts
import { describe, expect, it, vi } from 'vitest';

import { createCorpusBackend } from '../../../src/modules/semantic/backend/corpus-backend.js';
import { buildBasenameIndex } from '../../../src/lib/obsidian/link-resolver.js';
import type { CorpusSnapshot } from '../../../src/lib/obsidian/semantic-backend.js';
import type { CorpusStore } from '../../../src/lib/obsidian/corpus/shard-store.js';
import type { ReconcileSummary } from '../../../src/lib/obsidian/corpus/reconcile.js';

const EMPTY: CorpusSnapshot = { sources: new Map(), basenameIndex: buildBasenameIndex([]) };

function snapshotWith(paths: string[]): CorpusSnapshot {
  return {
    sources: new Map(paths.map((p) => [p, { path: p, embedding: [1], blocks: [] }])),
    basenameIndex: buildBasenameIndex(paths),
  };
}

function summary(over: Partial<ReconcileSummary> = {}): ReconcileSummary {
  return { total: 1, embedded: 0, reused: 1, renamed: 0, deleted: 0, failed: 0, ...over };
}

/** A store whose manifest and shard count are set per test. */
function fakeStore(opts: { compatible: boolean; shards: number }): CorpusStore {
  return {
    readManifest: async () =>
      opts.compatible
        ? {
            embed_version: 1,
            model_key: 'bge-micro-v2',
            model_id: 'TaylorAI/bge-micro-v2',
            dims: 384,
            strategy: 'sc-parity-v1',
            created: 'now',
          }
        : {
            embed_version: 99,
            model_key: 'other',
            model_id: 'other',
            dims: 1,
            strategy: 'x',
            created: 'now',
          },
    listShards: async () =>
      new Map(Array.from({ length: opts.shards }, (_, i) => [`n${i}.md`, {}])) as never,
  } as unknown as CorpusStore;
}

describe('createCorpusBackend', () => {
  it('reports disabled and does no work when the vault opted out', async () => {
    const reconcile = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: false,
      store: fakeStore({ compatible: true, shards: 3 }),
      loadSnapshot: async () => EMPTY,
      reconcile,
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await backend.snapshot()).sources.size).toBe(0);
  });

  it('serves a compatible corpus immediately and reconciles behind it', async () => {
    const reconcile = vi.fn(async () => summary());
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 2 }),
      loadSnapshot: async () => snapshotWith(['a.md', 'b.md']),
      reconcile,
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reports indexing with progress before the first index lands', async () => {
    let emit: ((p: { indexed: number; total: number }) => void) | undefined;
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async ({ onProgress }) => {
        emit = onProgress;
        emit?.({ indexed: 0, total: 840 });
        emit?.({ indexed: 120, total: 840 });
        return summary({ total: 840, embedded: 840 });
      },
    });
    expect(backend.status()).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
  });

  it('promotes the finished index without a restart', async () => {
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async () => summary({ embedded: 1 }),
    });
    expect((await backend.snapshot()).sources.size).toBe(0);
    await backend.whenSettled();
    expect((await backend.snapshot()).sources.size).toBe(1);
  });

  it('does not rebuild the snapshot when nothing changed', async () => {
    const loadSnapshot = vi.fn(async () => snapshotWith(['a.md']));
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot,
      reconcile: async () => summary(),
    });
    await backend.whenSettled();
    expect(loadSnapshot).toHaveBeenCalledTimes(1); // startup load only
  });

  it('reports unavailable with a reason when a pass throws', async () => {
    const warn = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => EMPTY,
      reconcile: async () => {
        throw new Error('EACCES');
      },
      warn,
    });
    await backend.whenSettled();
    expect(backend.status()).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('EACCES'),
    });
    expect(warn).toHaveBeenCalled();
  });

  it('recovers from a failed pass without a restart', async () => {
    let attempt = 0;
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('EACCES');
        return summary({ embedded: 1 });
      },
      warn: vi.fn(),
    });
    await backend.whenSettled();
    expect(backend.status().state).toBe('unavailable');
    backend.requestReconcile();
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(1);
  });

  it('coalesces reconcile requests arriving during a pass', async () => {
    let running: (() => void) | null = null;
    const reconcile = vi.fn(
      () =>
        new Promise<ReconcileSummary>((resolve) => {
          running = () => resolve(summary());
        }),
    );
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot: async () => EMPTY,
      reconcile,
    });
    backend.requestReconcile();
    backend.requestReconcile();
    running?.(); // finish the startup pass
    await backend.whenSettled();
    expect(reconcile.mock.calls.length).toBeLessThanOrEqual(2); // startup + one coalesced pass
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/semantic/backend/corpus-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lifecycle**

Shape it as a closure over mutable state — `snapshot`, `status`, `running`,
`dirty`, `settled` — with:

```ts
const EXPECTED_IDENTITY = {
  embed_version: EMBED_VERSION,
  model_key: MODEL_KEY,
  model_id: MODEL_ID,
  dims: MODEL_DIMS,
  strategy: SC_PARITY_STRATEGY,
};
```

Startup (`enabled === false` → `status = { state: 'disabled' }`, return early):
read the manifest and the shard map; if
`isManifestCompatible(manifest, EXPECTED_IDENTITY, shards.size > 0)` and
`shards.size > 0`, `loadSnapshot` and set `ready`; otherwise set
`{ state: 'indexing', indexed: 0, total: 0 }`. Either way start one background
pass. A pass: run `reconcile` with `onProgress` writing the counters while the
state is `indexing`; on success, reload the snapshot only when
`embedded + renamed + deleted > 0` and assign it in one statement, then set
`ready`; on throw, set `{ state: 'unavailable', reason }` and `warn` to stderr —
without clearing the snapshot, and without latching: the next pass overwrites
the state, so a recovered vault reports `ready` again.
After a pass, if `dirty` was set, clear it and run again. `dispose()` marks the
backend disposed so no further pass is scheduled. Kick the initial pass with
`void run()` — never awaited by the caller.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/semantic/backend/corpus-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/semantic/backend/corpus-backend.ts test/semantic/backend/corpus-backend.test.ts
git commit -m "feat(semantic): a per-vault corpus backend with live promotion"
```

---

## Task 6: The debounced watcher

Implements design D6. Depends on Task 5.

**Files:**

- Create: `src/modules/semantic/backend/vault-watcher.ts`
- Modify: `package.json` (add `chokidar`), `package-lock.json`
- Test: create `test/semantic/backend/vault-watcher.test.ts`

**Interfaces:**

- Produces:

  ```ts
  interface WatcherHandle {
    close(): Promise<void>;
  }
  interface WatcherFactory {
    (opts: {
      vaultRoot: string;
      onChange: () => void;
      onError: (err: unknown) => void;
    }): WatcherHandle;
  }
  interface VaultWatcherDeps {
    vaultRoot: string;
    vaultName: string;
    onQuiet: () => void; // wired to backend.requestReconcile
    debounceMs?: number; // default DEBOUNCE_MS
    createWatcher?: WatcherFactory; // default: chokidar
    warn?: (message: string) => void;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }
  function startVaultWatcher(deps: VaultWatcherDeps): WatcherHandle;
  const DEBOUNCE_MS = 10_000;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/semantic/backend/vault-watcher.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startVaultWatcher } from '../../../src/modules/semantic/backend/vault-watcher.js';

function fakeWatcherFactory() {
  const handles: Array<{ fire: () => void; fail: (e: unknown) => void; closed: boolean }> = [];
  const factory = ({
    onChange,
    onError,
  }: {
    onChange: () => void;
    onError: (e: unknown) => void;
  }) => {
    const handle = {
      fire: onChange,
      fail: onError,
      closed: false,
      close: async () => {
        handle.closed = true;
      },
    };
    handles.push(handle);
    return handle;
  };
  return { factory, handles };
}

describe('startVaultWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onQuiet once after a burst settles', () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      createWatcher: factory,
      debounceMs: 100,
    });
    handles[0].fire();
    vi.advanceTimersByTime(50);
    handles[0].fire();
    vi.advanceTimersByTime(50);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('warns and stays quiet when the watcher cannot start', () => {
    const warn = vi.fn();
    const onQuiet = vi.fn();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      warn,
      createWatcher: () => {
        throw new Error('EMFILE');
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMFILE'));
    vi.advanceTimersByTime(60_000);
    expect(onQuiet).not.toHaveBeenCalled();
  });

  it('warns on a later watcher error without throwing', () => {
    const warn = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet: vi.fn(),
      warn,
      createWatcher: factory,
    });
    handles[0].fail(new Error('ENOSPC'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });

  it('close cancels a pending debounce and closes the watcher', async () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    const handle = startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      createWatcher: factory,
      debounceMs: 100,
    });
    handles[0].fire();
    await handle.close();
    vi.advanceTimersByTime(1_000);
    expect(onQuiet).not.toHaveBeenCalled();
    expect(handles[0].closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/semantic/backend/vault-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the dependency**

Run: `npm install chokidar@^4`
Then confirm it landed in `dependencies` (not `devDependencies`) in `package.json`.

- [ ] **Step 4: Implement the watcher**

The default `createWatcher` builds:

```ts
chokidar.watch(vaultRoot, {
  ignored: (p: string) => /(^|[\\/])\../.test(p) || p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 200 },
});
```

and forwards `add`/`change`/`unlink` events for `.md` paths to `onChange`, and
`error` to `onError`. The dot-path rule is what stops the server's own writes
under `.neuro-vault/corpus/` from feeding the watcher back into itself (design
D6). `startVaultWatcher` wraps the factory in `try/catch` — a throw is a warned
degradation, and it returns a no-op handle. Every event resets a single timer;
the timer's callback calls `onQuiet()`. `close()` clears the timer, sets a
closed flag so a late event schedules nothing, and awaits the handle's close.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run test/semantic/backend/vault-watcher.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/semantic/backend/vault-watcher.ts test/semantic/backend/vault-watcher.test.ts
git commit -m "feat(semantic): watch each vault and reconcile after a quiet period"
```

---

## Task 7: Registry entry shape and its call sites

Implements design D9. This task must land as one unit — the entry-shape change breaks its call sites in the same typecheck. Depends on Tasks 1, 2.

**Files:**

- Modify: `src/lib/vault-registry.ts`, `src/lib/resolve-vault.ts`, `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/tools/get-similar-notes.ts`, `src/modules/semantic/tools/find-duplicates.ts`
- Test: `test/lib/vault-registry.test.ts`, `test/lib/resolve-vault.test.ts`, `test/semantic/tools/_helpers.ts`, `test/semantic/tools/*.test.ts`

**Interfaces:**

- Produces, on `IVaultEntry`: `backend?: SemanticBackend` — replacing `corpus`, `semanticAvailable`, `semanticUnavailableReason`. Absent only when the semantic module is globally off.
- Produces, on `IVaultEntryDeps`:
  ```ts
  vaultConfigFactory: (opts: { vaultRoot: string }) => Promise<VaultConfigFile>;
  scopeFactory: (opts: { vaultRoot: string; config: VaultConfigFile }) => Promise<VaultScope>;
  semanticBackendFactory: (opts: {
    vaultRoot: string;
    vaultName: string;
    reader: VaultReader;
    enabled: boolean;
  }) => SemanticBackend;
  ```
  `corpusFactory` is gone.
- Produces: `resolveSemanticVault(input, registry, opts): IVaultEntry & { backend: SemanticBackend }` — unchanged name, new return type, new error branches (Task 9 supplies the codes; this task keeps today's `SEMANTIC_INDEX_NOT_FOUND` behaviour for any non-`ready` state so the two tasks stay independently green).

- [ ] **Step 1: Update the registry test first**

In `test/lib/vault-registry.test.ts`, replace `corpusFactory` in `fakeDeps()`
with:

```ts
vaultConfigFactory: async () => ({}),
semanticBackendFactory: () => ({
  snapshot: async () => ({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
  status: () => ({ state: 'ready' as const }),
  dispose: async () => {},
}),
```

and add:

```ts
it('gives every vault a backend when the module is enabled', async () => {
  const registry = await VaultRegistry.create(
    { vaults: [vault('a', '/v/a')], semanticEnabled: true, modelKey: 'm' },
    fakeDeps(),
  );
  expect(registry.list()[0].backend?.status()).toEqual({ state: 'ready' });
});

it('leaves the backend absent when semantic is globally off', async () => {
  const registry = await VaultRegistry.create(
    { vaults: [vault('a', '/v/a')], semanticEnabled: false, modelKey: 'm' },
    fakeDeps(),
  );
  expect(registry.list()[0].backend).toBeUndefined();
});

it('passes the per-vault semantic flag to the backend factory', async () => {
  const deps = fakeDeps();
  const seen: boolean[] = [];
  deps.vaultConfigFactory = async () => ({ semantic: false });
  deps.semanticBackendFactory = (opts) => {
    seen.push(opts.enabled);
    return {
      snapshot: async () => ({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
      status: () => ({ state: 'disabled' as const }),
      dispose: async () => {},
    };
  };
  await VaultRegistry.create(
    { vaults: [vault('a', '/v/a')], semanticEnabled: true, modelKey: 'm' },
    deps,
  );
  expect(seen).toEqual([false]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: FAIL — `semanticBackendFactory` is not a dependency and `backend` is not on the entry.

- [ ] **Step 3: Change the entry and the registry**

Drop `corpus`, `semanticAvailable`, `semanticUnavailableReason` and the whole
`try/catch` snapshot probe from `VaultRegistry.create`. Per vault: load the
config once, pass it to `scopeFactory`, and when `config.semanticEnabled` (the
global flag) is true call `semanticBackendFactory({ vaultRoot, vaultName, reader, enabled: vaultConfig.semantic !== false })`.
Startup does not await any backend work.

- [ ] **Step 4: Follow the type through every call site**

- `resolve-vault.ts`: `resolveSemanticVault` checks `entry.backend` and
  `entry.backend.status().state === 'ready'`; anything else throws
  `SEMANTIC_INDEX_NOT_FOUND` as today (Task 9 splits the states out).
- `search-notes.ts`: the degradation branch becomes
  `if (channel === 'lexical' || entry.backend === undefined || entry.backend.status().state !== 'ready')`,
  and the snapshot read becomes `await entry.backend.snapshot()`.
- `get-similar-notes.ts` and `find-duplicates.ts`: `entry.corpus` →
  `entry.backend`.
- `test/semantic/tools/_helpers.ts` and the tool tests: every fake entry gets a
  `backend` with `status: () => ({ state: 'ready' })` instead of `corpus` +
  `semanticAvailable`.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, with the three new registry tests added to the count.

- [ ] **Step 6: Commit**

```bash
git add src/lib/vault-registry.ts src/lib/resolve-vault.ts src/modules/semantic/tools test/lib test/semantic/tools
git commit -m "refactor(vault): entries carry a semantic backend, not a corpus and two flags"
```

---

## Task 8: Wire the server to the own corpus

Implements design D3's production path, D7's sharing, D10's shutdown, and D13. Depends on Tasks 3, 5, 6, 7.

**Files:**

- Create: `src/modules/semantic/backend/index.ts` (the production factory)
- Modify: `src/server.ts`
- Test: `test/server-modules.test.ts`, create `test/semantic/backend/factory.test.ts`

**Interfaces:**

- Produces:

  ```ts
  function createOwnCorpusBackendFactory(deps: {
    embedder: QueuedEmbedder;
    /** Injected by tests; production defaults to the chokidar-backed one. */
    createWatcher?: WatcherFactory;
    warn?: (message: string) => void;
  }): (opts: {
    vaultRoot: string;
    vaultName: string;
    reader: VaultReader;
    enabled: boolean;
  }) => SemanticBackend;
  ```

  It assembles `CorpusStore(vaultRoot)`, the `reconcileCorpus` deps (`scan` from
  `reader.scan()`, `stat`/`readNote` over `node:fs/promises`, `embed` from
  `embedder.asIndexEmbedFn()`), creates the backend (Task 5), starts the watcher
  (Task 6) wired to `backend.requestReconcile`, and returns a `SemanticBackend`
  whose `dispose()` closes the watcher and then the backend.
  The `scan`/`stat`/`readNote` trio is the same one `src/cli-index.ts` builds;
  extract it into a shared helper rather than writing it twice — the two must
  not drift about what a note's `mtime` and `size` are.

- [ ] **Step 1: Write the failing factory test**

```ts
// test/semantic/backend/factory.test.ts
import { describe, expect, it, vi } from 'vitest';

import { createOwnCorpusBackendFactory } from '../../../src/modules/semantic/backend/index.js';

describe('createOwnCorpusBackendFactory', () => {
  it('does not start a watcher for a disabled vault', () => {
    const createWatcher = vi.fn();
    const factory = createOwnCorpusBackendFactory({
      embedder: { asIndexEmbedFn: () => async () => [1] } as never,
      createWatcher,
    });
    const backend = factory({
      vaultRoot: '/v',
      vaultName: 'v',
      reader: { scan: async () => [] } as never,
      enabled: false,
    });
    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(createWatcher).not.toHaveBeenCalled();
  });

  it('closes the watcher on dispose', async () => {
    const close = vi.fn(async () => {});
    const factory = createOwnCorpusBackendFactory({
      embedder: { asIndexEmbedFn: () => async () => [1] } as never,
      createWatcher: () => ({ close }),
    });
    const backend = factory({
      vaultRoot: '/v',
      vaultName: 'v',
      reader: { scan: async () => [] } as never,
      enabled: true,
    });
    await backend.dispose();
    expect(close).toHaveBeenCalled();
  });
});
```

(The factory takes `createWatcher` as an optional injected dependency for
exactly this reason.)

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/semantic/backend/factory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory and share the reconcile deps with the CLI**

Extract the `scan`/`stat`/`readNote` assembly out of `reconcileOne` in
`src/cli-index.ts` into an exported helper (e.g.
`buildReconcileFsDeps({ vaultRoot, reader })` in
`src/lib/obsidian/corpus/fs-deps.ts`), and have both `cli-index.ts` and the new
factory call it.

- [ ] **Step 4: Wire `server.ts`**

- Build one `EmbeddingService` and wrap it: `const embedder = createQueuedEmbedder(new EmbeddingService({ modelId }))`.
- `buildDefaultVaultEntryDeps` loses `corpusFactory` and gains
  `vaultConfigFactory: ({ vaultRoot }) => loadVaultConfig(vaultRoot)`,
  `scopeFactory: ({ vaultRoot, config }) => loadVaultScope(vaultRoot, { config })`,
  and `semanticBackendFactory: createOwnCorpusBackendFactory({ embedder })`.
  Delete the `createSmartConnectionsCorpusIndex` import; leave the file itself
  alone.
- Pass `embedder.asProvider()` into `createSemanticModule` so the retrieval path
  uses the query lane (`deps.semantic.embeddingServiceFactory`).
- After `await server.connect(transport)`, register disposal:

```ts
const dispose = async (): Promise<void> => {
  await Promise.all(registry.list().map((entry) => entry.backend?.dispose() ?? Promise.resolve()));
};
transport.onclose = () => void dispose();
return dispose;
```

and change `startNeuroVaultServer`'s return type to `Promise<() => Promise<void>>`.
`src/cli.ts` ignores the returned disposer.

- [ ] **Step 5: Assert shutdown in the server test**

Add to `test/server-modules.test.ts`, alongside the existing
`createFakeServer()` helper:

```ts
it('disposes every vault backend when the transport closes', async () => {
  const vaultPath = await createTempVaultPath();
  const server = createFakeServer();
  const dispose = vi.fn(async () => {});
  const transport = {} as { onclose?: () => void };

  await startNeuroVaultServer(
    {
      vaults: [
        {
          name: path.basename(vaultPath),
          path: vaultPath,
          smartEnvPath: path.join(vaultPath, '.smart-env', 'multi'),
        },
      ],
      semantic: { enabled: true, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
    },
    {
      serverFactory: () => server as never,
      transportFactory: () => transport as never,
      vaultEntryDeps: {
        semanticBackendFactory: () => ({
          snapshot: async () => ({ sources: new Map(), basenameIndex: buildBasenameIndex([]) }),
          status: () => ({ state: 'ready' as const }),
          dispose,
        }),
      },
    },
  );

  transport.onclose?.();
  await new Promise((resolve) => setImmediate(resolve));
  expect(dispose).toHaveBeenCalledTimes(1);
});
```

The two existing `SEMANTIC_INDEX_NOT_FOUND` cases in that file describe a
missing and an empty **plugin** corpus; rewrite them against a
`semanticBackendFactory` returning `{ state: 'unavailable' }` so they keep
testing the same contract through the new seam.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/cli.ts src/cli-index.ts src/lib/obsidian/corpus/fs-deps.ts src/modules/semantic/backend/index.ts test
git commit -m "feat(server): serve semantic search from the vault's own corpus"
```

---

## Task 9: The error codes

Implements design D4 and the capability's error requirement. Depends on Task 7.

**Files:**

- Modify: `src/lib/resolve-vault.ts`, `src/modules/semantic/types.ts` (`ToolHandlerErrorCode` union)
- Test: `test/lib/resolve-vault.test.ts`, `test/semantic/tools/find-duplicates.test.ts`, `test/semantic/tools/get-similar-notes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/resolve-vault.test.ts — added cases
it('reports a building index with its progress', () => {
  const registry = registryWithBackend({ state: 'indexing', indexed: 12, total: 840 });
  try {
    resolveSemanticVault({}, registry, { tool: 'find_duplicates' });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolHandlerError);
    const e = error as ToolHandlerError;
    expect(e.code).toBe('SEMANTIC_INDEX_BUILDING');
    expect(e.details).toMatchObject({ vault: 'v', indexed: 12, total: 840 });
  }
});

it('names the config key for a disabled vault', () => {
  const registry = registryWithBackend({ state: 'disabled' });
  const error = catchError(() => resolveSemanticVault({}, registry, { tool: 'get_similar_notes' }));
  expect(error.code).toBe('SEMANTIC_DISABLED');
  expect(`${error.message} ${JSON.stringify(error.details)}`).toContain('.neuro-vault/config.json');
});

it('points an unavailable corpus at the index command and never at a plugin', () => {
  const registry = registryWithBackend({ state: 'unavailable', reason: 'EACCES' });
  const error = catchError(() => resolveSemanticVault({}, registry, { tool: 'find_duplicates' }));
  expect(error.code).toBe('SEMANTIC_INDEX_NOT_FOUND');
  const text = `${error.message} ${JSON.stringify(error.details)}`;
  expect(text).toContain('EACCES');
  expect(text).toContain('index');
  expect(text).not.toMatch(/Obsidian|Smart Connections/i);
});
```

Write `registryWithBackend(status)` and `catchError(fn)` as local helpers in
that test file.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/lib/resolve-vault.test.ts`
Expected: FAIL — every non-ready state currently yields `SEMANTIC_INDEX_NOT_FOUND`.

- [ ] **Step 3: Implement the branches**

Add `'SEMANTIC_INDEX_BUILDING' | 'SEMANTIC_DISABLED'` to `ToolHandlerErrorCode`
and switch on `entry.backend.status().state`:

```ts
switch (status.state) {
  case 'ready':
    return entry as IVaultEntry & { backend: SemanticBackend };
  case 'indexing':
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_BUILDING',
      `Semantic index for vault "${entry.name}" is still building`,
      { details: { vault: entry.name, indexed: status.indexed ?? 0, total: status.total ?? 0 } },
    );
  case 'disabled':
    throw new ToolHandlerError(
      'SEMANTIC_DISABLED',
      `Semantic search is disabled for vault "${entry.name}"`,
      {
        details: {
          vault: entry.name,
          hint: 'set "semantic": true in the vault\'s .neuro-vault/config.json',
        },
      },
    );
  default:
    throw new ToolHandlerError(
      'SEMANTIC_INDEX_NOT_FOUND',
      `Semantic index for vault "${entry.name}" is unavailable: ${status.reason ?? 'unknown reason'}`,
      {
        details: {
          vault: entry.name,
          hint: `build it with: neuro-vault-mcp index --vault ${entry.path}`,
        },
      },
    );
}
```

An absent `entry.backend` takes the `unavailable` branch with the reason
"the semantic module is disabled for this server".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/lib/resolve-vault.test.ts test/semantic/tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/resolve-vault.ts src/modules/semantic/types.ts test/lib/resolve-vault.test.ts test/semantic/tools
git commit -m "feat(semantic): tell the caller why the index cannot answer yet"
```

---

## Task 10: `semantic_status` on every `search_notes` payload

Implements design D5. Depends on Task 7.

**Files:**

- Modify: `src/modules/semantic/tools/search-notes.ts`
- Test: `test/semantic/tools/search-notes.test.ts`, `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**

- Produces, on `SearchNotesOutput`:

  ```ts
  semantic_status: { state: BackendState; indexed?: number; total?: number };
  ```

  Required, not optional — the type is what forces every return path to fill it.

- [ ] **Step 1: Write the failing tests**

```ts
// test/semantic/tools/search-notes.test.ts — added cases
it('reports a ready backend with no counters', async () => {
  const result = await runSearch({ backendStatus: { state: 'ready' }, input: { query: 'x' } });
  expect(result.semantic_status).toEqual({ state: 'ready' });
});

it('reports progress while indexing and still returns lexical matches', async () => {
  const result = await runSearch({
    backendStatus: { state: 'indexing', indexed: 3, total: 9 },
    input: { query: 'пошук' },
  });
  expect(result.semantic_status).toEqual({ state: 'indexing', indexed: 3, total: 9 });
  expect(result.matches.every((m) => m.found_in.every((f) => f.startsWith('lexical:')))).toBe(true);
});

it('reports the state in lexical mode without reading a snapshot', async () => {
  const snapshot = vi.fn();
  const result = await runSearch({
    backendStatus: { state: 'ready' },
    snapshot,
    input: { query: 'x', mode: 'lexical' },
  });
  expect(result.semantic_status).toEqual({ state: 'ready' });
  expect(snapshot).not.toHaveBeenCalled();
});

it('reports the state on the empty-filter early return', async () => {
  const result = await runSearch({
    backendStatus: { state: 'disabled' },
    allowed: new Set<string>(),
    input: { query: 'x', filter: { path_prefix: 'Nope/' } },
  });
  expect(result.matches).toEqual([]);
  expect(result.semantic_status).toEqual({ state: 'disabled' });
});
```

`runSearch` is a thin wrapper over the existing helpers in
`test/semantic/tools/_helpers.ts`, extended to take a `backendStatus`.

Add to `test/semantic/tools/search-notes-hybrid.test.ts` a fan-out case
asserting each per-vault entry of the envelope carries its own
`semantic_status`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/semantic/tools/search-notes.test.ts`
Expected: FAIL — `semantic_status` is undefined.

- [ ] **Step 3: Implement it**

Add the required field to `SearchNotesOutput`, read
`const semantic_status = toStatusField(entry.backend?.status())` once at the top
of `runSearchForEntry`, and include it in all four return paths (empty-filter
early return, lexical/degraded return, the semantic success path, and any error
path that returns rather than throws). `toStatusField` maps an absent backend to
`{ state: 'unavailable' }` and strips `reason` — the reason travels on errors,
not on search results (design D5).

- [ ] **Step 4: Cover the delta spec's staleness scenario**

`specs/corpus-staleness-filtering/spec.md` adds "a note deleted inside the
debounce window is still filtered". Add it against the own backend:

```ts
it('drops a corpus path whose note is gone before the next reconcile', async () => {
  const result = await runSearch({
    backendStatus: { state: 'ready' },
    snapshotPaths: ['Notes/gone.md', 'Notes/here.md'],
    existingPaths: ['Notes/here.md'],
    input: { query: 'x' },
  });
  expect(result.matches.map((m) => m.path)).not.toContain('Notes/gone.md');
});
```

- [ ] **Step 5: Update the tool's description**

The RESPONSE SHAPE section of `search_notes`'s description must name
`semantic_status` and its four states — the description is a delivery channel
(ADR-0010), so an unlisted field is a documentation defect.

- [ ] **Step 6: Run the suites**

Run: `npx vitest run test/semantic && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/semantic/tools/search-notes.ts test/semantic/tools
git commit -m "feat(search): report the vault's semantic index state on every response"
```

---

## Task 11: Remove Smart Connections

Implements design D13 and tasks 5.1–5.3. Depends on Tasks 7–10 — the server must already serve from the own corpus before its predecessor is deleted. The gate that used to defer this is closed: #87 established parity on every golden entry the plugin corpus could serve, and the plugin's storage migration put the rest permanently out of reach.

**Files:**

- Delete: `src/lib/obsidian/smart-connections-loader.ts`, `src/lib/obsidian/smart-connections-corpus-index.ts`, `src/lib/obsidian/smart-connections-types.ts`, `test/lib/obsidian/smart-connections-loader.test.ts`, `test/lib/obsidian/smart-connections-corpus-index.test.ts`
- Modify: `src/lib/obsidian/index.ts` (barrel exports), `src/types.ts`, `src/config.ts`, `eval/backends.ts`, `eval/run.ts`, `eval/report.ts`, `eval/README.md`, `test/config.test.ts`, `test/eval/*`, every fixture setting `smartEnvPath`

**Interfaces:**

- Produces: `SmartSource` and `SmartBlock` re-homed to `src/lib/obsidian/corpus/types.ts` — the corpus is what produces them now. Every importer updates to the new path; the names and shapes do not change, so no ranking code is touched.

- [ ] **Step 1: Re-home the vector types**

Move the `SmartSource` / `SmartBlock` declarations verbatim into
`src/lib/obsidian/corpus/types.ts`, then run:

```bash
rg -l "smart-connections-types" src/ eval/ test/
```

and repoint every hit at `corpus/types.js`. Run `npm run typecheck` — it is the
completeness check for this step.

- [ ] **Step 2: Delete the loader, the corpus index and their tests**

```bash
git rm src/lib/obsidian/smart-connections-loader.ts        src/lib/obsidian/smart-connections-corpus-index.ts        src/lib/obsidian/smart-connections-types.ts        test/lib/obsidian/smart-connections-loader.test.ts        test/lib/obsidian/smart-connections-corpus-index.test.ts
```

Remove their re-exports from `src/lib/obsidian/index.ts`.

- [ ] **Step 3: Drop `smartEnvPath`**

Remove the field from `IVaultConfig` in `src/types.ts` and its assignment in
`buildVaultConfig` (`src/config.ts`), then let the typecheck find every fixture
that still sets it (`test/config.test.ts`, `test/server-modules.test.ts`,
`test/lib/vault-registry.test.ts`, the eval tests). Delete the assertions in
`test/config.test.ts` that pin the `.smart-env/multi` path.

- [ ] **Step 4: Write the failing harness test**

```ts
// test/eval/run.test.ts — added case
it('rejects the retired backend axis', async () => {
  await expect(runEval(['--vault', vaultPath, '--backend', 'sc'])).rejects.toThrow(/backend/i);
});
```

Adapt the invocation to the harness's existing test helper. Delete the tests
that exercised `--backend sc`.

- [ ] **Step 5: Collapse the harness to one corpus**

`eval/backends.ts` keeps only the own-corpus loader (`loadCorpusSnapshot` from
Task 4) and its `BackendError`; `loadSc`, `SC_REMEDY` and the `BackendId` type
go. `eval/run.ts` drops the `--backend` option so yargs' `.strict()` rejects it,
and `eval/report.ts` stops recording the `backend` field. Update `eval/README.md`
so it documents one axis.

- [ ] **Step 6: Prove nothing references the plugin any more**

```bash
rg -i "smart.?connections|smart-env" src/ eval/ test/
```

Expected: no hits at all.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: PASS, with the deleted suites gone from the count and the new harness
case added.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(semantic)!: remove Smart Connections"
```

The `!` is deliberate: `smartEnvPath` leaves the config contract.

---

## Task 12: ADR-0014 and the architecture docs

Implements design D12 and tasks 6.1–6.2. Depends on Tasks 8–11 (behaviour settled, predecessor removed).

**Files:**

- Create: `docs/adr/0014-background-corpus-freshness.md`, `docs/architecture/semantic-backend.md`
- Modify: `docs/adr/INDEX.md`, `docs/architecture/README.md`, `docs/architecture/own-corpus.md`, `docs/architecture/vault-registry.md`, `docs/architecture/mcp-server-shape.md`, `openspec/config.yaml`

- [ ] **Step 1: Write ADR-0014**

Follow `docs/adr/0000-template.md`. Context: ADR-0013 gave the server a corpus
but said nothing about keeping it fresh; the alternative to background freshness
is a stale corpus or a blocking startup. Decision: in-process watcher per vault,
~10 s debounce, whole-vault reconcile, degradation to reconcile-on-start,
`chokidar` as a runtime dependency (optional native dep with a JS fallback, so
`npx` distribution is unaffected). Consequences: the "no background processes,
no watchers" half of the README claim is retired — no database and no external
process remain true; the process now owns handles it must release at shutdown.
Alternatives: `fs.watch`, per-call staleness checks, write-through from the
write tools, polling. Add the row to `docs/adr/INDEX.md`.

The same ADR carries the removal's evidence, because #88 asked for it and there
is no separate change to hold it: the parity tables from #87 (own vs sc on the
20 measurable golden entries — hit@3 identical, MRR within noise, p@3 favouring
own) and the four-week failure timeline (an Obsidian release removed a private
API the plugin called; the plugin then migrated its storage layout — both
silent, both caught only by external measurement).

- [ ] **Step 2: Write `docs/architecture/semantic-backend.md`**

One concept, one file: the `SemanticBackend` contract; the four states and who
reads them (`search_notes`'s `semantic_status`, the three error codes, the
startup rule); the startup decision table; live promotion; the watcher and the
debounce; the shared embed queue with its query lane; disposal at transport
close. Link out to `own-corpus.md` for the corpus mechanism itself rather than
restating it. Register the file in `docs/architecture/README.md`.

- [ ] **Step 3: Update the neighbouring docs**

- `own-corpus.md`: add a short "who keeps it fresh" pointer to the new file.
- `vault-registry.md`: the entry now carries `backend`, not `corpus` +
  `semanticAvailable` + `semanticUnavailableReason`; per-vault failures surface
  through `status()`.
- `mcp-server-shape.md`: the server now owns background work and disposes it
  when the transport closes.
- `openspec/config.yaml`: rewrite the invariant line that still says
  "Semantic search consumes a read-only Smart Connections corpus; the server
  never writes embeddings (ADR-0006)" so a fresh session is not briefed on a
  superseded rule; cite ADR-0013 and ADR-0014.

- [ ] **Step 4: Verify every claim you wrote**

For each "the code does X" sentence, grep the symbol before committing —
`rg "requestReconcile|asIndexEmbedFn|DEBOUNCE_MS" src/`. A doc sentence that
names a function that does not exist is the defect this step exists to catch.

- [ ] **Step 5: Commit**

```bash
git add docs openspec/config.yaml
git commit -m "docs(adr): record background corpus freshness (ADR-0014)"
```

---

## Task 13: README and the guide sweep

Implements task 6.3. Depends on Task 12.

**Files:**

- Modify: `README.md`, `docs/guide/configuration.md`, `docs/guide/finding-notes.md`, `docs/guide/installation.md`, `docs/guide/routing.md` (as the sweep finds), `package.json` `description`/`keywords` if they still sell the plugin dependency

- [ ] **Step 1: Find every false claim**

Run:

```bash
rg -n -i "smart.connections|smart-env|no watchers|no background processes|zero infrastructure" README.md docs/ package.json
```

Expected hits to fix: the "Hybrid search" bullet, the "Zero infrastructure"
bullet, the "Powered by" table row, the "How it works" paragraph, and the
multi-vault bullet naming `SEMANTIC_INDEX_NOT_FOUND` for a missing
`.smart-env/multi/`. Also delete `docs/architecture/smart-connections-corpus.md`
and its row in `docs/architecture/README.md`. The one hit to leave: ADR-0006,
which stays as history — update its `**Superseded in part by**` note to a full
supersession by ADR-0013 and ADR-0014, and change its `docs/adr/INDEX.md` status
cell from `Accepted` to `Superseded by 0013, 0014`, following the ADR-0007 row's
precedent.

- [ ] **Step 2: Rewrite them**

- Semantic leg: embeddings the server builds itself from the vault's notes, no
  plugin and no API key; first run indexes in the background.
- Zero infrastructure: "no database, no external processes, no API keys" —
  and say plainly that the server keeps its index fresh with an in-process
  watcher.
- Multi-vault bullet: a vault whose index is still building contributes lexical
  matches to `search_notes` and reports `semantic_status`; the embeddings-only
  tools return `SEMANTIC_INDEX_BUILDING`, `SEMANTIC_DISABLED` or
  `SEMANTIC_INDEX_NOT_FOUND` as appropriate.

- [ ] **Step 3: Document the new surfaces in the guide**

- `configuration.md`: the `"semantic": false` key in `.neuro-vault/config.json`,
  what it turns off, and that `--no-semantic` outranks it.
- `finding-notes.md`: `semantic_status` and its four states, plus the two new
  error codes and what a client should do about each.
- `installation.md`: `neuro-vault-mcp index --vault <path>` as the optional
  warm-up that skips the degraded first window.

- [ ] **Step 4: Re-run the grep and the gates**

Run: `rg -n -i "no watchers|smart.?connections|smart-env" README.md docs/ package.json ; npm test && npm run lint && npm run typecheck && npm run format`
Expected: the only hits are ADR-0006 and its index row; all gates PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/guide package.json
git commit -m "docs: describe the server's own embedding index honestly"
```

---

## Task 14: End-to-end verification

Implements tasks 7.1–7.3.

- [ ] **Step 1: Full gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS; the test count moved only by the tests this change added.

- [ ] **Step 2: Cold-start smoke on a scratch vault**

```bash
mkdir -p /tmp/nv-smoke/Notes && printf '# Alpha\n\n%s\n' "$(head -c 400 /dev/urandom | base64)" > /tmp/nv-smoke/Notes/alpha.md
npx tsx src/cli.ts --vault /tmp/nv-smoke
```

Drive `search_notes` through the MCP inspector (`npm run inspect`) or a client
and confirm: the first call answers with `semantic_status.state === "indexing"`
and lexical matches; a later call reports `"ready"` with no restart;
`find_duplicates` during the window fails with `SEMANTIC_INDEX_BUILDING`.

- [ ] **Step 3: Freshness and opt-out**

Edit `Notes/alpha.md`, wait out the debounce, and confirm the new text is
reachable semantically. Then add `{"semantic": false}` to
`/tmp/nv-smoke/.neuro-vault/config.json`, restart, and confirm: no new shards
are written, `search_notes` reports `disabled`, and `get_similar_notes` returns
`SEMANTIC_DISABLED`.

- [ ] **Step 4: Shutdown**

Close the client's stdin and confirm the process exits rather than hanging on
an open watcher.

- [ ] **Step 5: Sync the capability prose**

When the change is archived and its deltas are synced, fix the Purpose section
of `openspec/specs/corpus-staleness-filtering/spec.md`, which still describes a
read-only plugin corpus — delta specs carry requirements only, so this is a
manual edit.

- [ ] **Step 6: Finish the change**

Write `verify.md`, then `retrospective.md`, archive the change
(`openspec archive own-backend-integration`), and open the PR against `main`
with `Closes #85` and `Closes #88` in the body — this change absorbed the
removal slice. Never local-merge, never push to `main`.
