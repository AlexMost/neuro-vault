# cli-index-command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `neuro-vault-mcp index --vault <path>` reconciles a vault's embedding corpus on demand — thin wrapper over `reconcileCorpus`, progress on stdout, exit code = completeness.

**Architecture:** `parseConfig` (src/config.ts) grows yargs command structure — server stays the default command, `index` becomes a subcommand returning a new `ParsedCli` variant; `src/cli.ts` dispatches that variant to a new `runIndexCommand` in `src/cli-index.ts`, which wires the server's existing seams (`loadVaultScope` → `FsVaultReader` → `CorpusStore` → `reconcileCorpus`) per vault, sequentially, with one shared `EmbeddingService`.

**Tech Stack:** TypeScript ESM, yargs, vitest. No new runtime dependencies.

**Spec:** `openspec/changes/cli-index-command/specs/cli-index-command/spec.md`, design: `openspec/changes/cli-index-command/design.md`.

## Global Constraints

- **Apply gate:** do NOT start before `own-corpus-indexer` PR 2 is merged to `main` — `src/lib/obsidian/corpus/reconcile.ts` (`reconcileCorpus`, `ReconcileDeps`, `ReconcileOptions`, `ReconcileSummary`) must exist on `main` first. If its merged signatures differ from the Interfaces blocks below, the merged code wins — adjust the steps, not the other way around.
- Gates before any commit lands in a PR: `npm test`, `npm run lint`, `npm run typecheck` (authoritative — a tsup build is not), `npx openspec validate --all`.
- Server-mode stdout is the MCP transport: nothing in this change may write to stdout except the `index` runner.
- No new runtime dependencies; no MCP tool contract changes; no watcher.
- Never edit files under `.scratch/` or `.claude/worktrees/`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` — or omit the trailer entirely.
- Tests use injected fakes — the suite must never load the real ONNX model or touch a real vault.

---

### Task 1: Command parsing — `index` subcommand and the `ParsedCli` variant

**Files:**
- Modify: `src/config.ts` (yargs command structure, `ParsedCli`, shared vault validation)
- Modify: `src/cli.ts` (dispatch — same task as the type change, they ship together)
- Create: `src/cli-index.ts` (stub only in this task: exported signature, `throw new Error('not implemented')`)
- Test: `test/config.test.ts` (extend — follow its existing patterns)

**Interfaces:**
- Consumes: existing `buildVaultConfig` logic in `src/config.ts`, `IVaultConfig` from `src/types.ts`.
- Produces (Task 2 relies on these exact names):
  ```ts
  // src/config.ts
  export interface IndexCliOptions { vaults: IVaultConfig[] }
  export type ParsedCli =
    | { kind: 'run'; config: ServerConfig }
    | { kind: 'index'; options: IndexCliOptions }
    | { kind: 'handled' };
  // src/cli-index.ts
  export async function runIndexCommand(
    options: IndexCliOptions, deps?: IndexCommandDeps): Promise<number>
  ```

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, add a `describe('index subcommand', …)` block:

```ts
it('parses index --vault into the index variant', async () => {
  const parsed = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultDir]);
  expect(parsed.kind).toBe('index');
  if (parsed.kind !== 'index') return;
  expect(parsed.options.vaults).toHaveLength(1);
  expect(parsed.options.vaults[0].path).toBe(vaultDir);
});

it('index rejects a relative vault path with the same error as server mode', async () => {
  await expect(parseConfig(['node', 'cli.js', 'index', '--vault', './rel'])).rejects.toThrow(
    /--vault: path must be absolute/,
  );
});

it('index without --vault is rejected naming the option', async () => {
  await expect(parseConfig(['node', 'cli.js', 'index'])).rejects.toThrow(/--vault is required/);
});

it('index rejects --no-semantic (server-only option)', async () => {
  await expect(
    parseConfig(['node', 'cli.js', 'index', '--no-semantic', '--vault', vaultDir]),
  ).rejects.toThrow();
});

