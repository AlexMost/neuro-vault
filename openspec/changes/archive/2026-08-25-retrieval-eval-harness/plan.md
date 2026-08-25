# Retrieval Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local runner (`npm run eval`) that scores a ranking pipeline against a vault's golden set and writes comparable JSON reports — two axes: `--pipeline semantic|fused` × `--backend sc|own`.

**Architecture:** New top-level `eval/` directory that only *imports* production modules (`findNeighbors`, `executeRetrieval`, `LexicalIndex`, `fuseRanks`, `CorpusStore`, `createSmartConnectionsCorpusIndex`, `EmbeddingService`) — zero changes under `src/`. Modules: golden-set parse/validate → backend snapshot loaders → pipeline rankers → metrics → report writer → CLI orchestrator. Tests in `test/eval/` mirror the repo's vitest style.

**Tech Stack:** TypeScript strict ESM (Node ≥ 20), vitest, `yaml` (already a dependency), `tsx` runner (already a devDependency). No new dependencies.

**Spec:** `openspec/changes/retrieval-eval-harness/specs/retrieval-eval/spec.md` (design: `design.md`, decisions D1–D10)

## Global Constraints

- Gates (run verbatim from repo root): `npm test`, `npm run lint` (= `eslint .`), `npm run typecheck` (= `tsc --noEmit`). All three must pass before every commit.
- ESM: relative imports carry the `.js` suffix; `verbatimModuleSyntax` — type-only imports MUST use `import type`.
- External processes via `execFile` with an args array, never `exec` (ADR-0004).
- No new npm dependencies. No changes under `src/` — `eval/` only imports.
- The runner never runs in CI; its *code* is fully covered by the gates (tsconfig `include` gets `eval`).
- Worktree note: IDE "cannot find module" diagnostics in a worktree are usually stale — trust `npx tsc --noEmit` output in the worktree.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- Work on a feature branch (e.g. `feat/retrieval-eval-harness`); finish via `gh pr create` with `Closes #84` in the body — never merge or push to `main` directly.

---

### Task 1: Repo wiring

**Files:**
- Modify: `tsconfig.json` (add `"eval"` to `include`)
- Modify: `.gitignore` (add `eval/results/`)
- Modify: `package.json` (add `"eval": "tsx eval/run.ts"` script)
- Create: `eval/run.ts` (placeholder that Task 7 replaces)
- Test: `test/eval/wiring.test.ts`

**Interfaces:**
- Produces: `eval/` is inside the TypeScript project (typecheck + type-aware eslint cover it); `npm run eval` resolves.

- [ ] **Step 1: Write the failing wiring test**

```ts
// test/eval/wiring.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The harness must never silently drop out of the gates: `eval` in tsconfig
// `include` is what makes `tsc --noEmit` and type-aware eslint cover it.
describe('eval harness wiring', () => {
  it('keeps eval/ inside the TypeScript project', async () => {
    const tsconfig = JSON.parse(await readFile('tsconfig.json', 'utf8')) as {
      include: string[];
    };
    expect(tsconfig.include).toContain('eval');
  });

  it('exposes the npm eval script', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.eval).toBe('tsx eval/run.ts');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/eval/wiring.test.ts`
Expected: FAIL — `include` does not contain `eval`, no `eval` script.

- [ ] **Step 3: Wire the repo**

In `tsconfig.json`: `"include": ["src", "test", "scripts", "eval", "tsup.config.ts", "vitest.config.ts"]`.
In `.gitignore`: append a line `eval/results/`.
In `package.json` scripts, after `"dev"`: `"eval": "tsx eval/run.ts",`.
Create the placeholder so `eslint .`/`tsc` have a file to check:

```ts
// eval/run.ts
// Retrieval eval harness entrypoint — implemented across this change's tasks.
export {};
```

- [ ] **Step 4: Run the test and the gates**

Run: `npx vitest run test/eval/wiring.test.ts` → PASS.
Run: `npm run lint && npm run typecheck && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json .gitignore package.json eval/run.ts test/eval/wiring.test.ts
git commit -m "chore(eval): wire the eval harness directory into the repo gates"
```

---

### Task 2: Golden set module

**Files:**
- Create: `eval/golden.ts`
- Test: `test/eval/golden.test.ts`

**Interfaces:**
- Produces:
  - `interface GoldenEntry { id: string; query: string; lang: 'ua' | 'en'; source?: string; relevant: string[] }`
  - `class GoldenSetError extends Error` (all golden-set failures — structural and broken-path — throw it)
  - `function parseGoldenSet(yamlText: string): GoldenEntry[]`
  - `function goldenSetPath(vaultRoot: string): string` → `<vaultRoot>/.neuro-vault/eval/golden.yaml`
  - `async function loadGoldenSet(vaultRoot: string): Promise<GoldenEntry[]>` (read + parse + path-validate; used by Task 7)

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/golden.test.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoldenSetError,
  goldenSetPath,
  loadGoldenSet,
  parseGoldenSet,
} from '../../eval/golden.js';

const VALID = `
- id: q001
  query: "release flow"
  lang: en
  source: 2026-W20
  relevant:
    - Reflections/release flow.md
- id: q002
  query: "векторний пошук"
  lang: ua
  relevant:
    - Ideas/embeddings.md
    - Tasks/rag.md
`;

describe('parseGoldenSet', () => {
  it('parses valid entries', () => {
    const entries = parseGoldenSet(VALID);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: 'q001',
      query: 'release flow',
      lang: 'en',
      source: '2026-W20',
      relevant: ['Reflections/release flow.md'],
    });
  });

  it.each([
    ['missing query', '- id: q1\n  lang: en\n  relevant: [a.md]', 'q1'],
    ['unknown lang', '- id: q1\n  query: x\n  lang: fr\n  relevant: [a.md]', 'q1'],
    ['empty relevant', '- id: q1\n  query: x\n  lang: en\n  relevant: []', 'q1'],
    ['missing id', '- query: x\n  lang: en\n  relevant: [a.md]', 'entry 1'],
  ])('rejects %s naming the entry', (_name, yamlText, needle) => {
    expect(() => parseGoldenSet(yamlText)).toThrow(GoldenSetError);
    expect(() => parseGoldenSet(yamlText)).toThrow(needle);
  });

  it('rejects duplicate ids', () => {
    const dup = `${VALID}- id: q001\n  query: y\n  lang: en\n  relevant: [b.md]\n`;
    expect(() => parseGoldenSet(dup)).toThrow(/duplicate.*q001/i);
  });

  it('rejects a non-list document', () => {
    expect(() => parseGoldenSet('foo: bar')).toThrow(GoldenSetError);
  });
});

