# Vault Conventions Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a vault's `.neuro-vault/for-external-agents.md` actually reach an external agent — by putting it first in the 2048-character `instructions` budget, and by shipping it in the `get_vault_overview` response, a channel with no cap that also reaches sub-agents.

**Architecture:** One shared reader (`src/lib/obsidian/vault-conventions.ts`) is exposed per vault as `IVaultEntry.readConventions()`, so both channels agree by construction on the path, the trim, and what "absent" means. `computeVaultOverview` takes that reader as an injected dep and emits `conventions` / `conventions_truncated`, which the tool and the `vault://overview` resource inherit unchanged. `buildServerInstructions` emits per-vault blocks first, then a ~600–800-character preamble stripped of everything the tool descriptions already say.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 20, vitest, zod, `@modelcontextprotocol/sdk`.

## Global Constraints

- `npm test`, `npm run lint`, and `npm run typecheck` (`tsc --noEmit`) MUST all pass before any commit. `tsc --noEmit` is authoritative — a clean `tsup` build is not sufficient (ADR-0002).
- Test count must not silently drop (baseline spec).
- Every tool error goes through `ToolHandlerError` → `{ code, message, details }` (ADR-0003).
- All I/O is injected, never imported at module level in compute functions — tests stub deps, they do not mock modules.
- Conventional Commits; commit messages end with the repo's `Co-Authored-By` trailer convention.
- The conventions character cap is **8000**. The truncation marker is `…` (U+2026), matching `PREVIEW_MARKER` in `src/modules/operations/preview-body.ts`.
- Response field names are `conventions` and `conventions_truncated` — decided in design D4; do not rename.
- Never make the overview fail because of the optional conventions file. Missing / empty / whitespace-only / unreadable all mean "absent".

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/lib/obsidian/vault-conventions.ts` | Create | Sole owner of "where conventions live, how they're read, how they're capped". Exports `CONVENTIONS_PATH`, `CONVENTIONS_CHAR_CAP`, `readVaultConventions`, `capConventions`. |
| `test/lib/obsidian/vault-conventions.test.ts` | Create | Unit tests for the above. |
| `src/lib/vault-registry.ts` | Modify | `IVaultEntry.readConventions` + `IVaultEntryDeps.conventionsReaderFactory`. |
| `src/server.ts` | Modify | Drop the local reader; reorder + diet instructions. |
| `src/lib/obsidian/vault-overview.ts` | Modify | `conventions` / `conventions_truncated` on `VaultOverview`; `readConventions` dep. |
| `src/modules/operations/tools/get-vault-overview.ts` | Modify | Pass the reader through both paths; description sentence. |
| `src/modules/operations/resources/vault-overview.ts` | Modify | Pass the reader through. |
| `test/operations/tools/_test-registry.ts` | Modify | Default `readConventions` so existing suites keep working. |
| `docs/architecture/vault-conventions.md` | Create | The one file that explains the concept end to end (ADR-0008). |
| `docs/adr/0010-context-delivery-channels.md` | Create | Why we stopped trusting `instructions`. |

## PR boundaries

This change is **three PRs**, not one. Deliver Task 1–5 first and pause for review before starting Task 6.

- **PR 1 — the overview channel** (Tasks 1–5). Self-contained and shippable: conventions reach every agent, sub-agents included. This is the load-bearing half.
- **PR 2 — the instructions channel** (Tasks 6–7). Independent of PR 1 except for the shared reader from Task 1. This is the only PR that deletes prose, so it deserves its own review.
- **PR 3 — docs and ADR** (Tasks 8–9). Written once both channels' behavior is final.

Tasks 6–7 touch files disjoint from Tasks 2–5 and may be dispatched in parallel once Task 1 has landed.

---

## Task 1: Shared conventions reader

**Files:**
- Create: `src/lib/obsidian/vault-conventions.ts`
- Create: `test/lib/obsidian/vault-conventions.test.ts`
- Modify: `src/server.ts:29-38` (delete `EXTERNAL_AGENT_INSTRUCTIONS_PATH` + `readExternalAgentInstructions`)
- Modify: `test/server-instructions.test.ts:7` (import moves)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CONVENTIONS_PATH: string` — `'.neuro-vault/for-external-agents.md'`
  - `CONVENTIONS_CHAR_CAP: number` — `8000`
  - `readVaultConventions(vaultPath: string, readFile?: ConventionsReadFile): Promise<string | null>`
  - `type ConventionsReadFile = (p: string, enc: 'utf8') => Promise<string>`
  - `capConventions(raw: string): { content: string; truncated: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/lib/obsidian/vault-conventions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  CONVENTIONS_CHAR_CAP,
  CONVENTIONS_PATH,
  capConventions,
  readVaultConventions,
} from '../../../src/lib/obsidian/vault-conventions.js';

describe('readVaultConventions', () => {
  it('reads the conventions file relative to the vault root', async () => {
    const readFile = vi.fn().mockResolvedValue('\n\n# Conventions\n- No writes to Resources/\n\n');
    const result = await readVaultConventions('/vaults/obsidian', readFile);
    expect(result).toBe('# Conventions\n- No writes to Resources/');
    expect(readFile).toHaveBeenCalledWith('/vaults/obsidian/' + CONVENTIONS_PATH, 'utf8');
  });

  it('returns null when the file is missing or unreadable', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    expect(await readVaultConventions('/v', readFile)).toBeNull();
  });

  it('returns null for an empty or whitespace-only file', async () => {
    expect(await readVaultConventions('/v', vi.fn().mockResolvedValue(''))).toBeNull();
    expect(await readVaultConventions('/v', vi.fn().mockResolvedValue('  \n\t\n '))).toBeNull();
  });
});

describe('capConventions', () => {
  it('passes content shorter than the cap through untouched', () => {
    expect(capConventions('short')).toEqual({ content: 'short', truncated: false });
  });

  it('passes content exactly at the cap through untouched', () => {
    const exact = 'x'.repeat(CONVENTIONS_CHAR_CAP);
    expect(capConventions(exact)).toEqual({ content: exact, truncated: false });
  });

  it('trims content over the cap and flags it', () => {
    const over = 'x'.repeat(CONVENTIONS_CHAR_CAP + 1);
    const result = capConventions(over);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(CONVENTIONS_CHAR_CAP + 1);
    expect(result.content.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lib/obsidian/vault-conventions.test.ts`
