# migrate-off-obsidian-cli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `VaultProvider` method work from disk alone (no `obsidian` CLI, no running Obsidian), by strangler-fig migration inside a new `FsVaultProvider`, ending with deletion of `ObsidianCLIProvider`.

**Architecture:** `FsVaultProvider implements VaultProvider` constructs an `ObsidianCLIProvider` internally and delegates every not-yet-migrated method to it. Groups 2–4 replace delegations with disk implementations built on existing infrastructure (`FsVaultReader.scan/readNotes`, `extractTags`, `readDailyNotesConfig`, `splitRawFrontmatter`/`serializeFrontmatter`, `yaml.parseDocument`, `buildBasenameIndex`). Group 5 deletes the CLI path, its error codes, and the `--obsidian-cli` flag (major release).

**Tech Stack:** TypeScript strict/ESM (imports end in `.js`), Node ≥ 20, vitest, `yaml` (already a dependency — no new deps).

## Global Constraints

- `npm test && npm run lint && npm run typecheck` must pass at every commit point; `npm run typecheck` is authoritative over the tsup build.
- Every tool-visible failure is a `ToolHandlerError` with `{ code, message, details }` (`src/lib/tool-response.js`).
- No new npm dependencies.
- No changes to tool input/output schemas or the MCP parameter dictionary anywhere in this plan.
- Conventional Commits; each Group ships as its own PR to `main` via `gh pr create` (never push to main). Group 5's release is a major version.
- Delta spec to satisfy: `openspec/changes/migrate-off-obsidian-cli/specs/headless-vault-operations/spec.md`. Design rationale: `design.md` (D1–D6).

---

## Group 1 — Skeleton (PR #1, pure refactor)

### Task 1: FsVaultProvider with full delegation

**Files:**
- Create: `src/modules/operations/fs-vault-provider.ts`
- Test: `test/operations/fs-vault-provider.test.ts`

**Interfaces:**
- Consumes: `ObsidianCLIProvider`, `ObsidianCLIProviderOptions` from `./obsidian-cli-provider.js`; `VaultProvider` + method input/result types from `../../lib/obsidian/vault-provider.js`.
- Produces: `export interface FsVaultProviderOptions extends ObsidianCLIProviderOptions {}` and `export class FsVaultProvider implements VaultProvider` — constructor `(opts: FsVaultProviderOptions)`. Later tasks add optional `reader` to the options and replace method bodies one group at a time.

- [ ] **Step 1: Write the failing delegation test**

```ts
// test/operations/fs-vault-provider.test.ts
import { describe, expect, it, vi } from 'vitest';

import { FsVaultProvider } from '../../src/modules/operations/fs-vault-provider.js';

describe('FsVaultProvider delegation', () => {
  it('delegates createNote to the internal CLI provider (same exec seam)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const provider = new FsVaultProvider({ exec });

    const result = await provider.createNote({ name: 'Idea 42', content: 'first thought' });

    expect(exec).toHaveBeenCalledWith(
      'obsidian',
      ['create', 'name=Idea 42', 'content=first thought'],
      { timeout: 10_000 },
    );
    expect(result).toEqual({ path: 'Idea 42' });
  });

  it('delegates readDaily to daily:path + daily:read', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Daily/2026-07-16.md\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '---\nmood: ok\n---\n# Today\n', stderr: '' });
    const provider = new FsVaultProvider({ exec });

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: 'Daily/2026-07-16.md',
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
  });

  it('delegates setProperty, removeProperty, listTags, listProperties', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const provider = new FsVaultProvider({ vaultName: 'V', exec });

    await provider.setProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
      value: 'done',
    });
    await provider.removeProperty({
      identifier: { kind: 'path', value: 'Inbox/x.md' },
      name: 'status',
    });
    await provider.listTags();
    await provider.listProperties();

    expect(exec).toHaveBeenNthCalledWith(
      1,
      'obsidian',
      ['vault=V', 'property:set', 'name=status', 'value=done', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'obsidian',
      ['vault=V', 'property:remove', 'name=status', 'path=Inbox/x.md'],
      { timeout: 10_000 },
    );
    expect(exec).toHaveBeenNthCalledWith(3, 'obsidian', ['vault=V', 'tags', 'counts', 'sort=count', 'format=json'], {
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(
      4,
      'obsidian',
      ['vault=V', 'properties', 'counts', 'sort=count', 'format=json'],
      { timeout: 10_000 },
    );
  });

  it('propagates CLI errors unchanged', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ENOENT' }));
    const provider = new FsVaultProvider({ exec });

    await expect(provider.listTags()).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL — cannot resolve `../../src/modules/operations/fs-vault-provider.js`

- [ ] **Step 3: Implement the delegating class**

```ts
// src/modules/operations/fs-vault-provider.ts
import {
  ObsidianCLIProvider,
  type ObsidianCLIProviderOptions,
} from './obsidian-cli-provider.js';
import type {
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  PropertyListEntry,
  RemovePropertyInput,
  SetPropertyInput,
  TagListEntry,
  VaultProvider,
} from '../../lib/obsidian/vault-provider.js';

export interface FsVaultProviderOptions extends ObsidianCLIProviderOptions {}

/**
 * Disk-direct VaultProvider (strangler fig over ObsidianCLIProvider).
 * Methods without a disk implementation yet delegate to an internal CLI
 * provider; each migration step replaces one delegation. When none remain,
 * the delegate and ObsidianCLIProvider are deleted.
 */