describe('loadGoldenSet', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  async function makeVault(golden: string, notes: string[]): Promise<void> {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-golden-'));
    await mkdir(path.dirname(goldenSetPath(vaultRoot)), { recursive: true });
    await writeFile(goldenSetPath(vaultRoot), golden);
    for (const note of notes) {
      await mkdir(path.join(vaultRoot, path.dirname(note)), { recursive: true });
      await writeFile(path.join(vaultRoot, note), '# note\n');
    }
  }

  it('resolves the fixed conventional path', () => {
    expect(goldenSetPath('/v')).toBe(path.join('/v', '.neuro-vault/eval/golden.yaml'));
  });

  it('passes when every relevant path exists', async () => {
    await makeVault(VALID, [
      'Reflections/release flow.md',
      'Ideas/embeddings.md',
      'Tasks/rag.md',
    ]);
    await expect(loadGoldenSet(vaultRoot)).resolves.toHaveLength(2);
  });

  it('lists ALL broken entries (id + path) and throws', async () => {
    await makeVault(VALID, ['Reflections/release flow.md']);
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenSetError);
    const message = (err as Error).message;
    expect(message).toContain('q002');
    expect(message).toContain('Ideas/embeddings.md');
    expect(message).toContain('Tasks/rag.md');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/golden.test.ts`
Expected: FAIL — module `eval/golden.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// eval/golden.ts
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

export interface GoldenEntry {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  source?: string;
  relevant: string[];
}

/** Any golden-set failure — structural or broken path. The CLI maps it to exit 1. */
export class GoldenSetError extends Error {}

export function goldenSetPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.neuro-vault/eval/golden.yaml');
}

function fail(message: string): never {
  throw new GoldenSetError(message);
}

function asEntry(raw: unknown, index: number): GoldenEntry {
  const label = (id: unknown): string =>
    typeof id === 'string' && id !== '' ? `"${id}"` : `entry ${index + 1}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`golden set: entry ${index + 1} is not a mapping`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id === '') fail(`golden set: ${label(e.id)} is missing id`);
  if (typeof e.query !== 'string' || e.query.trim() === '')
    fail(`golden set: ${label(e.id)} is missing query`);
  if (e.lang !== 'ua' && e.lang !== 'en')
    fail(`golden set: ${label(e.id)} has unknown lang (expected "ua" or "en")`);
  if (
    !Array.isArray(e.relevant) ||
    e.relevant.length === 0 ||
    !e.relevant.every((p): p is string => typeof p === 'string' && p !== '')
  ) {
    fail(`golden set: ${label(e.id)} needs a non-empty relevant list of paths`);
  }
  return {
    id: e.id,
    query: e.query,
    lang: e.lang,
    ...(typeof e.source === 'string' ? { source: e.source } : {}),
    relevant: e.relevant,
  };
}

export function parseGoldenSet(yamlText: string): GoldenEntry[] {
  const doc: unknown = parse(yamlText);
  if (!Array.isArray(doc)) fail('golden set: document must be a YAML list of entries');
  const entries = doc.map(asEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail(`golden set: duplicate id "${entry.id}"`);
    seen.add(entry.id);
  }
  return entries;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + parse + validate. Every broken relevant path is collected and
 * reported at once — a moved note is a data error to fix, never a silently
 * unwinnable query (spec: "Relevant-path validation gates the run").
 */
export async function loadGoldenSet(vaultRoot: string): Promise<GoldenEntry[]> {
  const file = goldenSetPath(vaultRoot);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    fail(`golden set not found at ${file}`);
  }
  const entries = parseGoldenSet(text);
  const broken: string[] = [];
  for (const entry of entries) {
    for (const rel of entry.relevant) {
      if (!(await pathExists(path.join(vaultRoot, rel)))) {
        broken.push(`  ${entry.id}: ${rel}`);
      }
    }
  }
  if (broken.length > 0) {
    fail(`golden set has broken relevant paths (fix or update the entries):\n${broken.join('\n')}`);
  }
  return entries;
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run test/eval/golden.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add eval/golden.ts test/eval/golden.test.ts
git commit -m "feat(eval): parse and gate the golden set"
```

---

### Task 3: Backend snapshots

**Files:**
- Create: `eval/backends.ts`
- Test: `test/eval/backends.test.ts`

**Interfaces:**
- Consumes: `CorpusStore`, `CorpusShard` (`src/lib/obsidian/corpus/shard-store.js`, `.../types.js`), `decodeVector` (`.../vector-codec.js`), `createSmartConnectionsCorpusIndex` (`src/lib/obsidian/smart-connections-corpus-index.js`), `MODEL_KEY` (`src/lib/obsidian/corpus/types.js`), `SmartSource` (`src/lib/obsidian/smart-connections-types.js`).
- Produces:
  - `type BackendId = 'sc' | 'own'`
  - `class BackendError extends Error`
  - `async function loadSnapshot(backend: BackendId, vaultRoot: string): Promise<Map<string, SmartSource>>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/backends.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorpusStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_DIMS } from '../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { BackendError, loadSnapshot } from '../../eval/backends.js';

function unitVec(hot: number): number[] {
  const v = new Array<number>(MODEL_DIMS).fill(0);
  v[hot] = 1;
  return v;
}

describe('own backend snapshot', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  it('decodes shards into SmartSource entries and skips vectorless notes', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-'));
    const store = new CorpusStore(vaultRoot);
    await store.writeShard({
      path: 'Notes/a.md',
      content_hash: 'h1',
      mtime: 1,
      size: 10,
      embedding: encodeVector(unitVec(0)),
      blocks: [
        { key: '#H1', heading: 'H1', lines: [1, 4], embedding: encodeVector(unitVec(1)) },
      ],
    });
    await store.writeShard({
      path: 'Notes/short.md', // below MIN_CHARS at index time → null note vector
      content_hash: 'h2',
      mtime: 2,
      size: 5,
      embedding: null,
      blocks: [],
    });

    const sources = await loadSnapshot('own', vaultRoot);
    expect([...sources.keys()]).toEqual(['Notes/a.md']);
    const a = sources.get('Notes/a.md')!;
    expect(a.embedding[0]).toBe(1);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ key: '#H1', heading: 'H1', lines: [1, 4] });
    expect(a.blocks[0].embedding[1]).toBe(1);
  });

  it('fails an empty corpus pointing at the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-empty-'));
    const err = await loadSnapshot('own', vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toContain('neuro-vault-mcp index');
  });
});

describe('sc backend snapshot', () => {
  it('fails a vault without a Smart Connections corpus', async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-sc-'));
    const err = await loadSnapshot('sc', vaultRoot).catch((e: unknown) => e);
    await rm(vaultRoot, { recursive: true, force: true });
    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toMatch(/smart connections/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/backends.test.ts`
Expected: FAIL — `eval/backends.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// eval/backends.ts
import path from 'node:path';

import { CorpusStore } from '../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_KEY } from '../src/lib/obsidian/corpus/types.js';
import { decodeVector } from '../src/lib/obsidian/corpus/vector-codec.js';
import { createSmartConnectionsCorpusIndex } from '../src/lib/obsidian/smart-connections-corpus-index.js';
import type { SmartSource } from '../src/lib/obsidian/smart-connections-types.js';

export type BackendId = 'sc' | 'own';

export class BackendError extends Error {}

async function loadOwn(vaultRoot: string): Promise<Map<string, SmartSource>> {
  const store = new CorpusStore(vaultRoot);
  const shards = await store.listShards();
  const sources = new Map<string, SmartSource>();
  for (const shard of shards.values()) {
    // A note below MIN_CHARS has no note vector — it cannot participate in
    // note ranking, matching the SC loader, which skips vectorless sources.
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
  if (sources.size === 0) {
    throw new BackendError(
      `own corpus at ${path.join(vaultRoot, '.neuro-vault/corpus')} is missing or empty — ` +
        'build it with: neuro-vault-mcp index --vault <path>',
    );
  }
  return sources;
}

async function loadSc(vaultRoot: string): Promise<Map<string, SmartSource>> {
  const smartEnvPath = path.join(vaultRoot, '.smart-env', 'multi');
  let sources: Map<string, SmartSource>;
  try {
    const index = await createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey: MODEL_KEY });
    ({ sources } = await index.snapshot());
  } catch (error) {
    throw new BackendError(
      `failed to load the Smart Connections corpus at ${smartEnvPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sources.size === 0) {
    throw new BackendError(
      `Smart Connections corpus at ${smartEnvPath} is empty — open the vault in Obsidian with Smart Connections installed`,
    );
  }
  return sources;
}

export async function loadSnapshot(
  backend: BackendId,
  vaultRoot: string,
): Promise<Map<string, SmartSource>> {
  return backend === 'own' ? loadOwn(vaultRoot) : loadSc(vaultRoot);
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run test/eval/backends.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add eval/backends.ts test/eval/backends.test.ts
git commit -m "feat(eval): load sc and own corpus snapshots for the harness"
```

---

### Task 4: Pipelines

**Files:**
- Create: `eval/pipelines.ts`
- Test: `test/eval/pipelines.test.ts`

**Interfaces:**
- Consumes: `findNeighbors`, `findBlockNeighbors`, `findDuplicates` (`src/modules/semantic/search-engine.js`), `executeRetrieval` (`.../retrieval-policy.js`), `flattenExpansion`, `fuseRanks`, `EXPANSION_WEIGHT` (`.../rank-fusion.js`), `LexicalIndex` (`src/lib/obsidian/lexical/index.js`), `FsVaultReader` (`src/lib/obsidian/vault-reader.js`), `loadVaultScope` (`src/lib/obsidian/vault-scope-config.js`), `WikilinkGraphIndex` (`src/lib/obsidian/wikilink-graph.js`), `SmartSource`.
- Produces:
  - `type PipelineId = 'semantic' | 'fused'`
  - `const EVAL_TOP_K = 10`
  - `const EVAL_CONFIG` — every knob, echoed into the report (design D5/D7)
  - `type EmbedFn = (text: string) => Promise<number[]>`
  - `async function createFusedContext(vaultRoot: string): Promise<FusedContext>` (scope → reader → graph + lexical, built once per run)
  - `async function rankQuery(args: { pipeline: PipelineId; query: string; sources: Map<string, SmartSource>; embed: EmbedFn; fusedContext?: FusedContext }): Promise<string[]>` — top-10 ranked note paths

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/pipelines.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SmartSource } from '../../src/lib/obsidian/smart-connections-types.js';
import {
  EVAL_CONFIG,
  EVAL_TOP_K,
  createFusedContext,
  rankQuery,
} from '../../eval/pipelines.js';

// 3-dim vectors are fine here: pipelines never touch CorpusStore's dims guard.
function src(p: string, v: number[]): [string, SmartSource] {
  return [p, { path: p, embedding: v, blocks: [] }];
}

const SOURCES = new Map<string, SmartSource>([
  src('a.md', [1, 0, 0]),
  src('b.md', [0.9, 0.1, 0]),
  src('c.md', [0, 1, 0]),
]);
const embed = (_text: string): Promise<number[]> => Promise.resolve([1, 0, 0]);

describe('semantic pipeline', () => {
  it('ranks by cosine at threshold 0 and caps at top-10', async () => {
    const top = await rankQuery({ pipeline: 'semantic', query: 'q', sources: SOURCES, embed });
    expect(top[0]).toBe('a.md');
    expect(top[1]).toBe('b.md');
    // threshold 0: even the orthogonal note appears — positions only.
    expect(top).toContain('c.md');
    expect(top.length).toBeLessThanOrEqual(EVAL_TOP_K);
  });
});

describe('fused pipeline', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  it('fuses semantic and lexical legs with production fuseRanks', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-fused-'));
    await mkdir(path.join(vaultRoot, 'Notes'), { recursive: true });
    // lexical-only hit: matches the query text, has no vector in SOURCES
    await writeFile(path.join(vaultRoot, 'Notes/lexical-hit.md'), '# quirkyterm\nquirkyterm body\n');
    await writeFile(path.join(vaultRoot, 'a.md'), '# alpha\nunrelated text\n');
    const fusedContext = await createFusedContext(vaultRoot);
    const top = await rankQuery({
      pipeline: 'fused',
      query: 'quirkyterm',
      sources: SOURCES,
      embed,
      fusedContext,
    });
    // The lexical leg surfaced a note the semantic leg cannot know about —
    // the fused list carries it (the Moby-case mechanism, RRF fusion).
    expect(top).toContain('Notes/lexical-hit.md');
    // Semantic leg still contributes its threshold-0 ranking.
    expect(top).toContain('a.md');
  });
});

describe('EVAL_CONFIG', () => {
  it('records every knob the run used', () => {
    expect(EVAL_CONFIG).toMatchObject({
      top_k: 10,
      semantic_threshold: 0,
      semantic_pool: 8,
      expansion_limit: 3,
      expansion_floor: 0.35,
      lexical_note_cap: 10,
      lexical_per_note_cap: 3,
      expansion_weight: 0.85,
      k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/pipelines.test.ts`
Expected: FAIL — `eval/pipelines.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// eval/pipelines.ts
import { LexicalIndex } from '../src/lib/obsidian/lexical/index.js';
import type { SmartSource } from '../src/lib/obsidian/smart-connections-types.js';
import { FsVaultReader } from '../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../src/lib/obsidian/vault-scope-config.js';
import { WikilinkGraphIndex } from '../src/lib/obsidian/wikilink-graph.js';
import { EXPANSION_WEIGHT, flattenExpansion, fuseRanks } from '../src/modules/semantic/rank-fusion.js';
import { executeRetrieval } from '../src/modules/semantic/retrieval-policy.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../src/modules/semantic/search-engine.js';

export type PipelineId = 'semantic' | 'fused';
export type EmbedFn = (text: string) => Promise<number[]>;

export const EVAL_TOP_K = 10;

// Every knob in effect, echoed verbatim into the report's `config` (design
// D5/D7): a run with different knobs must be distinguishable. Semantic legs
// run at threshold 0 — production thresholds are model-scale-bound and eval
// counts positions only. Everything else mirrors production deep effort.
export const EVAL_CONFIG = {
  top_k: EVAL_TOP_K,
  semantic_threshold: 0,
  semantic_pool: 8,
  expansion_limit: 3,
  expansion_floor: 0.35,
  lexical_note_cap: 10,
  lexical_per_note_cap: 3,
  expansion_weight: EXPANSION_WEIGHT,
  k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
} as const;

export interface FusedContext {
  lexical: LexicalIndex;
  graph: WikilinkGraphIndex;
}

export async function createFusedContext(vaultRoot: string): Promise<FusedContext> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const graph = new WikilinkGraphIndex({ reader });
  await graph.ensureFresh();
  return { lexical: new LexicalIndex({ vaultRoot, reader }), graph };
}

async function rankSemantic(
  query: string,
  sources: Map<string, SmartSource>,
  embed: EmbedFn,
): Promise<string[]> {
  const queryVector = await embed(query);
  return findNeighbors({
    queryVector,
    sources: sources.values(),
    threshold: EVAL_CONFIG.semantic_threshold,
    limit: EVAL_TOP_K,
  }).map((r) => r.path);
}

async function rankFused(
  query: string,
  sources: Map<string, SmartSource>,
  embed: EmbedFn,
  context: FusedContext,
): Promise<string[]> {
  // The production legs, verbatim (design D5): executeRetrieval at deep
  // effort (pool 8, expansion on) with an explicit threshold 0, the lexical
  // index with the real wikilink graph for its backlink tie-break, then the
  // exact fusion `assembleUnified` performs — flattenExpansion + fuseRanks.
  const semantic = await executeRetrieval({
    queries: [query],
    mode: 'deep',
    threshold: EVAL_CONFIG.semantic_threshold,
    expansionFloor: EVAL_CONFIG.expansion_floor,
    sources,
    embeddingProvider: { initialize: () => Promise.resolve(), embed },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
  });
  const lexical = await context.lexical.search({
    queries: [query],
    noteCap: EVAL_CONFIG.lexical_note_cap,
    perNoteCap: EVAL_CONFIG.lexical_per_note_cap,
    getBacklinkCount: (p) => context.graph.getBacklinkCount(p),
  });
  const expansion = flattenExpansion(semantic.results);
  return fuseRanks({
    sources: {
      semantic: semantic.results.map((n) => n.path),
      lexical: lexical.notes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes: lexical.totalNotes,
  })
    .slice(0, EVAL_TOP_K)
    .map((c) => c.path);
}

export async function rankQuery(args: {
  pipeline: PipelineId;
  query: string;
  sources: Map<string, SmartSource>;
  embed: EmbedFn;
  fusedContext?: FusedContext;
}): Promise<string[]> {
  if (args.pipeline === 'semantic') {
    return rankSemantic(args.query, args.sources, args.embed);
  }
  if (!args.fusedContext) {
    throw new Error('fused pipeline requires a FusedContext');
  }
  return rankFused(args.query, args.sources, args.embed, args.fusedContext);
}
```

Note: `executeRetrieval`'s deep pool of 8 comes from its own `MODE_DEFAULTS` (no `limit` passed) — `EVAL_CONFIG.semantic_pool` documents it. If the assertion in Step 1's config test disagrees with `EXPANSION_WEIGHT` (0.85) or the mode defaults at implementation time, the constants in `src/` win and the test/config text is updated to match them.

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run test/eval/pipelines.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add eval/pipelines.ts test/eval/pipelines.test.ts
git commit -m "feat(eval): semantic and fused ranking pipelines over a corpus snapshot"
```

---

### Task 5: Metrics

**Files:**
- Create: `eval/metrics.ts`
- Test: `test/eval/metrics.test.ts`

**Interfaces:**
- Consumes: `GoldenEntry` (`eval/golden.js`).
- Produces:
  - `interface QueryScore { id: string; query: string; lang: 'ua' | 'en'; top: string[]; first_relevant_rank: number | null; precision_at_3: number; reciprocal_rank: number; hit_at_3: boolean }`
  - `function scoreQuery(entry: GoldenEntry, top: string[]): QueryScore`
  - `interface SliceMetrics { n: number; precision_at_3: number; mrr: number; hit_at_3: number }`
  - `interface Metrics { overall: SliceMetrics; ua: SliceMetrics; en: SliceMetrics }`
  - `function aggregate(scores: QueryScore[]): Metrics`

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/metrics.test.ts
import { describe, expect, it } from 'vitest';
import type { GoldenEntry } from '../../eval/golden.js';
import { aggregate, scoreQuery } from '../../eval/metrics.js';

const entry = (id: string, lang: 'ua' | 'en', relevant: string[]): GoldenEntry => ({
  id,
  query: id,
  lang,
  relevant,
});

describe('scoreQuery', () => {
  it('relevant ranked third → 1/3 precision, 1/3 RR, hit@3', () => {
    const s = scoreQuery(entry('q1', 'en', ['c.md']), ['a.md', 'b.md', 'c.md', 'd.md']);
    expect(s.first_relevant_rank).toBe(3);
    expect(s.precision_at_3).toBeCloseTo(1 / 3);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 3);
    expect(s.hit_at_3).toBe(true);
  });

  it('no relevant in top-10 → zeros, rank null', () => {
    const s = scoreQuery(entry('q2', 'ua', ['zzz.md']), ['a.md', 'b.md']);
    expect(s.first_relevant_rank).toBeNull();
    expect(s.precision_at_3).toBe(0);
    expect(s.reciprocal_rank).toBe(0);
    expect(s.hit_at_3).toBe(false);
  });

  it('binary set: any relevant path counts; two in top-3 → 2/3 precision', () => {
    const s = scoreQuery(entry('q3', 'en', ['a.md', 'b.md']), ['a.md', 'x.md', 'b.md']);
    expect(s.first_relevant_rank).toBe(1);
    expect(s.precision_at_3).toBeCloseTo(2 / 3);
    expect(s.reciprocal_rank).toBe(1);
  });

  it('relevant ranked fourth → miss for @3 metrics, RR 1/4', () => {
    const s = scoreQuery(entry('q4', 'en', ['d.md']), ['a.md', 'b.md', 'c.md', 'd.md']);
    expect(s.precision_at_3).toBe(0);
    expect(s.hit_at_3).toBe(false);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 4);
  });
});

describe('aggregate', () => {
  it('averages per slice; slices partition by lang', () => {
    const scores = [
      scoreQuery(entry('u1', 'ua', ['a.md']), ['a.md']), // RR 1, hit
      scoreQuery(entry('u2', 'ua', ['b.md']), ['x.md']), // RR 0, miss
      scoreQuery(entry('e1', 'en', ['c.md']), ['x.md', 'c.md']), // RR 1/2, hit
    ];
    const m = aggregate(scores);
    expect(m.overall.n).toBe(3);
    expect(m.ua.n).toBe(2);
    expect(m.en.n).toBe(1);
    expect(m.ua.mrr).toBeCloseTo(0.5);
    expect(m.ua.hit_at_3).toBeCloseTo(0.5);
    expect(m.en.mrr).toBeCloseTo(0.5);
    expect(m.overall.mrr).toBeCloseTo((1 + 0 + 0.5) / 3);
  });

  it('an empty slice reports n 0 and zero metrics', () => {
    const m = aggregate([scoreQuery(entry('u1', 'ua', ['a.md']), ['a.md'])]);
    expect(m.en).toEqual({ n: 0, precision_at_3: 0, mrr: 0, hit_at_3: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/metrics.test.ts`
Expected: FAIL — `eval/metrics.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// eval/metrics.ts
import type { GoldenEntry } from './golden.js';

export interface QueryScore {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  top: string[];
  /** 1-based rank of the first relevant hit within the top list, or null. */
  first_relevant_rank: number | null;
  precision_at_3: number;
  reciprocal_rank: number;
  hit_at_3: boolean;
}

export function scoreQuery(entry: GoldenEntry, top: string[]): QueryScore {
  const relevant = new Set(entry.relevant);
  const firstIndex = top.findIndex((p) => relevant.has(p));
  const first_relevant_rank = firstIndex === -1 ? null : firstIndex + 1;
  const hitsAt3 = top.slice(0, 3).filter((p) => relevant.has(p)).length;
  return {
    id: entry.id,
    query: entry.query,
    lang: entry.lang,
    top,
    first_relevant_rank,
    precision_at_3: hitsAt3 / 3,
    reciprocal_rank: first_relevant_rank === null ? 0 : 1 / first_relevant_rank,
    hit_at_3: hitsAt3 > 0,
  };
}

export interface SliceMetrics {
  n: number;
  precision_at_3: number;
  mrr: number;
  hit_at_3: number;
}

export interface Metrics {
  overall: SliceMetrics;
  ua: SliceMetrics;
  en: SliceMetrics;
}

function slice(scores: QueryScore[]): SliceMetrics {
  if (scores.length === 0) return { n: 0, precision_at_3: 0, mrr: 0, hit_at_3: 0 };
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: scores.length,
    precision_at_3: mean(scores.map((s) => s.precision_at_3)),
    mrr: mean(scores.map((s) => s.reciprocal_rank)),
    hit_at_3: mean(scores.map((s) => (s.hit_at_3 ? 1 : 0))),
  };
}

export function aggregate(scores: QueryScore[]): Metrics {
  return {
    overall: slice(scores),
    ua: slice(scores.filter((s) => s.lang === 'ua')),
    en: slice(scores.filter((s) => s.lang === 'en')),
  };
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run test/eval/metrics.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add eval/metrics.ts test/eval/metrics.test.ts
git commit -m "feat(eval): precision@3, MRR and hit@3 with language slices"
```

---

### Task 6: Report

**Files:**
- Create: `eval/report.ts`
- Test: `test/eval/report.test.ts`

**Interfaces:**
- Consumes: `Metrics`, `QueryScore` (`eval/metrics.js`), `PipelineId` (`eval/pipelines.js`), `BackendId` (`eval/backends.js`).
- Produces:
  - `interface EvalReport { code_sha: string | null; vault_sha: string | null; model_id: string; pipeline: PipelineId; backend: BackendId; config: Record<string, unknown>; golden: { path: string; count: number }; metrics: Metrics; per_query: QueryScore[] }`
  - `async function gitSha(dir: string): Promise<string | null>` — `<sha>` clean, `<sha>-dirty` dirty, `null` when not a git repo
  - `async function writeReport(report: EvalReport, resultsDir: string, now?: Date): Promise<string>` — returns the written file path, name `<yyyy-mm-ddThh-mm-ss>-<pipeline>-<backend>.json`

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/report.test.ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvalReport } from '../../eval/report.js';
import { gitSha, writeReport } from '../../eval/report.js';

const run = promisify(execFile);

describe('gitSha', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('returns null outside a git repository', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-nogit-'));
    await expect(gitSha(dir)).resolves.toBeNull();
  });

  it('returns the SHA, with -dirty appended on a dirty tree', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-git-'));
    const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
    await git('init');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x');
    const clean = await gitSha(dir);
    expect(clean).toMatch(/^[0-9a-f]{40}$/);
    await run('touch', [path.join(dir, 'f')]);
    await expect(gitSha(dir)).resolves.toBe(`${clean}-dirty`);
  });
});