Expected: FAIL — cannot resolve `src/lib/obsidian/vault-conventions.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/obsidian/vault-conventions.ts`:

```ts
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

/** Vault-relative location of the owner-authored conventions file. */
export const CONVENTIONS_PATH = '.neuro-vault/for-external-agents.md';

/**
 * Soft cap on the conventions text carried in a tool response. Unlike the MCP
 * `instructions` channel there is no client-imposed limit here; the cap exists
 * so one oversized file can't inflate every session start. Trimming is always
 * surfaced via the `truncated` flag — never silent.
 */
export const CONVENTIONS_CHAR_CAP = 8000;

const TRUNCATION_MARKER = '…';

export type ConventionsReadFile = (p: string, enc: 'utf8') => Promise<string>;

/**
 * Best-effort read of a vault's conventions file. Missing, empty,
 * whitespace-only, and unreadable all collapse to `null` — the file is
 * optional and must never turn a working call into an error.
 */
export async function readVaultConventions(
  vaultPath: string,
  readFile: ConventionsReadFile = (p, enc) => fsReadFile(p, enc),
): Promise<string | null> {
  try {
    const raw = await readFile(path.join(vaultPath, CONVENTIONS_PATH), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Bounded slice plus a flag — the same shape as `previewBody`, at a much
 * larger cap. Cuts at the last whitespace inside the cap so the slice ends on
 * a word boundary rather than mid-token.
 */
export function capConventions(raw: string): { content: string; truncated: boolean } {
  if (raw.length <= CONVENTIONS_CHAR_CAP) {
    return { content: raw, truncated: false };
  }
  const segment = raw.slice(0, CONVENTIONS_CHAR_CAP + 1);
  const lastWs = Math.max(segment.lastIndexOf(' '), segment.lastIndexOf('\n'));
  const cutAt = lastWs !== -1 ? lastWs : CONVENTIONS_CHAR_CAP;
  return { content: raw.slice(0, cutAt).trimEnd() + TRUNCATION_MARKER, truncated: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/vault-conventions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Point the server at the shared reader**

In `src/server.ts`, delete lines 29–38 (`EXTERNAL_AGENT_INSTRUCTIONS_PATH` and `readExternalAgentInstructions`), drop the now-unused `fs`/`path` imports if nothing else uses them, and add:

```ts
import { readVaultConventions } from './lib/obsidian/vault-conventions.js';
```

In `buildServerInstructions`, replace `await readExternalAgentInstructions(entry.path)` with `await readVaultConventions(entry.path)`. **Behavior must be identical at this step** — ordering changes land in Task 6.

- [ ] **Step 6: Move the deleted export's tests**

In `test/server-instructions.test.ts`, delete the entire `describe('readExternalAgentInstructions', ...)` block (its cases are now covered by the new unit test) and change the import on line 7 to:

```ts
import { buildServerInstructions } from '../src/server.js';
```

- [ ] **Step 7: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS. The remaining `buildServerInstructions` tests are the guard proving behavior did not change.

- [ ] **Step 8: Commit**

```bash
git add src/lib/obsidian/vault-conventions.ts test/lib/obsidian/vault-conventions.test.ts src/server.ts test/server-instructions.test.ts
git commit -m "refactor(conventions): extract shared vault-conventions reader"
```

---

## Task 2: Per-vault `readConventions` seam

**Files:**
- Modify: `src/lib/vault-registry.ts:10-41` (`IVaultEntry`, `IVaultEntryDeps`), and the entry construction in `VaultRegistry.create`
- Modify: `src/server.ts` (`buildDefaultVaultEntryDeps`, `buildServerInstructions`)
- Modify: `test/lib/vault-registry.test.ts`
- Modify: `test/operations/tools/_test-registry.ts`

**Interfaces:**
- Consumes: `readVaultConventions` from Task 1.
- Produces:
  - `IVaultEntry.readConventions: () => Promise<string | null>` (required, not optional)
  - `IVaultEntryDeps.conventionsReaderFactory: (opts: { vaultRoot: string }) => () => Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Add to `test/lib/vault-registry.test.ts`:

```ts
it('gives each entry a conventions reader bound to its own vault path', async () => {
  const seen: string[] = [];
  const registry = await VaultRegistry.create(
    {
      vaults: [
        { name: 'a', path: '/vaults/a', smartEnvPath: '/vaults/a/.smart-env/multi' },
        { name: 'b', path: '/vaults/b', smartEnvPath: '/vaults/b/.smart-env/multi' },
      ],
      semanticEnabled: false,
      modelKey: 'm',
    },
    {
      ...fakeDeps(),
      conventionsReaderFactory: ({ vaultRoot }) => async () => {
        seen.push(vaultRoot);
        return `conventions for ${vaultRoot}`;
      },
    },
  );

  expect(await registry.require('a').readConventions()).toBe('conventions for /vaults/a');
  expect(await registry.require('b').readConventions()).toBe('conventions for /vaults/b');
  expect(seen).toEqual(['/vaults/a', '/vaults/b']);
});
```

`fakeDeps()` is the suite's existing `IVaultEntryDeps` helper (`test/lib/vault-registry.test.ts:23`) — extend it with a `conventionsReaderFactory` default rather than defining a second one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: FAIL — `conventionsReaderFactory` is not a known property; `readConventions` is not a function.

- [ ] **Step 3: Add the seam**

In `src/lib/vault-registry.ts`, add to `IVaultEntry` (after `listMatchingPaths`):

```ts
  /**
   * Best-effort read of this vault's `.neuro-vault/for-external-agents.md`,
   * bound to this entry's path. Both delivery channels — composed MCP
   * `instructions` and the `get_vault_overview` response — call this one
   * function, so they cannot disagree about the path, the trim, or what
   * "absent" means.
   */
  readConventions: () => Promise<string | null>;
```

Add to `IVaultEntryDeps`:

```ts
  conventionsReaderFactory: (opts: { vaultRoot: string }) => () => Promise<string | null>;
```

In `VaultRegistry.create`, next to the other factory calls:

```ts
      const readConventions = deps.conventionsReaderFactory({ vaultRoot: v.path });
```

and add `readConventions,` to the `entries.push({ ... })` object.

- [ ] **Step 4: Wire the production default**

In `src/server.ts`, inside `buildDefaultVaultEntryDeps`, add before the `...overrides` spread:

```ts
    conventionsReaderFactory:
      ({ vaultRoot }) =>
      () =>
        readVaultConventions(vaultRoot),
```

Then in `buildServerInstructions`, replace `await readVaultConventions(entry.path)` with `await entry.readConventions()`.

- [ ] **Step 5: Keep existing test doubles working**

`IVaultEntry` now has a required member that partial-entry helpers do not set, and calling it would throw at runtime. In `test/operations/tools/_test-registry.ts`, add a default alongside `emptyReader`:

```ts
const noConventions = async (): Promise<string | null> => null;
```

and include it in the entry defaults:

```ts
  const list = entries.map(
    (e) =>
      ({ semanticAvailable: true, reader: emptyReader, readConventions: noConventions, ...e }) as IVaultEntry,
  );
```

Apply the same default to `makeEntry` in `test/operations/resources/vault-overview.test.ts` and to `makeRegistry` in `test/server-instructions.test.ts`.