it('a plain --vault invocation still resolves to the server variant', async () => {
  const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultDir]);
  expect(parsed.kind).toBe('run');
});
```

(`vaultDir` = a temp directory created the same way the file's existing tests do.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — the new tests error (yargs `.strict()` rejects the `index` positional today).

- [ ] **Step 3: Restructure `parseConfig` around yargs commands**

In `src/config.ts`: extract the current post-parse vault block (lines ~90–110: required-check, `buildVaultConfig` map, case-insensitive uniqueness) into `function validateVaults(rawVaults: string[]): IVaultConfig[]`. Then:

```ts
const VAULT_OPTION = {
  type: 'string',
  array: true,
  describe:
    'Absolute path to a vault directory. Repeat for multi-vault. The MCP-side alias is derived from the directory basename.',
} as const;

export async function parseConfig(argv: string[]): Promise<ParsedCli> {
  const args = await yargs(hideBin(argv))
    .scriptName('neuro-vault-mcp')
    .usage('$0 --vault <path> [--vault <path> ...]\n\nMCP server for one or more Obsidian vaults.')
    .command('$0', 'Run the MCP server over stdio (default)', (y) =>
      y.option('vault', VAULT_OPTION).option('semantic', {
        type: 'boolean',
        default: true,
        describe: 'Enable semantic search module (Smart Connections embeddings)',
      }),
    )
    .command(
      'index',
      'Build or refresh the embedding corpus for each vault, then exit',
      (y) => y.option('vault', VAULT_OPTION),
    )
    .strict()
    .help()
    .version(packageMeta.version)
    .exitProcess(false)
    .parse();

  if (args.help === true || args.version === true) return { kind: 'handled' };

  const vaults = validateVaults((args.vault as string[] | undefined) ?? []);

  if (args._[0] === 'index') {
    return { kind: 'index', options: { vaults } };
  }
  return {
    kind: 'run',
    config: {
      vaults,
      semantic: {
        enabled: (args.semantic as boolean | undefined) ?? true,
        modelKey: MODEL_KEY,
        modelId: DEFAULT_MODEL_ID,
      },
    },
  };
}
```

Notes: `semantic` lives only on the default command's builder, so `.strict()` rejects it on `index` (design D2/Q6). The casts are needed because per-command builders widen the top-level parse type; keep them local and narrow.

- [ ] **Step 4: Stub the runner and dispatch in `src/cli.ts`**

Create `src/cli-index.ts` (an empty `IndexCommandDeps` interface would trip
eslint's empty-object-type rule, so the deps parameter arrives with its real
shape in Task 2 — signature change and call site ship inside that one task):

```ts
import type { IndexCliOptions } from './config.js';