describe('writeReport', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('writes identity fields and a deterministic filename', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-report-'));
    const report: EvalReport = {
      code_sha: 'abc',
      vault_sha: null,
      model_id: 'TaylorAI/bge-micro-v2',
      pipeline: 'semantic',
      backend: 'own',
      config: { top_k: 10 },
      golden: { path: '/v/.neuro-vault/eval/golden.yaml', count: 2 },
      metrics: {
        overall: { n: 2, precision_at_3: 0.5, mrr: 0.75, hit_at_3: 1 },
        ua: { n: 1, precision_at_3: 1 / 3, mrr: 0.5, hit_at_3: 1 },
        en: { n: 1, precision_at_3: 2 / 3, mrr: 1, hit_at_3: 1 },
      },
      per_query: [],
    };
    const file = await writeReport(report, dir, new Date('2026-08-25T10:20:30Z'));
    expect(path.basename(file)).toBe('2026-08-25T10-20-30-semantic-own.json');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as EvalReport;
    expect(parsed).toEqual(report);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/report.test.ts`
Expected: FAIL — `eval/report.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// eval/report.ts
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackendId } from './backends.js';
import type { Metrics, QueryScore } from './metrics.js';
import type { PipelineId } from './pipelines.js';

const execFileAsync = promisify(execFile);

export interface EvalReport {
  /** Repo HEAD; `<sha>-dirty` on a dirty tree; null when not a git repo. */
  code_sha: string | null;
  /** Vault HEAD, same convention — two reports compare iff these match, clean. */
  vault_sha: string | null;
  model_id: string;
  pipeline: PipelineId;
  backend: BackendId;
  config: Record<string, unknown>;
  golden: { path: string; count: number };
  metrics: Metrics;
  per_query: QueryScore[];
}

export async function gitSha(dir: string): Promise<string | null> {
  try {
    const { stdout: sha } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const { stdout: status } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
    const clean = status.trim() === '';
    return clean ? sha.trim() : `${sha.trim()}-dirty`;
  } catch {
    return null;
  }
}

export async function writeReport(
  report: EvalReport,
  resultsDir: string,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  const file = path.join(resultsDir, `${stamp}-${report.pipeline}-${report.backend}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
```

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run test/eval/report.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add eval/report.ts test/eval/report.test.ts
git commit -m "feat(eval): comparable JSON reports with code and vault identity"
```

---

### Task 7: Runner CLI and end-to-end

**Files:**
- Modify: `eval/run.ts` (replace the Task 1 placeholder)
- Test: `test/eval/run.test.ts`

**Interfaces:**
- Consumes: everything above, plus `EmbeddingService` (`src/modules/semantic/embedding-service.js`), `MODEL_ID` (`src/lib/obsidian/corpus/types.js`).
- Produces:
  - `interface EvalArgs { vault: string; pipeline: PipelineId; backend: BackendId }`
  - `function parseEvalArgs(argv: string[]): EvalArgs` — throws `UsageError` naming supported values
  - `async function runEval(args: EvalArgs, deps?: { embed?: EmbedFn; resultsDir?: string; modelId?: string }): Promise<{ reportFile: string; report: EvalReport }>`
  - CLI entrypoint: parse → `runEval` → print a per-slice summary; any `GoldenSetError` / `BackendError` / `UsageError` → message on stderr, `process.exitCode = 1`, and NO report written (validation precedes ranking inside `runEval`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/eval/run.test.ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorpusStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_DIMS } from '../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { GoldenSetError } from '../../eval/golden.js';
import { UsageError, parseEvalArgs, runEval } from '../../eval/run.js';

describe('parseEvalArgs', () => {
  it('parses the three flags', () => {
    expect(
      parseEvalArgs(['--vault', '/v', '--pipeline', 'fused', '--backend', 'own']),
    ).toEqual({ vault: '/v', pipeline: 'fused', backend: 'own' });
  });

  it.each([
    [['--pipeline', 'semantic', '--backend', 'own'], /--vault/],
    [['--vault', '/v', '--pipeline', 'reranked', '--backend', 'own'], /semantic.*fused/s],
    [['--vault', '/v', '--pipeline', 'semantic', '--backend', 'foo'], /sc.*own/s],
    [['--vault', '/v', '--pipeline', 'semantic', '--backend', 'own', '--bogus'], /--bogus/],
  ])('rejects %j naming what is supported', (argv, pattern) => {
    expect(() => parseEvalArgs(argv)).toThrow(UsageError);
    expect(() => parseEvalArgs(argv)).toThrow(pattern);
  });
});

describe('runEval end-to-end (own backend, stub embedder)', () => {
  let vaultRoot: string;
  let resultsDir: string;
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(resultsDir, { recursive: true, force: true });
  });

  function unitVec(hot: number): number[] {
    const v = new Array<number>(MODEL_DIMS).fill(0);
    v[hot] = 1;
    return v;
  }

  async function makeVault(golden: string): Promise<void> {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-e2e-vault-'));
    resultsDir = await mkdtemp(path.join(tmpdir(), 'eval-e2e-results-'));
    for (const [note, text] of [
      ['Notes/target.md', '# target\ncontent about the topic\n'],
      ['Notes/other.md', '# other\nsomething else entirely\n'],
    ] as const) {
      await mkdir(path.join(vaultRoot, path.dirname(note)), { recursive: true });
      await writeFile(path.join(vaultRoot, note), text);
    }
    const store = new CorpusStore(vaultRoot);
    await store.writeShard({
      path: 'Notes/target.md',
      content_hash: 'h1',
      mtime: 1,
      size: 30,
      embedding: encodeVector(unitVec(0)), // matches the stub query vector
      blocks: [],
    });
    await store.writeShard({
      path: 'Notes/other.md',
      content_hash: 'h2',
      mtime: 2,
      size: 30,
      embedding: encodeVector(unitVec(5)), // orthogonal
      blocks: [],
    });
    await mkdir(path.join(vaultRoot, '.neuro-vault/eval'), { recursive: true });
    await writeFile(path.join(vaultRoot, '.neuro-vault/eval/golden.yaml'), golden);
  }

  const GOLDEN = `
- id: q001
  query: "the topic"
  lang: en
  relevant:
    - Notes/target.md
`;

  it('runs semantic × own and writes a correct report', async () => {
    await makeVault(GOLDEN);
    const { report, reportFile } = await runEval(
      { vault: vaultRoot, pipeline: 'semantic', backend: 'own' },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(reportFile).toContain('semantic-own');
    expect(report.pipeline).toBe('semantic');
    expect(report.backend).toBe('own');
    expect(report.vault_sha).toBeNull(); // temp vault is not a git repo
    expect(report.golden.count).toBe(1);
    expect(report.metrics.overall).toMatchObject({ n: 1, mrr: 1, hit_at_3: 1 });
    expect(report.per_query[0]).toMatchObject({
      id: 'q001',
      first_relevant_rank: 1,
    });
    expect(report.config).toMatchObject({ top_k: 10, semantic_threshold: 0 });
  });

  it('broken relevant path: fails before ranking, writes no report', async () => {
    await makeVault(`${GOLDEN}- id: q002\n  query: x\n  lang: en\n  relevant: [Gone/nope.md]\n`);
    await expect(
      runEval(
        { vault: vaultRoot, pipeline: 'semantic', backend: 'own' },
        { embed: () => Promise.reject(new Error('embed must not run')), resultsDir },
      ),
    ).rejects.toThrow(GoldenSetError);
    await expect(readdir(resultsDir)).resolves.toEqual([]);
  });

  it('fused × own also completes on the fixture', async () => {
    await makeVault(GOLDEN);
    const { report } = await runEval(
      { vault: vaultRoot, pipeline: 'fused', backend: 'own' },
      { embed: () => Promise.resolve(unitVec(0)), resultsDir },
    );
    expect(report.metrics.overall.n).toBe(1);
    expect(report.per_query[0].top).toContain('Notes/target.md');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/eval/run.test.ts`
Expected: FAIL — `eval/run.ts` exports nothing yet.

- [ ] **Step 3: Implement**

```ts
// eval/run.ts
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_ID } from '../src/lib/obsidian/corpus/types.js';
import { EmbeddingService } from '../src/modules/semantic/embedding-service.js';
import { BackendError, loadSnapshot, type BackendId } from './backends.js';
import { GoldenSetError, goldenSetPath, loadGoldenSet } from './golden.js';
import { aggregate, scoreQuery, type QueryScore } from './metrics.js';
import {
  EVAL_CONFIG,
  createFusedContext,
  rankQuery,
  type EmbedFn,
  type FusedContext,
  type PipelineId,
} from './pipelines.js';
import { gitSha, writeReport, type EvalReport } from './report.js';

export class UsageError extends Error {}

export interface EvalArgs {
  vault: string;
  pipeline: PipelineId;
  backend: BackendId;
}

const USAGE =
  'usage: npm run eval -- --vault <path> --pipeline <semantic|fused> --backend <sc|own>';

export function parseEvalArgs(argv: string[]): EvalArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--vault', '--pipeline', '--backend'].includes(flag) || value === undefined) {
      throw new UsageError(`unknown or valueless argument "${flag}"\n${USAGE}`);
    }
    values.set(flag, value);
  }
  const vault = values.get('--vault');
  if (vault === undefined) throw new UsageError(`--vault is required\n${USAGE}`);
  const pipeline = values.get('--pipeline') ?? 'semantic';
  if (pipeline !== 'semantic' && pipeline !== 'fused') {
    throw new UsageError(`unknown pipeline "${pipeline}" — supported: semantic, fused`);
  }
  const backend = values.get('--backend') ?? 'own';
  if (backend !== 'sc' && backend !== 'own') {
    throw new UsageError(`unknown backend "${backend}" — supported: sc, own`);
  }
  return { vault, pipeline, backend };
}

const DEFAULT_RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');

export async function runEval(
  args: EvalArgs,
  deps: { embed?: EmbedFn; resultsDir?: string; modelId?: string } = {},
): Promise<{ reportFile: string; report: EvalReport }> {
  const vaultRoot = path.resolve(args.vault);
  // Validation gates the run: golden set first (its failures must precede any
  // model/corpus work), then the backend snapshot.
  const entries = await loadGoldenSet(vaultRoot);
  const sources = await loadSnapshot(args.backend, vaultRoot);
  const embed =
    deps.embed ??
    (() => {
      const service = new EmbeddingService();
      return (text: string) => service.embed(text);
    })();
  const fusedContext: FusedContext | undefined =
    args.pipeline === 'fused' ? await createFusedContext(vaultRoot) : undefined;

  const per_query: QueryScore[] = [];
  for (const entry of entries) {
    const top = await rankQuery({
      pipeline: args.pipeline,
      query: entry.query,
      sources,
      embed,
      fusedContext,
    });
    per_query.push(scoreQuery(entry, top));
  }

  const report: EvalReport = {
    code_sha: await gitSha(process.cwd()),
    vault_sha: await gitSha(vaultRoot),
    model_id: deps.modelId ?? MODEL_ID,
    pipeline: args.pipeline,
    backend: args.backend,
    config: { ...EVAL_CONFIG },
    golden: { path: goldenSetPath(vaultRoot), count: entries.length },
    metrics: aggregate(per_query),
    per_query,
  };
  const reportFile = await writeReport(report, deps.resultsDir ?? DEFAULT_RESULTS_DIR);
  return { reportFile, report };
}

function formatSlice(name: string, m: EvalReport['metrics']['overall']): string {
  return `${name.padEnd(8)} n=${m.n}  p@3=${m.precision_at_3.toFixed(3)}  mrr=${m.mrr.toFixed(3)}  hit@3=${m.hit_at_3.toFixed(3)}`;
}

async function main(): Promise<void> {
  try {
    const args = parseEvalArgs(process.argv.slice(2));
    const { report, reportFile } = await runEval(args);
    console.log(`pipeline=${report.pipeline} backend=${report.backend}`);
    console.log(`code_sha=${report.code_sha ?? 'n/a'} vault_sha=${report.vault_sha ?? 'n/a'}`);
    console.log(formatSlice('overall', report.metrics.overall));
    console.log(formatSlice('ua', report.metrics.ua));
    console.log(formatSlice('en', report.metrics.en));
    console.log(`report: ${reportFile}`);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof GoldenSetError ||
      error instanceof BackendError
    ) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exitCode = 1;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main();
}
```

- [ ] **Step 4: Run tests + full gates**

Run: `npx vitest run test/eval/run.test.ts` → PASS.
Run: `npm test && npm run lint && npm run typecheck` → all pass.

- [ ] **Step 5: Smoke-run against the real vault (manual, not CI)**

Run: `npm run eval -- --vault <real vault path> --pipeline semantic --backend own`
Expected: either a summary + report file, or an honest `GoldenSetError` (golden set not curated yet — #86); both prove the CLI path. Do not commit anything from `eval/results/`.

- [ ] **Step 6: Commit**

```bash
git add eval/run.ts test/eval/run.test.ts
git commit -m "feat(eval): runner CLI — validate, rank, score and report"
```

---

### Task 8: Docs and delivery

**Files:**
- Create: `eval/README.md`
- Modify: `docs/README.md` (add the harness to the docs map if a natural slot exists)
- Sweep: all of `docs/` (per the doc-sweep scope rule — including `docs/guide/` and `docs/agents/`)

- [ ] **Step 1: Write `eval/README.md`**

Content (prose, adapt freely but cover all of):

- What it is: offline retrieval-quality harness; measures the ranking pipeline as a library — no MCP, no server.
- Golden set: `<vault>/.neuro-vault/eval/golden.yaml`, committed to the vault's git; YAML schema with the `id/query/lang/source/relevant` example from the spec; binary relevance; dot-path = auto-excluded from indexing; broken `relevant` paths fail the run (the golden set's "compile error").
- Running: `npm run eval -- --vault <path> --pipeline semantic|fused --backend sc|own`; `own` needs `neuro-vault-mcp index` first; `sc` needs a Smart Connections corpus.
- Axes: pipeline = ranking method, backend = vector source; `--backend` (and `sc`) is removed together with Smart Connections (#88).
- Scoring: threshold 0, top-10, positions only (production thresholds are model-scale-bound); precision@3 / MRR / hit@3; slices overall/ua/en.
- Reports: `eval/results/` (gitignored); comparability rule — two reports compare iff `vault_sha` values are equal and clean; durable baselines are transcribed by hand (vault task note, SC-removal change).
- Pointers: golden-set curation #86, diagnostic parity run #87.

- [ ] **Step 2: Docs sweep**

Run: `grep -rn -i "eval harness\|golden set\|golden.yaml\|retrieval eval" docs/ README.md`
For every hit, check the statement against the shipped contract (paths, flags, metrics) and fix drift. Add a one-line entry for `eval/` to `docs/README.md`'s map if the map lists tooling directories (follow its existing granularity — do not invent a new section style).

- [ ] **Step 3: Full gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build` → all pass.

- [ ] **Step 4: Commit**

```bash
git add eval/README.md docs/
git commit -m "docs(eval): document the retrieval eval harness"
```

- [ ] **Step 5: Deliver**

Per the opsx flow: `/opsx:verify` against this change's artifacts, then retrospective, then archive, then PR. PR body carries `Closes #84` and the standard generated-with footer; PR title `feat(eval): retrieval eval harness`.

---

## Self-Review Notes

- Spec coverage: golden location/schema → Task 2; path validation gate → Tasks 2 & 7 (no-report assertion); axes + unknown values → Task 7; backend loading + missing-corpus errors → Task 3; positions-only scoring + metrics + slices → Tasks 4 & 5; report identity (`vault_sha` null, dirty) → Task 6; standalone execution + production-fusion reuse → Task 4 (imports are the production functions; the fused test exercises them) and Task 7 e2e.
- Type consistency: `EmbedFn`/`PipelineId`/`BackendId`/`QueryScore`/`EvalReport` names match across Tasks 3–7; `GoldenEntry.lang` is `'ua' | 'en'` everywhere.
- Constants asserted in tests (`EXPANSION_WEIGHT` 0.85, deep pool 8) mirror `src/` values verified at plan time; if `src/` changes first, `src/` wins (noted in Task 4).