- [ ] **Step 6: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/vault-registry.ts src/server.ts test/
git commit -m "feat(conventions): expose readConventions per vault entry"
```

---

## Task 3: `conventions` on the overview computation

**Files:**
- Modify: `src/lib/obsidian/vault-overview.ts:23-33` (`VaultOverview`, `ComputeVaultOverviewDeps`) and both `return` sites
- Modify: `test/lib/obsidian/vault-overview.test.ts`

**Interfaces:**
- Consumes: `capConventions`, `CONVENTIONS_CHAR_CAP` (Task 1); `readConventions` signature (Task 2).
- Produces: `VaultOverview` gains optional `conventions?: string` and `conventions_truncated?: true`; `ComputeVaultOverviewDeps` gains `readConventions: () => Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Add to `test/lib/obsidian/vault-overview.test.ts`. The suite's existing `computeVaultOverview({ reader, provider, graph })` calls now need the new dep — add a local default first:

```ts
const noConventions = async (): Promise<string | null> => null;
```

and pass `readConventions: noConventions` in every existing call site. Then add:

```ts
describe('computeVaultOverview conventions', () => {
  it('carries the conventions file content when present', async () => {
    const result = await computeVaultOverview({
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => '# Conventions\n- No writes to Resources/',
    });
    expect(result.conventions).toBe('# Conventions\n- No writes to Resources/');
    expect(result).not.toHaveProperty('conventions_truncated');
  });

  it('omits the key entirely when there are no conventions', async () => {
    const result = await computeVaultOverview({
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => null,
    });
    expect(result).not.toHaveProperty('conventions');
    expect(result).not.toHaveProperty('conventions_truncated');
  });

  it('trims oversized conventions and flags the trim', async () => {
    const huge = 'x '.repeat(CONVENTIONS_CHAR_CAP);
    const result = await computeVaultOverview({
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => huge,
    });
    expect(result.conventions_truncated).toBe(true);
    expect(result.conventions!.length).toBeLessThanOrEqual(CONVENTIONS_CHAR_CAP + 1);
  });

  it('never fails the snapshot when the conventions read rejects', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['Notes/a.md']) });
    const result = await computeVaultOverview({
      reader,
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => {
        throw new Error('EACCES');
      },
    });
    expect(result.total_notes).toBe(1);
    expect(result).not.toHaveProperty('conventions');
  });

  it('re-reads on every call so edits need no restart', async () => {
    let current = 'first';
    const deps = {
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => current,
    };
    expect((await computeVaultOverview(deps)).conventions).toBe('first');
    current = 'second';
    expect((await computeVaultOverview(deps)).conventions).toBe('second');
  });
});
```

Add `CONVENTIONS_CHAR_CAP` to the file's imports from `../../../src/lib/obsidian/vault-conventions.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lib/obsidian/vault-overview.test.ts`
Expected: FAIL — `conventions` is undefined; `readConventions` is not a known dep.

- [ ] **Step 3: Write the implementation**

In `src/lib/obsidian/vault-overview.ts`, add the import:

```ts
import { capConventions } from './vault-conventions.js';
```

Extend the interfaces:

```ts
export interface VaultOverview {
  total_notes: number;
  folders: VaultOverviewFolder[];
  top_tags: VaultOverviewTag[];
  properties: VaultOverviewProperty[];
  top_by_backlinks: VaultOverviewTopNote[];
  /** Raw `.neuro-vault/for-external-agents.md`; absent when the vault has none. */
  conventions?: string;
  /** Present only when `conventions` was trimmed at CONVENTIONS_CHAR_CAP. */
  conventions_truncated?: true;
}

export interface ComputeVaultOverviewDeps {
  reader: VaultReader;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
  readConventions: () => Promise<string | null>;
}
```

Add a private helper:

```ts
// The conventions file is optional decoration on a structural snapshot: a
// rejection here must never cost the caller the snapshot itself.
async function conventionsFields(
  readConventions: () => Promise<string | null>,
): Promise<Pick<VaultOverview, 'conventions' | 'conventions_truncated'>> {
  let raw: string | null;
  try {
    raw = await readConventions();
  } catch {
    return {};
  }
  if (raw === null || raw === '') return {};
  const { content, truncated } = capConventions(raw);
  return truncated ? { conventions: content, conventions_truncated: true } : { conventions: content };
}
```

In `computeVaultOverview`, destructure `readConventions` from deps, resolve it alongside the existing parallel work:

```ts
  const [tags, props, conventions] = await Promise.all([
    provider.listTags(),
    provider.listProperties(),
    conventionsFields(readConventions),
  ]);
```