export class FsVaultProvider implements VaultProvider {
  private readonly cli: ObsidianCLIProvider;

  constructor(opts: FsVaultProviderOptions = {}) {
    this.cli = new ObsidianCLIProvider(opts);
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    return this.cli.createNote(input);
  }

  async readDaily(): Promise<DailyNoteResult> {
    return this.cli.readDaily();
  }

  async setProperty(input: SetPropertyInput): Promise<void> {
    return this.cli.setProperty(input);
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    return this.cli.removeProperty(input);
  }

  async listProperties(): Promise<PropertyListEntry[]> {
    return this.cli.listProperties();
  }

  async listTags(): Promise<TagListEntry[]> {
    return this.cli.listTags();
  }
}
```

Note: `ObsidianCLIProvider` currently exports the class and the options interface — confirm the interface is exported (`export interface ObsidianCLIProviderOptions` at `src/modules/operations/obsidian-cli-provider.ts:28`; it is).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider.test.ts
git commit -m "feat(operations): add FsVaultProvider delegating to ObsidianCLIProvider"
```

### Task 2: Wire FsVaultProvider as the provider

**Files:**
- Modify: `src/server.ts:15` (import) and `src/server.ts:179-180` (factory)

**Interfaces:**
- Consumes: `FsVaultProvider` from Task 1.
- Produces: `buildDefaultVaultEntryDeps().providerFactory` returns `FsVaultProvider`; `IVaultEntryDeps.providerFactory` signature unchanged.

- [ ] **Step 1: Swap the wiring**

In `src/server.ts` replace the import

```ts
import { ObsidianCLIProvider } from './modules/operations/obsidian-cli-provider.js';
```

with

```ts
import { FsVaultProvider } from './modules/operations/fs-vault-provider.js';
```

and in `buildDefaultVaultEntryDeps` replace

```ts
    providerFactory: ({ vaultName, vaultRoot, binaryPath }) =>
      new ObsidianCLIProvider({ vaultName, vaultRoot, binaryPath }),
```

with

```ts
    providerFactory: ({ vaultName, vaultRoot, binaryPath }) =>
      new FsVaultProvider({ vaultName, vaultRoot, binaryPath }),
```

- [ ] **Step 2: Full verification (zero behavior change expected)**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green, no test edits needed anywhere else.

- [ ] **Step 3: Commit and open PR #1**

```bash
git add src/server.ts
git commit -m "refactor(server): wire FsVaultProvider as the vault provider"
```

Branch + `gh pr create` per repo flow. Merge before starting Group 2.

---

## Group 2 — Scan leg: listTags / listProperties (PR #2)

### Task 3: Thread reader into the provider factory

**Files:**
- Modify: `src/lib/vault-registry.ts:32-36` (factory opts type), `src/lib/vault-registry.ts:86-90` (call site)
- Modify: `src/server.ts` (factory lambda)
- Modify: `src/modules/operations/fs-vault-provider.ts` (options + field)
- Test: `test/lib/vault-registry.test.ts` (extend existing factory-stub assertions)

**Interfaces:**
- Consumes: `VaultReader` type from `src/lib/obsidian/vault-reader.js`.
- Produces: `providerFactory: (opts: { vaultName: string; vaultRoot: string; binaryPath?: string; reader: VaultReader }) => VaultProvider`; `FsVaultProviderOptions` gains `reader?: VaultReader`; `FsVaultProvider` gains `private readonly reader: VaultReader | undefined` and `private requireReader(): VaultReader` (throws plain `Error('FsVaultProvider: reader not wired')` — production wiring always passes it).

- [ ] **Step 1: Extend the vault-registry test** — in `test/lib/vault-registry.test.ts`, find the existing test that stubs `providerFactory` and assert the factory now receives the reader instance created by `readerFactory`:

```ts
it('passes the vault reader to providerFactory', async () => {
  const seen: unknown[] = [];
  const deps = makeDeps({
    providerFactory: (opts) => {
      seen.push(opts.reader);
      return fakeProvider;
    },
  });
  await VaultRegistry.create(configWithOneVault, deps);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBe(fakeReader); // the instance readerFactory returned
});
```

Adapt `makeDeps`/`fakeProvider`/`fakeReader` names to the helpers already present in that file — extend, don't restructure.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: FAIL — `opts.reader` is `undefined` (and typecheck flags the opts type)

- [ ] **Step 3: Implement threading** — `IVaultEntryDeps.providerFactory` opts gain `reader: VaultReader`; in `VaultRegistry.create` pass `reader` (already in scope at line 82); in `src/server.ts` the lambda becomes

```ts
    providerFactory: ({ vaultName, vaultRoot, binaryPath, reader }) =>
      new FsVaultProvider({ vaultName, vaultRoot, binaryPath, reader }),
```

and in `fs-vault-provider.ts`:

```ts
import type { VaultReader } from '../../lib/obsidian/vault-reader.js';

export interface FsVaultProviderOptions extends ObsidianCLIProviderOptions {
  reader?: VaultReader;
}
```

with constructor body gaining `this.reader = opts.reader;` and

```ts
  private requireReader(): VaultReader {
    if (!this.reader) throw new Error('FsVaultProvider: reader not wired');
    return this.reader;
  }
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/vault-registry.ts src/server.ts src/modules/operations/fs-vault-provider.ts test/lib/vault-registry.test.ts
git commit -m "feat(operations): thread vault reader into providerFactory"
```