export async function runIndexCommand(_options: IndexCliOptions): Promise<number> {
  throw new Error('not implemented');
}
```

In `src/cli.ts` `main()`, after the `handled` return:

```ts
if (parsed.kind === 'index') {
  process.exitCode = await runIndexCommand(parsed.options);
  return;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/config.test.ts`
Expected: PASS — new block and every pre-existing test (the `cli-startup-flags` scenarios: `--help`/`--version` short-circuit to `handled`, plain `--vault` still `run`).

- [ ] **Step 6: Verify `index --help` renders cleanly**

Run: `npm run dev -- index --help`
Expected: subcommand help listing `--vault`, exit code 0. Also run `npm run dev -- --help` and confirm the command list shows the server default and `index`.

- [ ] **Step 7: Full gates, then commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/config.ts src/cli.ts src/cli-index.ts test/config.test.ts
git commit -m "feat(cli): parse the index subcommand into its own ParsedCli variant"
```

---

### Task 2: The index runner — wiring, progress, summary, exit code

**Files:**
- Modify: `src/cli-index.ts` (real implementation)
- Modify: `src/cli.ts` (pass through injected deps if `NeuroVaultStartupDependencies` needs an optional `indexDeps` field — keep it optional so server callers are untouched)
- Test: `test/cli-index.test.ts` (new)

**Interfaces:**
- Consumes (from merged own-corpus-indexer PR 2 — verify against `main` before starting):
  ```ts
  // src/lib/obsidian/corpus/reconcile.ts
  reconcileCorpus(deps: ReconcileDeps, opts?: ReconcileOptions): Promise<ReconcileSummary>
  // ReconcileDeps: { vaultRoot; scan; stat; readNote; embed; store; warn? }
  // ReconcileOptions: { onProgress?: (p: { indexed: number; total: number }) => void }
  // ReconcileSummary: { total; embedded; reused; renamed; deleted; failed }
  ```
  Plus existing: `loadVaultScope(vaultRoot)` (src/lib/obsidian/vault-scope-config.ts), `new FsVaultReader({ vaultRoot, scope })`, `new CorpusStore(vaultRoot)`, `new EmbeddingService()` (src/modules/semantic/embedding-service.ts; `.embed(text)`).
- Produces: `runIndexCommand(options, deps): Promise<number>` — the exit code `src/cli.ts` assigns to `process.exitCode`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli-index.test.ts`. Test through injected fakes only:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runIndexCommand, type IndexCommandDeps } from '../src/cli-index.js';

interface FakeStream {
  chunks: string[];
  isTTY: boolean;
  write(s: string): boolean;
}
function fakeStream(isTTY: boolean): FakeStream {
  const chunks: string[] = [];
  return { chunks, isTTY, write: (s) => (chunks.push(s), true) };
}

const vaultA = { name: 'VaultA', path: '/abs/VaultA', smartEnvPath: '/abs/VaultA/.smart-env/multi' };
const vaultB = { name: 'VaultB', path: '/abs/VaultB', smartEnvPath: '/abs/VaultB/.smart-env/multi' };

function okSummary(overrides = {}) {
  return { total: 3, embedded: 3, reused: 0, renamed: 0, deleted: 0, failed: 0, ...overrides };
}

function makeDeps(reconcile: IndexCommandDeps['reconcile'], tty = false) {
  return {
    reconcile,
    createEmbed: () => async () => [0.1, 0.2],
    stdout: fakeStream(tty),
    stderr: fakeStream(false),
  };
}

it('reconciles each vault sequentially with one shared embed function', async () => {
  const calls: string[] = [];
  const embeds: unknown[] = [];
  const reconcile = vi.fn(async (deps) => {
    calls.push(deps.vaultRoot);
    embeds.push(deps.embed);
    return okSummary();
  });
  const deps = makeDeps(reconcile);
  const code = await runIndexCommand({ vaults: [vaultA, vaultB] }, deps);
  expect(code).toBe(0);
  expect(calls).toEqual(['/abs/VaultA', '/abs/VaultB']);
  expect(embeds[0]).toBe(embeds[1]); // one EmbeddingService for the run
});

it('exit code is 1 when any vault has failed notes, summaries still printed', async () => {
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce(okSummary())
    .mockResolvedValueOnce(okSummary({ embedded: 2, failed: 1 }));
  const deps = makeDeps(reconcile);
  const code = await runIndexCommand({ vaults: [vaultA, vaultB] }, deps);
  expect(code).toBe(1);
  const out = deps.stdout.chunks.join('');
  expect(out).toContain('VaultA');
  expect(out).toContain('failed=1');
});

it('a fatal error goes to stderr, later vaults still run, exit code 1', async () => {
  const reconcile = vi
    .fn()
    .mockRejectedValueOnce(new Error('scope exploded'))
    .mockResolvedValueOnce(okSummary());
  const deps = makeDeps(reconcile);
  const code = await runIndexCommand({ vaults: [vaultA, vaultB] }, deps);
  expect(code).toBe(1);
  expect(deps.stderr.chunks.join('')).toContain('scope exploded');
  expect(deps.stdout.chunks.join('')).toContain('VaultB');
});

it('non-TTY progress prints at most one line per 10% step', async () => {
  const reconcile = vi.fn(async (_deps, opts) => {
    for (let i = 1; i <= 100; i++) opts?.onProgress?.({ indexed: i, total: 100 });
    return okSummary({ total: 100, embedded: 100 });
  });
  const deps = makeDeps(reconcile, false);
  await runIndexCommand({ vaults: [vaultA] }, deps);
  const progressLines = deps.stdout.chunks.filter((c) => c.startsWith('indexing'));
  expect(progressLines.length).toBeLessThanOrEqual(11);
});

it('TTY progress rewrites one line in place', async () => {
  const reconcile = vi.fn(async (_deps, opts) => {
    opts?.onProgress?.({ indexed: 1, total: 2 });
    opts?.onProgress?.({ indexed: 2, total: 2 });
    return okSummary({ total: 2, embedded: 2 });
  });
  const deps = makeDeps(reconcile, true);
  await runIndexCommand({ vaults: [vaultA] }, deps);
  const out = deps.stdout.chunks.join('');
  expect(out).toContain('\rindexing VaultA: 1/2');
  expect(out).toContain('\rindexing VaultA: 2/2');
});

it('summary line carries all six counts', async () => {
  const reconcile = vi.fn(async () =>
    okSummary({ total: 5, embedded: 1, reused: 2, renamed: 1, deleted: 3, failed: 0 }),
  );
  const deps = makeDeps(reconcile);
  await runIndexCommand({ vaults: [vaultA] }, deps);
  const out = deps.stdout.chunks.join('');
  expect(out).toMatch(/total=5 embedded=1 reused=2 renamed=1 deleted=3 failed=0/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli-index.test.ts`
Expected: FAIL with `not implemented`.

- [ ] **Step 3: Implement `runIndexCommand`**

Replace `src/cli-index.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { IndexCliOptions } from './config.js';
import type { IVaultConfig } from './types.js';
import { loadVaultScope } from './lib/obsidian/vault-scope-config.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { CorpusStore } from './lib/obsidian/corpus/shard-store.js';
import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileSummary,
} from './lib/obsidian/corpus/reconcile.js';
import type { EmbedFn } from './lib/obsidian/corpus/types.js';
import { EmbeddingService } from './modules/semantic/embedding-service.js';

interface OutStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface IndexCommandDeps {
  reconcile?: (deps: ReconcileDeps, opts?: ReconcileOptions) => Promise<ReconcileSummary>;
  /** One embed function shared by every vault in the run. */
  createEmbed?: () => EmbedFn;
  stdout?: OutStream;
  stderr?: OutStream;
}

function defaultEmbed(): EmbedFn {
  const service = new EmbeddingService();
  return (text) => service.embed(text);
}

function createProgressRenderer(stdout: OutStream, vaultName: string) {
  let lastStep = -1;
  return ({ indexed, total }: { indexed: number; total: number }): void => {
    if (stdout.isTTY) {
      stdout.write(`\rindexing ${vaultName}: ${indexed}/${total}`);
      if (indexed === total) stdout.write('\n');
      return;
    }
    const step = total === 0 ? 10 : Math.floor((indexed / total) * 10);
    if (step > lastStep) {
      lastStep = step;
      stdout.write(`indexing ${vaultName}: ${indexed}/${total}\n`);
    }
  };
}

function writeSummary(stdout: OutStream, vaultName: string, s: ReconcileSummary): void {
  stdout.write(
    `indexed ${vaultName}: total=${s.total} embedded=${s.embedded} reused=${s.reused} ` +
      `renamed=${s.renamed} deleted=${s.deleted} failed=${s.failed}\n`,
  );
}

async function reconcileOne(
  vault: IVaultConfig,
  embed: EmbedFn,
  reconcile: NonNullable<IndexCommandDeps['reconcile']>,
  stdout: OutStream,
): Promise<ReconcileSummary> {
  const scope = await loadVaultScope(vault.path);
  const reader = new FsVaultReader({ vaultRoot: vault.path, scope });
  const store = new CorpusStore(vault.path);
  return reconcile(
    {
      vaultRoot: vault.path,
      scan: () => reader.scan(),
      stat: async (relPath) => {
        const s = await stat(path.join(vault.path, relPath));
        return { mtime: s.mtimeMs, size: s.size };
      },
      readNote: async (relPath) => {
        const abs = path.join(vault.path, relPath);
        const s = await stat(abs);
        const content = await readFile(abs, 'utf8');
        return { content, mtime: s.mtimeMs, size: s.size };
      },
      embed,
      store,
    },
    { onProgress: createProgressRenderer(stdout, vault.name) },
  );
}

export async function runIndexCommand(
  options: IndexCliOptions,
  deps: IndexCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const reconcile = deps.reconcile ?? reconcileCorpus;
  const embed = (deps.createEmbed ?? defaultEmbed)();

  let complete = true;
  for (const vault of options.vaults) {
    try {
      const summary = await reconcileOne(vault, embed, reconcile, stdout);
      writeSummary(stdout, vault.name, summary);
      if (summary.failed > 0) complete = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`index ${vault.name}: ${message}\n`);
      complete = false;
    }
  }
  return complete ? 0 : 1;
}
```

Note the containment contract split: per-note failures are `reconcileCorpus`'s job (counted in `failed`); the try/catch here is for per-vault fatals (bad scope, unreadable corpus dir) and must not stop later vaults.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cli-index.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Guard the server surface**

Add to `test/cli-index.test.ts`:

```ts
it('the index module never imports the server module', async () => {
  const source = await readFile(new URL('../src/cli-index.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from '\.\/server\.js'/);
  expect(source).not.toMatch(/@modelcontextprotocol/);
});
```

(Import `readFile` from `node:fs/promises` at the top of the test file.) This pins the spec's "No server surface is touched" scenario at the module-dependency level; the dispatch test in `test/config.test.ts` already proves the parse never reaches `startNeuroVaultServer` for `index`.

Run: `npx vitest run test/cli-index.test.ts` — Expected: PASS.

- [ ] **Step 6: Full gates, then commit**

Run: `npm test && npm run lint && npm run typecheck && npx openspec validate --all`

```bash
git add src/cli-index.ts src/cli.ts test/cli-index.test.ts
git commit -m "feat(cli): index subcommand reconciles the corpus with progress and honest exit codes"
```

---

### Task 3: Real-vault sanity check (manual, outside the suite)

**Files:** none committed — evidence goes in the PR body.

- [ ] **Step 1: Cold index the real vault**

Run: `npm run dev -- index --vault "$HOME/path/to/real/vault"` (ask the user which vault path to use if not obvious from their MCP config; do NOT commit the path anywhere).
Record: wall-clock, the final summary line, exit code (`echo $?`).

- [ ] **Step 2: Idempotent second run**

Run the same command again immediately.
Expected: summary reports everything `reused=`, `embedded=0`, `deleted=0`, exit 0, and it completes in seconds. Record the summary and exit code.

- [ ] **Step 3: Paste both runs' evidence into the PR body draft**

---

### Task 4: Gates and delivery

- [ ] **Step 1: Full gates one last time**

Run: `npm test && npm run lint && npm run typecheck && npm run build && npx openspec validate --all`
Expected: all green. Paste the output into the PR body.

- [ ] **Step 2: Thinness audit**

Confirm the diff contains: no MCP tool contract change, no watcher, no new entry in `package.json` `dependencies`, no README/docs infrastructure-promise edits. If any appears, stop and remove it — those belong to slice #5 (`own-backend-integration`).

- [ ] **Step 3: Open the PR**

Push the branch and open the PR via `gh pr create` (never push to `main`). PR body: what/why, the gate output, the Task 3 evidence, and `Closes #83`. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: After merge**

Run `/opsx:verify` for this change before archiving. Release (if desired) is `npm run release` on `main` after the merge — never from the branch.