and spread `...conventions` into **both** return objects — the empty-vault early return at `paths.length === 0` and the main one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/vault-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: `typecheck` will flag the two callers (`get-vault-overview.ts`, `resources/vault-overview.ts`) missing the new required dep. That is expected here and fixed in Task 4 — do not commit until Task 4's step 3 is done if you want a green tree per commit; otherwise commit the pair together at the end of Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/lib/obsidian/vault-overview.ts test/lib/obsidian/vault-overview.test.ts
git commit -m "feat(overview): compute conventions field with soft cap"
```

---

## Task 4: Both overview surfaces carry the field

**Files:**
- Modify: `src/modules/operations/tools/get-vault-overview.ts:21-28` (`runOverviewForEntry`) and the description
- Modify: `src/modules/operations/resources/vault-overview.ts:22-27` (handler)
- Modify: `test/operations/tools/get-vault-overview.test.ts`
- Modify: `test/operations/resources/vault-overview.test.ts`

**Interfaces:**
- Consumes: `VaultOverview.conventions` (Task 3); `IVaultEntry.readConventions` (Task 2).
- Produces: no new exports — the field simply travels through both adapters.

- [ ] **Step 1: Write the failing test**

Add to `test/operations/tools/get-vault-overview.test.ts`:

```ts
it('carries the vault conventions in single-vault mode', async () => {
  const registry = makeTestRegistry([
    {
      name: 'v',
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => '# House rules',
    },
  ]);
  const result = (await buildGetVaultOverviewTool({ registry }).handler({})) as SingleOverview;
  expect(result.conventions).toBe('# House rules');
});

it('gives each fanned-out vault its own conventions', async () => {
  const registry = makeTestRegistry([
    {
      name: 'vault-a',
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => 'rules A',
    },
    {
      name: 'vault-b',
      reader: makeReader(),
      provider: makeProvider(),
      graph: makeGraph(),
      readConventions: async () => null,
    },
  ]);

  const result = (await buildGetVaultOverviewTool({ registry }).handler({})) as {
    results_by_vault: SingleOverview[];
    failed_vaults: Array<{ vault: string }>;
  };

  const byName = new Map(result.results_by_vault.map((r) => [r.vault, r]));
  expect(byName.get('vault-a')!.conventions).toBe('rules A');
  expect(byName.get('vault-b')!).not.toHaveProperty('conventions');
  expect(result.failed_vaults).toEqual([]);
});