### Task 4: Disk implementations of listTags / listProperties

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts`
- Test: `test/operations/fs-vault-provider.test.ts`

**Interfaces:**
- Consumes: `requireReader()` from Task 3; `extractTags` from `src/lib/obsidian/query/note-record.js`; `ReadNotesItemSuccess` from `src/lib/obsidian/vault-reader.js`.
- Produces: `listTags()`/`listProperties()` no longer touch the CLI; ordering contract: count descending, then name ascending.

- [ ] **Step 1: Write failing tests** (temp-dir fixture, real fs — same style as `test/operations/obsidian-cli-provider.test.ts` uses `mkdtemp`):

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fs-provider-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}

describe('FsVaultProvider.listTags / listProperties (disk)', () => {
  it('counts frontmatter tags only, ignoring inline #tags', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha, beta]\n---\nbody #inline\n',
      'b.md': '---\ntags: alpha\n---\n',
      'c.md': 'no frontmatter #beta\n',
    });
    const exec = vi.fn(); // must never be called
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec });

    const tags = await provider.listTags();

    expect(tags).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 1 },
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('counts each frontmatter key once per note', async () => {
    const root = await makeVault({
      'a.md': '---\nstatus: todo\npriority: 2\n---\n',
      'b.md': '---\nstatus: done\n---\n',
    });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    const props = await provider.listProperties();

    expect(props).toEqual([
      { name: 'status', count: 2 },
      { name: 'priority', count: 1 },
    ]);
  });

  it('returns [] for a vault with no frontmatter', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    expect(await provider.listTags()).toEqual([]);
    expect(await provider.listProperties()).toEqual([]);
  });
});
```

Also DELETE the two delegation expectations for `listTags`/`listProperties` from Task 1's third test (keep `setProperty`/`removeProperty` delegation assertions).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL — exec called / results not equal

- [ ] **Step 3: Implement**

```ts
import { extractTags } from '../../lib/obsidian/query/note-record.js';

  async listProperties(): Promise<PropertyListEntry[]> {
    const counts = new Map<string, number>();
    for (const fm of await this.scanFrontmatter()) {
      for (const key of Object.keys(fm)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return sortCounts(counts);
  }

  async listTags(): Promise<TagListEntry[]> {
    const counts = new Map<string, number>();
    for (const fm of await this.scanFrontmatter()) {
      for (const tag of extractTags(fm)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return sortCounts(counts);
  }

  private async scanFrontmatter(): Promise<Array<Record<string, unknown>>> {
    const reader = this.requireReader();
    const paths = await reader.scan();
    const items = await reader.readNotes({ paths, fields: ['frontmatter'] });
    return items
      .filter((i): i is ReadNotesItemSuccess => !('error' in i))
      .map((i) => i.frontmatter ?? {});
  }
```

with a module-level helper:

```ts
function sortCounts(counts: Map<string, number>): Array<{ name: string; count: number }> {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
```

(`ReadNotesItemSuccess` is a type import from `../../lib/obsidian/vault-reader.js`.)

- [ ] **Step 4: Headless overview test** — append to the same test file:

```ts
import { computeVaultOverview } from '../../src/lib/obsidian/vault-overview.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';

it('get_vault_overview core is fully populated with a dead CLI', async () => {
  const root = await makeVault({ 'Tasks/a.md': '---\ntags: [alpha]\nstatus: todo\n---\n' });
  const reader = new FsVaultReader({ vaultRoot: root });
  const exec = vi.fn().mockRejectedValue(Object.assign(new Error('spawn obsidian ENOENT'), { code: 'ENOENT' }));
  const provider = new FsVaultProvider({ vaultRoot: root, reader, exec });
  const graph = new WikilinkGraphIndex({ reader });

  const overview = await computeVaultOverview({ reader, provider, graph });

  expect(overview.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
  expect(overview.properties).toEqual([
    { name: 'status', count: 1 },
    { name: 'tags', count: 1 },
  ]);
});
```

(Adjust the `properties` expectation if `extractTags`-style ordering differs — the invariant is: both sections populated, `exec` never succeeds.)

- [ ] **Step 5: Verify all + commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider.test.ts
git commit -m "feat(operations): disk-direct listTags and listProperties in FsVaultProvider"
```

Open PR #2.

---

## Group 3 — Daily leg: readDaily (PR #3)

Code-derived characterization of the CLI path (replaces a live-Obsidian probe): `ObsidianCLIProvider.readDaily` runs `daily:path` then `daily:read` (`obsidian-cli-provider.ts:127-133`); a missing note makes `daily:read` fail and `mapExecError` maps `/not found/i` stderr → `ToolHandlerError('NOT_FOUND')` with no path in details (`obsidian-cli-provider.ts:276-281`). The fs implementation keeps code `NOT_FOUND` and adds `details.path` (a strict superset — the tool contract's "create at the returned path" guidance becomes reliable). `DAILY_NOTES_NOT_CONFIGURED` is already thrown pre-provider by the `read_daily` tool's preflight (`read-daily.ts:52`), and `notes_today` is already scan-based (`read-daily.ts:55-66`) — confirmed, nothing else joins this leg.

### Task 5: Moment-format renderer for daily basenames

**Files:**
- Create: `src/lib/obsidian/daily-note-path.ts`
- Test: `test/lib/obsidian/daily-note-path.test.ts`

**Interfaces:**
- Consumes: `ToolHandlerError` from `src/lib/tool-response.js`.
- Produces: `export function formatDailyDate(format: string, date: Date): string` — renders moment tokens `YYYY`, `YY`, `MM`, `M`, `DD`, `D`, passes `[bracketed]` literals and non-alphabetic characters (including `/`) through, throws `ToolHandlerError('DAILY_NOTES_NOT_CONFIGURED')` on any other alphabetic token.

- [ ] **Step 1: Write failing tests**

```ts
// test/lib/obsidian/daily-note-path.test.ts
import { describe, expect, it } from 'vitest';