it('advertises the conventions field in its description', () => {
  const registry = makeTestRegistry([
    { name: 'v', reader: makeReader(), provider: makeProvider(), graph: makeGraph() },
  ]);
  const description = registerTool(buildGetVaultOverviewTool({ registry })).spec.description;
  expect(description).toMatch(/conventions/i);
  expect(description).toMatch(/follow/i);
});
```

Import `registerTool` from `../../../src/lib/tool-registry.js` — asserting on `spec.description` checks what is actually advertised to the client, not just what the factory holds.

Add to `test/operations/resources/vault-overview.test.ts`:

```ts
it('carries the same conventions field as the tool', async () => {
  const res = buildVaultOverviewResource({
    uri: 'vault://overview',
    entry: makeEntry({ readConventions: async () => '# House rules' }),
  });
  const payload = await res.handler();
  expect(payload.conventions).toBe('# House rules');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/operations/tools/get-vault-overview.test.ts test/operations/resources/vault-overview.test.ts`
Expected: FAIL — `conventions` undefined; description has no match.

- [ ] **Step 3: Wire both adapters**

In `src/modules/operations/tools/get-vault-overview.ts`:

```ts
async function runOverviewForEntry(entry: IVaultEntry): Promise<VaultOverviewRecord> {
  const overview = await computeVaultOverview({
    reader: entry.reader,
    provider: entry.provider,
    graph: entry.graph,
    readConventions: entry.readConventions,
  });
  return overview as VaultOverviewRecord;
}
```

and append this sentence to the description string, before the `describeMultiVault(...)` concatenation:

```
' When the vault owner has written conventions for external agents, the response carries them in `conventions` — treat them as authoritative for this vault and follow them.'
```

In `src/modules/operations/resources/vault-overview.ts`, add `readConventions: entry.readConventions,` to the `computeVaultOverview({ ... })` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/operations`
Expected: PASS.

- [ ] **Step 5: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS — this is the first fully green point since Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/modules/operations test/operations
git commit -m "feat(overview): surface vault conventions on tool and resource"
```

---

## Task 5: End-to-end check against the real vault

**Files:** none modified — this is a manual verification gate closing PR 1.

- [ ] **Step 1: Build and run the server against the real vault**

Run: `npm run build && npm run dev`

- [ ] **Step 2: Call the tool and confirm the field**

Call `get_vault_overview` through the connected client. Confirm `conventions` matches the contents of `<vault>/.neuro-vault/for-external-agents.md`.

- [ ] **Step 3: Confirm freshness without a restart**

Edit `for-external-agents.md` (append a line), call `get_vault_overview` again **without restarting the server**, and confirm the new line appears. This is design D7's promise and cannot be proven by unit tests alone.

- [ ] **Step 4: Open PR 1 and pause**

```bash
gh pr create --title "feat(overview): deliver vault conventions through get_vault_overview" --body "Implements Tasks 1-5 of openspec/changes/vault-conventions-delivery. The instructions reorder (Tasks 6-7) and docs (Tasks 8-9) follow in separate PRs."
```

Stop here for review. Do not start Task 6 until PR 1 is approved.

---

## Task 6: Instructions ordering — conventions first

**Files:**
- Modify: `src/server.ts:140-165` (`buildServerInstructions`)
- Modify: `test/server-instructions.test.ts`

**Interfaces:**
- Consumes: `IVaultEntry.readConventions` (Task 2).
- Produces: no signature change — `buildServerInstructions(registry): Promise<string>` is unchanged; only the composed string's order changes.

- [ ] **Step 1: Write the failing test**

Add to `test/server-instructions.test.ts`. This is the change's load-bearing assertion:

```ts
const CLIENT_INSTRUCTIONS_CAP = 2048;

// A representative real-world conventions file: note-type vocabulary plus a
// couple of folder rules lands around 1,200 characters.
function representativeConventions(): string {
  const body = '- Notes carry a closed `type`: project | task | idea | reflection.\n';
  return '# Vault conventions\n\n' + body.repeat(18);
}

it('keeps a representative conventions block intact inside the client cap', async () => {
  const conventions = representativeConventions();
  expect(conventions.length).toBeGreaterThan(1_000);
  expect(conventions.length).toBeLessThan(1_400);

  const registry = makeRegistry('/vaults/obsidian');
  registry.list = vi.fn(() => [
    { ...registry.list()[0], readConventions: async () => conventions },
  ]) as typeof registry.list;

  const result = await buildServerInstructions(registry);
  const visible = result.slice(0, CLIENT_INSTRUCTIONS_CAP);

  // The contract is what a truncating client actually sees, not the total
  // length: the vault block whole, and the preamble whole, inside the slice.
  expect(visible).toContain(conventions);
  expect(visible).toContain('second brain');
  expect(visible).toContain('ask the user');
});

it('places the conventions block before any server-authored prose', async () => {
  const registry = makeRegistry('/vaults/obsidian');
  registry.list = vi.fn(() => [
    { ...registry.list()[0], readConventions: async () => '# House rules' },
  ]) as typeof registry.list;

  const result = await buildServerInstructions(registry);
  expect(result.indexOf('# House rules')).toBeLessThan(result.indexOf('second brain'));
});

it('emits the preamble alone when a vault has no conventions', async () => {
  const registry = makeRegistry('/vaults/obsidian');
  const result = await buildServerInstructions(registry);
  expect(result).not.toContain('Vault-specific conventions');
  expect(result.trim()).not.toBe('');
});

it('emits one attributed block per vault in multi-vault mode', async () => {
  const registry = makeRegistry('/vaults/obsidian', true);
  const entries = registry.list();
  registry.list = vi.fn(() => [
    { ...entries[0], name: 'alpha', readConventions: async () => 'alpha rules' },
    { ...entries[1], name: 'beta', readConventions: async () => 'beta rules' },
  ]) as typeof registry.list;

  const result = await buildServerInstructions(registry);
  expect(result).toContain('alpha rules');
  expect(result).toContain('beta rules');
  expect(result).toContain('alpha');
  expect(result).toContain('beta');
  expect(result).not.toContain('## Multi-vault mode');
});
```

Update `makeRegistry` in that file to give each entry `readConventions: async () => null` by default (from Task 2 step 5), so the "no conventions" case needs no override.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: FAIL — the conventions block lands past character 11,000, so nothing in `visible` matches it.

- [ ] **Step 3: Reorder the composition**

Rewrite `buildServerInstructions` in `src/server.ts`:

```ts
export async function buildServerInstructions(registry: IVaultRegistry): Promise<string> {
  // Conventions first, deliberately. Claude Code truncates this string at
  // exactly 2048 characters and gives sub-agents none of it, so the only
  // content that must survive is the part no tool description can supply:
  // what this particular vault's owner wants. See ADR-0010 and
  // docs/architecture/vault-conventions.md.
  const blocks: string[] = [];
  for (const entry of registry.list()) {
    const conventions = await entry.readConventions();
    if (conventions !== null && conventions !== '') {
      const heading = registry.isMulti()
        ? `## Vault-specific conventions — ${entry.name}`
        : '## Vault-specific conventions';
      blocks.push(`${heading}\n\n${conventions}`);
    }
  }
  blocks.push(STATIC_SERVER_INSTRUCTIONS);
  return blocks.join('\n\n');
}
```

Delete the `GET_VAULT_OVERVIEW_HINT` constant and its append, and delete the `if (registry.isMulti())` multi-vault section entirely — `describeMultiVault` already puts that contract in every affected tool's description.

- [ ] **Step 4: Run the test — expect partial progress**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: ordering and multi-vault assertions PASS. The `CLIENT_INSTRUCTIONS_CAP` test still FAILS on `expect(visible).toContain('second brain')` — the conventions block is now first, but the 10,803-character preamble behind it is still cut mid-sentence, so the preamble is not intact inside the slice. Task 7 closes it. Do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-instructions.test.ts
git commit -m "fix(instructions): emit vault conventions before server prose"
```

---

## Task 7: Preamble diet

**Files:**
- Modify: `src/server.ts:48-137` (`STATIC_SERVER_INSTRUCTIONS`)
- Modify: tool descriptions under `src/modules/*/tools/` — only if step 1's audit finds orphaned guidance
- Modify: `test/server-instructions.test.ts`

**Interfaces:**
- Consumes: the failing cap assertion from Task 6.
- Produces: `STATIC_SERVER_INSTRUCTIONS` at ~600–800 characters.

- [ ] **Step 1: Audit before deleting**

For each `##`/`###` section of the current `STATIC_SERVER_INSTRUCTIONS`, grep the corresponding tool's `description` and record whether the content already exists there. Write the result as a table in the PR description — this is design D3's guard and the reviewer's evidence that nothing was silently lost.

```bash
grep -n "description:" -A 6 src/modules/operations/tools/query-notes.ts src/modules/semantic/tools/*.ts
```

Sections expected to be already covered: notes/body tools, structured queries, frontmatter properties, tags, wikilink graph, runtime requirements, multi-vault. The `search_notes` §1 query-writing recipe (multi-query arrays, translations, concept extraction) is the likeliest **orphan**.

- [ ] **Step 2: Rehome anything orphaned**

For each orphan, append it to that tool's `description` and assert it on the advertised description:

```ts
it('describes the multi-query recipe on the tool itself', () => {
  const description = registerTool(buildSearchNotesTool(deps)).spec.description;
  expect(description).toMatch(/1-8 strings/);
  expect(description).toMatch(/translation/i);
});
```

- [ ] **Step 3: Write the new preamble**

Replace `STATIC_SERVER_INSTRUCTIONS` in `src/server.ts` with roughly:

```ts
const STATIC_SERVER_INSTRUCTIONS = `\
## About this vault server

This vault is the user's second brain — planning notes, decisions, reflections — and it usually predates and outlives the project in front of you. Before brainstorming, drafting a retrospective, or answering "why did we decide X", look here first; the answer often lives nowhere else.

Exact anchor (path, daily note, tag, frontmatter field) → vault operations. Fuzzy recall or a conceptual question → \`search_notes\`. Each tool's own description carries its parameters, result shape, and multi-vault behavior.

You do not know how the user scopes notes to the current project. Find out in this order: \`get_vault_overview\` (one call: folders, top tags, properties, most-linked notes) → \`search_notes\` on the project name → ask the user.`;
```

Keep it under 800 characters. Verify:

```bash
node -e "const s=require('fs').readFileSync('src/server.ts','utf8');const m=s.match(/const STATIC_SERVER_INSTRUCTIONS = \`\\\\\n([\s\S]*?)\n\`;/);console.log(m[1].length)"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: PASS, including the `CLIENT_INSTRUCTIONS_CAP` assertion that failed at the end of Task 6. If the preamble's wording changed, update the two marker strings (`'second brain'`, `'ask the user'`) to phrases the new text actually contains.

- [ ] **Step 5: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS. If a semantic or operations suite asserts on removed instruction text, update it to assert on the tool description instead — that is the point of the change, not a workaround.

- [ ] **Step 6: Commit and open PR 2**

```bash
git add src/server.ts src/modules test/
git commit -m "perf(instructions): cut preamble to fit the 2048-character budget"
gh pr create --title "fix(instructions): make vault conventions survive the client truncation budget" --body "Implements Tasks 6-7 of openspec/changes/vault-conventions-delivery. Includes the section-by-section audit table showing every deleted section's home in a tool description."
```

---

## Task 8: Architecture doc and ADR

**Files:**
- Create: `docs/architecture/vault-conventions.md`
- Create: `docs/adr/0010-context-delivery-channels.md`
- Modify: `docs/architecture/mcp-server-shape.md:29-35`
- Modify: `docs/adr/INDEX.md`
- Modify: `docs/architecture/README.md` (concept index)

- [ ] **Step 1: Write the architecture doc**

`docs/architecture/vault-conventions.md` must let a reader understand the whole concept from this one file (ADR-0008). Cover: the file's location and that it is optional; both delivery channels and why there are two; the ordering rule and the 2048-character budget with the test that guards it; per-call freshness on the overview versus startup composition for instructions; `CONVENTIONS_CHAR_CAP` and the `conventions_truncated` flag; multi-vault behavior on both channels; and that missing/unreadable degrades to absent, never to an error.

- [ ] **Step 2: Write ADR-0010**

`docs/adr/0010-context-delivery-channels.md`, following `docs/adr/0000-template.md`. Context: the measured 2048-character truncation, the vault block at offset ~11k, sub-agents receiving no instructions at all. Decision: tool descriptions and tool responses are the channels that arrive intact; context that must arrive belongs there, and MCP `instructions` is best-effort. Consequences: instructions carry only what no description carries; new context-delivery features start from a description or a response.

- [ ] **Step 3: Fix the now-wrong layering description**

In `docs/architecture/mcp-server-shape.md`, replace the four-item layering list (lines 29–35) with the new two-layer order and a pointer to `vault-conventions.md`. The current text documents the broken order and reads as a promise the code no longer makes.

- [ ] **Step 4: Update both indexes**

Add the ADR row to `docs/adr/INDEX.md`:

```markdown
| 0010 | [Context reaches agents through tool descriptions and responses](0010-context-delivery-channels.md) | Accepted |
```

Add `vault-conventions.md` to the concept list in `docs/architecture/README.md`, and amend the `mcp-server-shape.md` line there — it currently advertises "server instructions" as that file's territory, which is now this new file's.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture docs/adr
git commit -m "docs: record vault-conventions delivery and ADR-0010"
```

---

## Task 9: Doc sweep and README

**Files:**
- Modify: `README.md:178-180`
- Modify: `docs/guide/*.md` as the sweep finds hits

- [ ] **Step 1: Sweep all of docs/, not just architecture**

Architecture-scoped greps have missed the model-facing guide layer before. Run the whole tree:

```bash
grep -rn "for-external-agents\|Vault-specific conventions\|instructions" docs README.md | grep -v docs/superpowers
```

Read every hit in `docs/guide/` — `routing.md` and `configuration.md` are the likely ones — and check each against the new behavior.

- [ ] **Step 2: Restate the promise in README**

Replace the paragraph at `README.md:180`. The old text promises the content "is appended to the MCP `instructions`", which is exactly the mechanism that failed. The new text should say: the file is delivered two ways — in the `conventions` field of every `get_vault_overview` response (the reliable path, works for sub-agents, picks up edits with no restart), and at the front of the MCP `instructions` where the client renders them at all. Note that clients may truncate instructions around 2048 characters, so the overview is the channel to rely on, and that edits take effect without a server restart.

- [ ] **Step 3: Verify no stale claims remain**

Re-run the grep from step 1 and confirm every remaining hit describes current behavior.

- [ ] **Step 4: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck && npx openspec validate vault-conventions-delivery`
Expected: all PASS / valid.

- [ ] **Step 5: Commit and open PR 3**

```bash
git add README.md docs
git commit -m "docs: state the conventions delivery promise across guide and README"
gh pr create --title "docs: vault conventions delivery" --body "Implements Tasks 8-9 of openspec/changes/vault-conventions-delivery."
```

---

## Self-review notes

- **Spec coverage.** Each requirement in `specs/vault-conventions-delivery/spec.md` maps to a task: truncation budget → Task 6/7; no restatement of descriptions → Task 7; field on both surfaces → Tasks 3–4; absent rather than empty → Task 3; read at call time → Tasks 3 and 5; visible truncation → Tasks 1 and 3; per-vault attribution → Tasks 4 and 6; unreadable never fails → Tasks 1, 3, 4.
- **Known cross-task type dependency.** `computeVaultOverview` gains a required dep in Task 3, which leaves `tsc` red until Task 4 wires the two callers. This is called out in Task 3 step 5 rather than hidden; if a green tree per commit is required, squash Tasks 3 and 4 into one commit.
- **Name consistency check.** `readConventions` (entry member), `conventionsReaderFactory` (deps factory), `readVaultConventions` (module function), `capConventions` (cap helper), `CONVENTIONS_CHAR_CAP`, `CONVENTIONS_PATH`, response fields `conventions` / `conventions_truncated` — used identically in every task above.