import { formatDailyDate } from '../../../src/lib/obsidian/daily-note-path.js';

const d = new Date(2026, 6, 16); // 2026-07-16 local

describe('formatDailyDate', () => {
  it('renders the Obsidian default', () => {
    expect(formatDailyDate('YYYY-MM-DD', d)).toBe('2026-07-16');
  });
  it('renders folder-splitting formats', () => {
    expect(formatDailyDate('YYYY/MM/YYYY-MM-DD', d)).toBe('2026/07/2026-07-16');
  });
  it('renders short tokens and two-digit year', () => {
    expect(formatDailyDate('D.M.YY', d)).toBe('16.7.26');
  });
  it('passes bracketed literals through', () => {
    expect(formatDailyDate('[day-]YYYY-MM-DD', d)).toBe('day-2026-07-16');
  });
  it('rejects unsupported tokens with DAILY_NOTES_NOT_CONFIGURED', () => {
    expect(() => formatDailyDate('YYYY-MMMM-DD', d)).toThrowError(
      expect.objectContaining({ code: 'DAILY_NOTES_NOT_CONFIGURED' }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/lib/obsidian/daily-note-path.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/lib/obsidian/daily-note-path.ts
import { ToolHandlerError } from '../tool-response.js';

/**
 * Minimal moment-format renderer for Daily Notes basenames. Supports the
 * tokens Obsidian's default configs use (YYYY, YY, MM, M, DD, D), bracketed
 * literals, and passes every non-alphabetic character (e.g. '/', '-', '.')
 * through. Any other alphabetic token is a config this server cannot
 * resolve headlessly → DAILY_NOTES_NOT_CONFIGURED, same code the rest of
 * the daily preflight uses.
 */
export function formatDailyDate(format: string, date: Date): string {
  let out = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === '[') {
      const close = format.indexOf(']', i + 1);
      if (close === -1) throw unsupported(format, '[');
      out += format.slice(i + 1, close);
      i = close + 1;
    } else if (format.startsWith('YYYY', i)) {
      out += String(date.getFullYear()).padStart(4, '0');
      i += 4;
    } else if (format.startsWith('YY', i)) {
      out += String(date.getFullYear() % 100).padStart(2, '0');
      i += 2;
    } else if (format.startsWith('MM', i)) {
      out += String(date.getMonth() + 1).padStart(2, '0');
      i += 2;
    } else if (ch === 'M') {
      out += String(date.getMonth() + 1);
      i += 1;
    } else if (format.startsWith('DD', i)) {
      out += String(date.getDate()).padStart(2, '0');
      i += 2;
    } else if (ch === 'D') {
      out += String(date.getDate());
      i += 1;
    } else if (/[A-Za-z]/.test(ch)) {
      throw unsupported(format, ch);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function unsupported(format: string, token: string): ToolHandlerError {
  return new ToolHandlerError(
    'DAILY_NOTES_NOT_CONFIGURED',
    `Daily Notes format "${format}" uses token "${token}" this server cannot render headlessly. ` +
      `Supported: YYYY, YY, MM, M, DD, D, [bracketed literals], and separators.`,
    { details: { format, token } },
  );
}
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run test/lib/obsidian/daily-note-path.test.ts`
Expected: PASS

```bash
git add src/lib/obsidian/daily-note-path.ts test/lib/obsidian/daily-note-path.test.ts
git commit -m "feat(obsidian): minimal moment-format renderer for daily note paths"
```

### Task 6: Disk implementation of readDaily

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts`
- Test: `test/operations/fs-vault-provider.test.ts`

**Interfaces:**
- Consumes: `readDailyNotesConfig(vaultRoot)` from `src/lib/obsidian/daily-notes-config.js`; `formatDailyDate` from Task 5; `splitFrontmatter` from `src/lib/obsidian/frontmatter.js`; node `readFile`.
- Produces: `readDaily()` no longer touches the CLI. Result parity: `{ path, frontmatter, content }`; missing config → `DAILY_NOTES_NOT_CONFIGURED` (via `readDailyNotesConfig`); missing today-note → `ToolHandlerError('NOT_FOUND')` with `details: { path }`. Adds `private requireVaultRoot(): string` (throws plain `Error` — always wired in production).

- [ ] **Step 1: Write failing tests** (uses the `makeVault` helper from Task 4; compute today's basename with the same local-date logic to stay timezone-safe):

```ts
function todayBasename(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${day}`;
}

describe('FsVaultProvider.readDaily (disk)', () => {
  it('reads today\'s note per daily-notes.json without the CLI', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
      [`Daily/${todayBasename()}.md`]: '---\nmood: ok\n---\n# Today\n',
    });
    const exec = vi.fn();
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec });

    const result = await provider.readDaily();

    expect(result).toEqual({
      path: `Daily/${todayBasename()}.md`,
      frontmatter: { mood: 'ok' },
      content: '# Today\n',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails DAILY_NOTES_NOT_CONFIGURED when config is absent', async () => {
    const root = await makeVault({ 'a.md': 'x' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await expect(provider.readDaily()).rejects.toMatchObject({ code: 'DAILY_NOTES_NOT_CONFIGURED' });
  });

  it('fails NOT_FOUND with the resolved path when today\'s note is missing', async () => {
    const root = await makeVault({
      '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}',
    });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await expect(provider.readDaily()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { path: `Daily/${todayBasename()}.md` },
    });
  });
});
```

Also DELETE Task 1's `readDaily` delegation test.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readDailyNotesConfig } from '../../lib/obsidian/daily-notes-config.js';
import { formatDailyDate } from '../../lib/obsidian/daily-note-path.js';
import { splitFrontmatter } from '../../lib/obsidian/frontmatter.js';
import { ToolHandlerError } from '../../lib/tool-response.js';

  async readDaily(): Promise<DailyNoteResult> {
    const vaultRoot = this.requireVaultRoot();
    const config = await readDailyNotesConfig(vaultRoot);
    const relPath = `${config.folder}/${formatDailyDate(config.format, new Date())}.md`;

    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, relPath), 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new ToolHandlerError(
          'NOT_FOUND',
          `Today's daily note does not exist yet: ${relPath}. Create it with create_note at this path.`,
          { details: { path: relPath }, cause: err },
        );
      }
      throw new ToolHandlerError('READ_FAILED', `Failed to read ${relPath}: ${(err as Error).message}`, {
        details: { path: relPath },
        cause: err,
      });
    }

    const { frontmatter, content } = splitFrontmatter(raw);
    return { path: relPath, frontmatter, content };
  }

  private requireVaultRoot(): string {
    if (this.vaultRootOpt === undefined) throw new Error('FsVaultProvider: vaultRoot not wired');
    return this.vaultRootOpt;
  }
```

with the constructor storing `private readonly vaultRootOpt: string | undefined` from `opts.vaultRoot`.

- [ ] **Step 4: Verify all + commit + PR #3**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS (existing `test/operations/tools/read-daily.test.ts` stubs the provider, so it stays green)

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider.test.ts
git commit -m "feat(operations): disk-direct readDaily in FsVaultProvider"
```

---

## Group 4 — Write leg: createNote / setProperty / removeProperty (PR #4)

### Task 7: Disk implementation of createNote

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts`
- Test: `test/operations/fs-vault-provider.test.ts`

**Interfaces:**
- Consumes: `normalizeNotePath` from `src/lib/obsidian/note-path.js`; node `writeFile`/`mkdir`/`readFile`.
- Produces: `createNote()` no longer touches the CLI. Semantics: `path` input is used as-is (the tool layer already normalized it); `name` input resolves via `.obsidian/app.json` (`newFileLocation`/`newFileFolderPath`: `'folder'` + non-empty path → that folder; anything else → vault root) then `normalizeNotePath`; existing file without `overwrite` → `NOTE_EXISTS`; parent directories are created (`mkdir recursive` — a deliberate improvement over the CLI, which could not create folders); content written verbatim (spec: no template expansion).

- [ ] **Step 1: Write failing tests**

```ts
describe('FsVaultProvider.createNote (disk)', () => {
  it('writes content verbatim and creates parent folders', async () => {
    const root = await makeVault({});
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    const result = await provider.createNote({ path: 'Deep/Nested/x.md', content: '---\na: 1\n---\nbody\n' });

    expect(result).toEqual({ path: 'Deep/Nested/x.md' });
    expect(await readFile(path.join(root, 'Deep/Nested/x.md'), 'utf8')).toBe('---\na: 1\n---\nbody\n');
  });

  it('fails NOTE_EXISTS without overwrite, succeeds with it', async () => {
    const root = await makeVault({ 'x.md': 'old' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await expect(provider.createNote({ path: 'x.md', content: 'new' })).rejects.toMatchObject({ code: 'NOTE_EXISTS' });
    await provider.createNote({ path: 'x.md', content: 'new', overwrite: true });
    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('new');
  });

  it('resolves name via app.json newFileFolderPath', async () => {
    const root = await makeVault({
      '.obsidian/app.json': '{"newFileLocation":"folder","newFileFolderPath":"Inbox"}',
    });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    const result = await provider.createNote({ name: 'Idea 42' });

    expect(result).toEqual({ path: 'Inbox/Idea 42.md' });
  });

  it('resolves name to vault root without app.json', async () => {
    const root = await makeVault({});
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    expect(await provider.createNote({ name: 'Idea' })).toEqual({ path: 'Idea.md' });
  });
});
```

(`readFile` joins the existing node imports at the top of the test file.) Also DELETE Task 1's `createNote` delegation tests.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
import { mkdir, writeFile } from 'node:fs/promises';

import { normalizeNotePath } from '../../lib/obsidian/note-path.js';

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const vaultRoot = this.requireVaultRoot();
    if (input.name === undefined && input.path === undefined) {
      throw new Error('createNote requires name or path');
    }
    const relPath = input.path ?? normalizeNotePath(await this.newNoteDir(vaultRoot) + input.name!);
    const absPath = path.join(vaultRoot, relPath);

    await mkdir(path.dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, input.content ?? '', { encoding: 'utf8', flag: input.overwrite ? 'w' : 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new ToolHandlerError(
          'NOTE_EXISTS',
          'Note already exists. Pass overwrite: true after confirming with the user.',
          { details: { path: relPath }, cause: err },
        );
      }
      throw new ToolHandlerError('CREATE_FAILED', `Failed to write ${relPath}: ${(err as Error).message}`, {
        details: { path: relPath },
        cause: err,
      });
    }
    return { path: relPath };
  }

  /** '' or 'Folder/' prefix for name-identified new notes, per .obsidian/app.json. */
  private async newNoteDir(vaultRoot: string): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(path.join(vaultRoot, '.obsidian/app.json'), 'utf8');
    } catch {
      return '';
    }
    try {
      const parsed = JSON.parse(raw) as { newFileLocation?: string; newFileFolderPath?: string };
      if (parsed.newFileLocation === 'folder' && typeof parsed.newFileFolderPath === 'string') {
        const folder = parsed.newFileFolderPath.trim().replace(/\/+$/, '');
        if (folder !== '') return `${folder}/`;
      }
    } catch {
      /* malformed app.json → vault root */
    }
    return '';
  }
```

Note: the `'wx'` write flag makes the exists-check atomic (no TOCTOU); the `NOTE_EXISTS` message text matches the CLI mapping (`obsidian-cli-provider.ts:248-254`) so tool-layer behavior is unchanged.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider.test.ts
git commit -m "feat(operations): disk-direct createNote in FsVaultProvider"
```

### Task 8: Disk implementations of setProperty / removeProperty

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts`
- Test: `test/operations/fs-vault-provider.test.ts`

**Interfaces:**
- Consumes: `parseDocument` from `yaml`; `splitRawFrontmatter` from `src/lib/obsidian/in-place-edit.js`; `serializeFrontmatter` from `src/lib/obsidian/frontmatter.js`; `buildBasenameIndex` from `src/lib/obsidian/link-resolver.js`; `normalizeNotePath`; `requireReader()`.
- Produces: `setProperty()`/`removeProperty()` no longer touch the CLI; the internal `cli` field has no remaining callers (Group 5 deletes it). Semantics: identifier `kind:'path'` → `normalizeNotePath`; `kind:'name'` → basename-index resolution over `reader.scan()` (`NOT_FOUND` when unresolvable); YAML round-trip via `parseDocument` preserves comments/formatting of untouched keys; body preserved byte-for-byte; `removeProperty` of an absent key does not rewrite the file; removing the last key strips the block; unparsable existing YAML → `READ_FAILED`; `.obsidian/types.json` never touched (spec).

- [ ] **Step 1: Write failing tests**

```ts
describe('FsVaultProvider.setProperty / removeProperty (disk)', () => {
  const byPath = (p: string) => ({ kind: 'path' as const, value: p });

  it('sets a property preserving body bytes and neighbor formatting', async () => {
    const src = '---\n# keep me\nstatus: todo\n---\nbody stays\r\nexactly\n';
    const root = await makeVault({ 'x.md': src });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'priority', value: 2 });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toContain('# keep me');
    expect(out).toContain('priority: 2');
    expect(out.endsWith('body stays\r\nexactly\n')).toBe(true);
  });

  it('creates a frontmatter block when the note has none', async () => {
    const root = await makeVault({ 'x.md': 'just body\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'status', value: 'todo' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('---\nstatus: todo\n---\njust body\n');
  });

  it('writes real YAML lists for array values', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'tags', value: ['alpha', 'beta'], type: 'list' });

    const out = await readFile(path.join(root, 'x.md'), 'utf8');
    expect(out).toMatch(/tags:\n\s+- alpha\n\s+- beta/);
  });

  it('removeProperty is idempotent on absent keys (no rewrite)', async () => {
    const src = '---\nstatus:   todo   # odd spacing preserved\n---\n';
    const root = await makeVault({ 'x.md': src });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'missing' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe(src);
  });

  it('removes a property; removing the last key strips the block', async () => {
    const root = await makeVault({ 'x.md': '---\nstatus: todo\n---\nbody\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.removeProperty({ identifier: byPath('x.md'), name: 'status' });

    expect(await readFile(path.join(root, 'x.md'), 'utf8')).toBe('body\n');
  });

  it('resolves kind:name via the basename index', async () => {
    const root = await makeVault({ 'Deep/Idea 42.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.setProperty({ identifier: { kind: 'name', value: 'Idea 42' }, name: 'a', value: 2 });

    expect(await readFile(path.join(root, 'Deep/Idea 42.md'), 'utf8')).toContain('a: 2');
  });

  it('never touches .obsidian/types.json', async () => {
    const root = await makeVault({ 'x.md': '---\na: 1\n---\n' });
    const provider = new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }), exec: vi.fn() });

    await provider.setProperty({ identifier: byPath('x.md'), name: 'due', value: '2026-08-01', type: 'date' });

    await expect(readFile(path.join(root, '.obsidian/types.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

Also DELETE Task 1's remaining delegation tests (`setProperty`/`removeProperty`/CLI-error propagation) — after this task nothing delegates.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
import { parseDocument } from 'yaml';

import { splitRawFrontmatter } from '../../lib/obsidian/in-place-edit.js';
import { serializeFrontmatter } from '../../lib/obsidian/frontmatter.js';
import { buildBasenameIndex } from '../../lib/obsidian/link-resolver.js';

  async setProperty(input: SetPropertyInput): Promise<void> {
    await this.editFrontmatter(input.identifier, (doc) => {
      doc.set(input.name, input.value);
      return true;
    });
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    await this.editFrontmatter(input.identifier, (doc) => {
      if (!doc.has(input.name)) return false;
      doc.delete(input.name);
      return true;
    });
  }

  /** Shared read → mutate YAML document → write path. `mutate` returns false to skip the write. */
  private async editFrontmatter(
    identifier: NoteIdentifier,
    mutate: (doc: ReturnType<typeof parseDocument>) => boolean,
  ): Promise<void> {
    const vaultRoot = this.requireVaultRoot();
    const relPath = await this.resolveIdentifierPath(identifier);
    const absPath = path.join(vaultRoot, relPath);

    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new ToolHandlerError('NOT_FOUND', `Note not found: ${relPath}`, {
          details: { path: relPath },
          cause: err,
        });
      }
      throw new ToolHandlerError('READ_FAILED', `Failed to read ${relPath}: ${(err as Error).message}`, {
        details: { path: relPath },
        cause: err,
      });
    }

    const { prefix, body } = splitRawFrontmatter(raw);
    const yamlBody = prefix === '' ? '' : sliceYamlBody(prefix);
    const doc = parseDocument(yamlBody === '' ? '{}' : yamlBody);
    if (doc.errors.length > 0) {
      throw new ToolHandlerError(
        'READ_FAILED',
        `Frontmatter of ${relPath} is not valid YAML; fix the note before editing properties.`,
        { details: { path: relPath, errors: doc.errors.map((e) => e.message) } },
      );
    }

    if (!mutate(doc)) return;

    const contents = doc.contents;
    const isEmptyMap =
      contents === null || (typeof contents === 'object' && 'items' in contents && contents.items.length === 0);
    let newPrefix: string;
    if (isEmptyMap) {
      newPrefix = '';
    } else if (yamlBody === '') {
      // The note had no frontmatter: serialize the fresh object cleanly.
      newPrefix = serializeFrontmatter(doc.toJS() as Record<string, unknown>);
    } else {
      newPrefix = `---\n${doc.toString()}---\n`;
    }
    await writeFile(absPath, newPrefix + body, 'utf8');
  }

  private async resolveIdentifierPath(identifier: NoteIdentifier): Promise<string> {
    if (identifier.kind === 'path') return normalizeNotePath(identifier.value);
    const index = buildBasenameIndex(await this.requireReader().scan());
    const resolved = index.resolve(identifier.value);
    if (resolved === null) {
      throw new ToolHandlerError('NOT_FOUND', `Note not found: ${identifier.value}`, {
        details: { name: identifier.value },
      });
    }
    return resolved;
  }
```

with the module-level helper (same fence slicing as `splitFrontmatter` at `frontmatter.ts:18-21`):

```ts
function sliceYamlBody(prefix: string): string {
  const firstEol = prefix.indexOf('\n');
  const lastFence = prefix.lastIndexOf('---');
  return prefix.slice(firstEol + 1, lastFence);
}
```

Add `NoteIdentifier` to the type imports from `../../lib/obsidian/vault-provider.js`. Note: `parseDocument('{}')` for the no-frontmatter case gives `doc.has/set/delete` a valid map; the fresh-block branch uses `serializeFrontmatter` so new blocks look exactly like `create_note`'s.

- [ ] **Step 4: Headless smoke + full verify + commit + PR #4**

Smoke (spec "Vault operations run without Obsidian"): in a shell where `obsidian` is not on PATH, against a scratch copy of a vault:

```bash
PATH=/usr/bin:/bin npx tsx src/cli.ts --vault /absolute/path/to/scratch-vault --semantic false
```

then drive `create_note`, `read_daily`, `set_property`, `list_tags`, `get_vault_overview` through an MCP client (or the repo's usual manual harness) and confirm no `CLI_NOT_FOUND`/`CLI_UNAVAILABLE` surfaces.

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider.test.ts
git commit -m "feat(operations): disk-direct property writes and createNote identifier resolution"
```

---

## Group 5 — Remove the CLI path (PR #5, major)

### Task 9: Delete ObsidianCLIProvider, the flag, and the CLI error codes

**Files:**
- Delete: `src/modules/operations/obsidian-cli-provider.ts`, `test/operations/obsidian-cli-provider.test.ts`
- Modify: `src/modules/operations/fs-vault-provider.ts` (drop the `cli` field and `ObsidianCLIProviderOptions` inheritance), `src/modules/operations/index.ts` (drop the `ObsidianCLIProviderOptions` import in `IOperationsModuleDeps.vaultProviderFactory`), `src/lib/vault-registry.ts` (drop `binaryPath` from factory opts and `IVaultRegistryConfig`), `src/server.ts` (factory lambda; instructions section), `src/config.ts` (drop `--obsidian-cli`), `src/types.ts` (drop `obsidianCli` from `ServerConfig`)
- Modify: `src/modules/operations/tools/set-property.ts` (description text referencing obsidian-cli), `test/config.test.ts`, `test/server-instructions.test.ts`
- Test: `test/operations/fs-vault-provider.test.ts` (error-code sweep)

**Interfaces:**
- Produces: `FsVaultProviderOptions` becomes `{ vaultRoot: string; reader: VaultReader }` (both required; `requireReader`/`requireVaultRoot` guards go away in favor of plain fields); `providerFactory` opts become `{ vaultName: string; vaultRoot: string; reader: VaultReader }`.

- [ ] **Step 1: Write the failing error-code sweep test**

```ts
import { readFile as readSrc } from 'node:fs/promises';

it('no CLI_* error codes remain in src/', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const grep = promisify(execFile);
  // grep exits 1 when nothing matches — that is the PASS condition.
  await expect(
    grep('grep', ['-rE', 'CLI_NOT_FOUND|CLI_UNAVAILABLE|CLI_TIMEOUT', 'src/']),
  ).rejects.toMatchObject({ code: 1 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/operations/fs-vault-provider.test.ts`
Expected: FAIL — grep finds matches in `obsidian-cli-provider.ts`

- [ ] **Step 3: Delete and simplify**

1. `git rm src/modules/operations/obsidian-cli-provider.ts test/operations/obsidian-cli-provider.test.ts`
2. `fs-vault-provider.ts`: remove the `cli` field, the `ObsidianCLIProvider` import, and the `extends ObsidianCLIProviderOptions`; the options become

```ts
export interface FsVaultProviderOptions {
  vaultRoot: string;
  reader: VaultReader;
}
```

with `private readonly vaultRoot: string` / `private readonly reader: VaultReader` and the `requireReader`/`requireVaultRoot` helpers inlined away. Update every test constructor call accordingly (`exec`/`vaultName` arguments disappear; assertions like `expect(exec).not.toHaveBeenCalled()` are deleted).
3. `src/modules/operations/index.ts`: `vaultProviderFactory?: (opts: ObsidianCLIProviderOptions) => VaultProvider` → `vaultProviderFactory?: (opts: FsVaultProviderOptions) => VaultProvider` (import from `./fs-vault-provider.js`).
4. `src/lib/vault-registry.ts`: remove `binaryPath` from `providerFactory` opts and `IVaultRegistryConfig`; `src/server.ts`: factory lambda becomes `({ vaultName, vaultRoot, reader }) => new FsVaultProvider({ vaultRoot, reader })` — keep `vaultName` in the opts type (other consumers may use it) even though `FsVaultProvider` no longer takes it.
5. `src/config.ts`: delete the `.option('obsidian-cli', …)` block and the `obsidianCli: args['obsidian-cli']` line; `src/types.ts`: delete `obsidianCli` from `ServerConfig`; `src/server.ts`: delete `binaryPath: config.obsidianCli`.
6. `src/server.ts` instructions: replace the whole `### CLI availability` section (lines 98-100) with:

```
### Runtime requirements

All vault tools read and write the vault directory directly on disk — Obsidian does not need to be installed or running. Concurrent edits from a live Obsidian session are safe for reads; for writes, the last writer wins per file.
```

7. `src/modules/operations/tools/set-property.ts` description: replace "non-ISO values are silently dropped by obsidian-cli, so this tool rejects them up front" with "non-ISO values are rejected up front"; replace "List items must not contain commas (obsidian-cli limitation)." with "List items must not contain commas." (validation itself stays — dropping it would be a separate contract decision).
8. Fix `test/config.test.ts` (remove `--obsidian-cli` cases; add one asserting it now fails as unknown option) and `test/server-instructions.test.ts` (assert the new Runtime requirements text).

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: PASS; grep sweep test now green

```bash
git add -A
git commit -m "feat(operations)!: remove ObsidianCLIProvider and the --obsidian-cli flag

BREAKING CHANGE: the server no longer shells out to obsidian-cli. The
--obsidian-cli option is removed (launch commands passing it fail to start)
and the CLI_NOT_FOUND/CLI_UNAVAILABLE/CLI_TIMEOUT error codes no longer occur."
```

### Task 10: Docs — ADR, architecture, README

**Files:**
- Create: `docs/adr/` next-numbered ADR (check `docs/adr/INDEX.md` for the number)
- Modify: `docs/adr/INDEX.md`, `docs/architecture/` files referencing obsidian-cli (`grep -ril obsidian-cli docs/`), `README.md` (installation/requirements sections mentioning obsidian-cli or "Obsidian must be running")

- [ ] **Step 1: Mint the ADR** — title: "Vault operations go direct to disk (supersedes ADR-0007)". Status: Accepted. Context: headless VPS deployment; strangler-fig migration completed in change `migrate-off-obsidian-cli`. Decision: all `VaultProvider` methods read/write the vault directory; no external processes for vault operations (ADR-0004's execFile rule stays for any future external process). Consequences: no Obsidian runtime dependency; accepted divergences — frontmatter-only tag counts, no `types.json` registration, no template expansion; `--obsidian-cli` removed (major). Mark ADR-0007 as superseded in both its file header and `INDEX.md`.

- [ ] **Step 2: Sweep remaining references**

Run: `grep -ril "obsidian-cli\|obsidian cli" docs/ README.md`
Update every hit: `docs/architecture/` files state the disk-direct mechanism as current state; README drops the obsidian-cli prerequisite.

- [ ] **Step 3: Verify + commit + PR #5**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add docs/ README.md
git commit -m "docs: record disk-direct vault operations, supersede ADR-0007"
```

After merge: `npm run release` on `main` (major).

---

## Self-review notes (already applied)

- Spec coverage: "run without Obsidian" → Tasks 4-8 + smoke (Task 8 Step 4); "overview populated" → Task 4 Step 4; "frontmatter-only counts" → Task 4; "daily-notes.json + DAILY_NOTES_NOT_CONFIGURED + missing-note parity" → Tasks 5-6; "write methods + byte-identical body + idempotent remove" → Tasks 7-8; "verbatim content / no types.json" → Tasks 7-8; "no external process / flag rejected / no CLI codes" → Task 9 (sweep test + config test).
- Type consistency: `FsVaultProviderOptions` evolves Task 1 (`extends ObsidianCLIProviderOptions`) → Task 3 (`+ reader?`) → Task 9 (`{ vaultRoot; reader }` required) — each later task states the change explicitly.
- The `NoteIdentifier`/`normalizeNotePath` pairing mirrors what the tool layer already guarantees; provider-side normalization is defensive only.
