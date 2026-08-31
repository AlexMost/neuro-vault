# Consolidate Disk Writes Into One Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one module own every note write over a vault root, with one name ⊕ path rule resolved at one depth and one filesystem-error taxonomy for notes that already exist.

**Architecture:** `FsVaultProvider` absorbs `FsVaultWriter`'s two edit methods and the shared read/write helpers, then sheds `listTags` / `listProperties` to free functions over a `VaultReader`. Write tools stop resolving names themselves and hand a `NoteIdentifier` down; the module resolves it in one of two named modes — `resolveExisting` (find it) or `resolveNew` (place it). `IVaultEntry` loses its `writer`.

**Tech Stack:** TypeScript ESM (Node ≥ 20, `isolatedModules`), vitest, zod-backed MCP tool registration, `node:fs/promises`.

**Spec:** `openspec/changes/consolidate-vault-writes/` — `proposal.md` (why), `design.md` (decisions D1–D10, risks), `specs/headless-vault-operations/spec.md` (the delta this plan must satisfy), `tasks.md` (task groups).

## Global Constraints

- `npm test`, `npm run lint`, and `npm run typecheck` must all pass before any commit or PR. `npm run typecheck` (`tsc --noEmit`) is authoritative — a `tsup` build alone is not enough (`isolatedModules`).
- Tool tests reach a tool through `registerTool(buildXTool(deps))` plus `callTool` / `expectToolError` from `test/_gate.ts` — never `buildXTool(deps).handler`. The only exception is a test whose subject *is* the `CallToolResult` envelope, which calls `reg.handler` directly and carries a comment saying so (ADR-0015).
- ESM: every relative import ends in `.js`, including from `.ts` sources.
- Nothing under `src/lib/` may import from `src/modules/`.
- Error codes are contract surface (ADR-0003). Every failure crossing the tool boundary carries `{ code, message, details }`.
- Tool parameter names are fixed (ADR-0005). No schema, output shape, or client-visible code changes in this plan.
- Commits use conventional-commit prefixes and end with the `Co-Authored-By` trailer for the session's primary model.
- PRs go to `main` via `gh pr create` — never push to `main` directly.

---

# Group 1 — Fold the writer into the disk module (PR 1)

Tasks 1–6. Sequential: each leaves the tree green and typechecking. Tasks 1–2 are additive; task 3 switches the consumer; tasks 4 and 5 are type changes that ship with every call site they break.

## Task 1: Shared fs helpers and the injection seam

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts:1-60` (options, constructor), `:200-275` (`editFrontmatter`)
- Modify: `test/operations/fs-vault-provider/_helpers.ts:22-24`
- Test: `test/operations/fs-vault-provider/fs-errors.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FsReadFile` / `FsWriteFile` type aliases and the optional `readFile` / `writeFile` fields on `FsVaultProviderOptions`; private `readRaw(relPath): Promise<string>` and `writeRaw(relPath, data): Promise<void>` on `FsVaultProvider`. Tasks 2 and 5 build on both. `makeProvider(root, fs?)` in the test helper.

- [ ] **Step 1: Write the failing test**

Create `test/operations/fs-vault-provider/fs-errors.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { byPath, makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider: one fs-error taxonomy over existing notes', () => {
  it('maps a failing write to WRITE_FAILED on setProperty', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      writeFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
      ),
    });

    await expect(
      provider.setProperty({ identifier: byPath('n.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });

  it('maps a failing write to WRITE_FAILED on removeProperty', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      writeFile: vi.fn().mockRejectedValue(new Error('EROFS: read-only file system')),
    });

    await expect(
      provider.removeProperty({ identifier: byPath('n.md'), name: 'a' }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });

  it('maps a non-ENOENT read failure to READ_FAILED', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      readFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      ),
    });

    await expect(
      provider.setProperty({ identifier: byPath('n.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'READ_FAILED', details: { path: 'n.md' } });
  });

  it('still maps ENOENT to NOT_FOUND', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    await expect(
      provider.setProperty({ identifier: byPath('missing.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'missing.md' } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/operations/fs-vault-provider/fs-errors.test.ts`
Expected: FAIL — `makeProvider` takes one argument, so the injected `writeFile`/`readFile` are ignored and the writes succeed.

- [ ] **Step 3: Widen the test helper**

Replace `test/operations/fs-vault-provider/_helpers.ts:21-24` with:

```typescript
/** Build an FsVaultProvider backed by a real FsVaultReader over `root`. */
export function makeProvider(
  root: string,
  fs: { readFile?: FsReadFile; writeFile?: FsWriteFile } = {},
): FsVaultProvider {
  return new FsVaultProvider({
    vaultRoot: root,
    reader: new FsVaultReader({ vaultRoot: root }),
    ...fs,
  });
}
```

Add to the import block at the top of that file:

```typescript
import type {
  FsReadFile,
  FsWriteFile,
} from '../../../src/modules/operations/fs-vault-provider.js';
```

- [ ] **Step 4: Add the seam and the helpers to the module**

In `src/modules/operations/fs-vault-provider.ts`, replace the `FsVaultProviderOptions` interface and the constructor block (`:42-60`) with:

```typescript
export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;
export type FsWriteFile = (absPath: string, data: string, encoding: 'utf8') => Promise<void>;

export interface FsVaultProviderOptions {
  vaultRoot: string;
  reader: VaultReader;
  /**
   * Note-file read/write, injectable so the `READ_FAILED` / `WRITE_FAILED`
   * branches are reachable without making a temp vault unwritable. Covers the
   * existing-note paths only; `createNote` writes with its own flags and its
   * own taxonomy (design D5/D6).
   */
  readFile?: FsReadFile;
  writeFile?: FsWriteFile;
}
```

and in the class body:

```typescript
  private readonly reader: VaultReader;
  private readonly vaultRoot: string;
  private readonly readFileFn: FsReadFile;
  private readonly writeFileFn: FsWriteFile;

  constructor(opts: FsVaultProviderOptions) {
    this.reader = opts.reader;
    this.vaultRoot = opts.vaultRoot;
    this.readFileFn = opts.readFile ?? ((p, enc) => readFile(p, enc));
    this.writeFileFn = opts.writeFile ?? ((p, d, enc) => writeFile(p, d, enc));
  }
```

Add the two private helpers (place them next to `resolveIdentifierPath`):

```typescript
  /** Read one existing note. The single ENOENT → NOT_FOUND mapping. */
  private async readRaw(relPath: string): Promise<string> {
    try {
      return await this.readFileFn(path.join(this.vaultRoot, relPath), 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new ToolHandlerError('NOT_FOUND', `Note not found: ${relPath}`, {
          details: { path: relPath },
          cause: err,
        });
      }
      throw new ToolHandlerError(
        'READ_FAILED',
        `Failed to read ${relPath}: ${(err as Error).message}`,
        { details: { path: relPath }, cause: err },
      );
    }
  }

  /** Overwrite one existing note. The single WRITE_FAILED mapping. */
  private async writeRaw(relPath: string, data: string): Promise<void> {
    try {
      await this.writeFileFn(path.join(this.vaultRoot, relPath), data, 'utf8');
    } catch (err) {
      throw new ToolHandlerError(
        'WRITE_FAILED',
        `Failed to write ${relPath}: ${(err as Error).message}`,
        { details: { path: relPath }, cause: err },
      );
    }
  }
```

- [ ] **Step 5: Route `editFrontmatter` through them**

In `editFrontmatter`, delete the `absPath` local and both inline try/catch blocks (`:207-227` and `:266-274`), leaving:

```typescript
    const relPath = await this.resolveIdentifierPath(identifier);
    const raw = await this.readRaw(relPath);
```

and at the end:

```typescript
    await this.writeRaw(relPath, newPrefix + body);
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/operations/fs-vault-provider/`
Expected: PASS — the four new cases plus every existing `set-property` / `remove-property` case, untouched.

- [ ] **Step 7: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider/
git commit -m "refactor(operations): one fs-error mapping for existing-note reads and writes"
```

---

## Task 2: `replaceInNote` / `replaceFullBody` on the provider

**Files:**
- Modify: `src/lib/obsidian/vault-provider.ts` (input types + interface)
- Modify: `src/modules/operations/fs-vault-provider.ts` (implementation, rename `resolveIdentifierPath` → `resolveExisting`)
- Test: `test/operations/fs-vault-provider/edit-note.test.ts` (create)

**Interfaces:**
- Consumes: `readRaw` / `writeRaw` and `makeProvider(root, fs?)` from Task 1.
- Produces: `VaultProvider.replaceInNote(input: ReplaceInNoteInput)` and `.replaceFullBody(input: ReplaceFullBodyInput)`, both `Promise<void>`, both keyed on `identifier: NoteIdentifier`. Task 3 calls them. Private `resolveExisting(identifier): Promise<string>`, which Task 5's `resolveNew` sits beside.

Additive: `FsVaultWriter` still exists and still serves `edit_note` after this task, so the tree stays green.

- [ ] **Step 1: Write the failing test**

Create `test/operations/fs-vault-provider/edit-note.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { byName, byPath, makeProvider, makeVault } from './_helpers.js';

const WITH_FM = '---\ntitle: T\n---\nalpha\nbeta\n';

describe('FsVaultProvider.replaceFullBody', () => {
  it('rewrites the body and preserves frontmatter byte-for-byte', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    await makeProvider(root).replaceFullBody({ identifier: byPath('n.md'), content: 'new\n' });

    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('---\ntitle: T\n---\nnew\n');
  });

  it('fails NOT_FOUND when the note does not exist', async () => {
    const root = await makeVault({});

    await expect(
      makeProvider(root).replaceFullBody({ identifier: byPath('missing.md'), content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'missing.md' } });
  });

  it('fails WRITE_FAILED when the write rejects', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    const provider = makeProvider(root, {
      writeFile: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
    });

    await expect(
      provider.replaceFullBody({ identifier: byPath('n.md'), content: 'x' }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });
});

describe('FsVaultProvider.replaceInNote', () => {
  it('swaps the single match and preserves frontmatter', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });
    await makeProvider(root).replaceInNote({
      identifier: byPath('n.md'),
      find: 'alpha',
      content: 'gamma',
    });

    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('---\ntitle: T\n---\ngamma\nbeta\n');
  });

  it('fails NOT_FOUND when the find text is absent from the body', async () => {
    const root = await makeVault({ 'n.md': WITH_FM });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'nope', content: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'n.md' } });
  });

  it('fails AMBIGUOUS_MATCH with line numbers when the find text repeats', async () => {
    const root = await makeVault({ 'n.md': '---\ntitle: T\n---\ndup\ndup\n' });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'dup', content: 'x' }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_MATCH', details: { matches: [1, 2] } });
  });

  it('does not write when the find text is ambiguous', async () => {
    const root = await makeVault({ 'n.md': '---\ntitle: T\n---\ndup\ndup\n' });

    await expect(
      makeProvider(root).replaceInNote({ identifier: byPath('n.md'), find: 'dup', content: 'x' }),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('---\ntitle: T\n---\ndup\ndup\n');
  });
});

describe('FsVaultProvider: name-addressed edits resolve like every other write', () => {
  it('resolves a unique basename to its path', async () => {
    const root = await makeVault({ 'Folder/Uniq.md': 'body\n' });
    await makeProvider(root).replaceFullBody({ identifier: byName('Uniq'), content: 'new\n' });

    expect(await readFile(path.join(root, 'Folder/Uniq.md'), 'utf8')).toBe('new\n');
  });

  it('fails AMBIGUOUS_MATCH on a shared basename and writes nothing', async () => {
    const root = await makeVault({ 'A/Dup.md': 'a\n', 'B/Dup.md': 'b\n' });

    await expect(
      makeProvider(root).replaceFullBody({ identifier: byName('Dup'), content: 'new\n' }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_MATCH' });
    expect(await readFile(path.join(root, 'A/Dup.md'), 'utf8')).toBe('a\n');
    expect(await readFile(path.join(root, 'B/Dup.md'), 'utf8')).toBe('b\n');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/operations/fs-vault-provider/edit-note.test.ts`
Expected: FAIL — `provider.replaceFullBody is not a function`.

- [ ] **Step 3: Move the input types onto the provider contract**

In `src/lib/obsidian/vault-provider.ts`, add below `NoteIdentifier`:

```typescript
export interface ReplaceInNoteInput {
  identifier: NoteIdentifier;
  find: string;
  content: string;
}

export interface ReplaceFullBodyInput {
  identifier: NoteIdentifier;
  content: string;
}
```

and add two members to the `VaultProvider` interface:

```typescript
  replaceInNote(input: ReplaceInNoteInput): Promise<void>;
  replaceFullBody(input: ReplaceFullBodyInput): Promise<void>;
```

- [ ] **Step 4: Implement on `FsVaultProvider`**

Rename the private `resolveIdentifierPath` to `resolveExisting` (update its one caller in `editFrontmatter`), add its doc comment, and add the two methods:

```typescript
  /**
   * Resolve an identifier for a note that must already exist: `kind: 'path'`
   * normalizes, `kind: 'name'` goes through the scoped basename index —
   * NOT_FOUND on no match, AMBIGUOUS_MATCH on several, never a silent
   * first-match write. `createNote` uses `resolveNew` instead (design D3).
   */
  private async resolveExisting(identifier: NoteIdentifier): Promise<string> {
    if (identifier.kind === 'path') return normalizeNotePath(identifier.value);
    return resolveNoteName(this.reader, identifier.value);
  }

  async replaceInNote(input: ReplaceInNoteInput): Promise<void> {
    const relPath = await this.resolveExisting(input.identifier);
    const { prefix, body } = splitRawFrontmatter(await this.readRaw(relPath));

    const result = applyReplace(body, input.find, input.content);
    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        throw new ToolHandlerError('NOT_FOUND', `Find text not present in body of ${relPath}`, {
          details: { path: relPath },
        });
      }
      throw new ToolHandlerError(
        'AMBIGUOUS_MATCH',
        `Find text matched ${result.lines.length} times in ${relPath} at lines ${result.lines.join(', ')}; make 'replace' more specific (extend the anchor with surrounding text) or omit it to rewrite the whole body`,
        { details: { path: relPath, matches: result.lines } },
      );
    }

    await this.writeRaw(relPath, prefix + result.body);
  }

  async replaceFullBody(input: ReplaceFullBodyInput): Promise<void> {
    const relPath = await this.resolveExisting(input.identifier);
    const { prefix } = splitRawFrontmatter(await this.readRaw(relPath));
    await this.writeRaw(relPath, prefix + input.content);
  }
```

Extend the existing `in-place-edit.js` import to `import { applyReplace, splitRawFrontmatter } from '../../lib/obsidian/in-place-edit.js';`, and add `ReplaceFullBodyInput` / `ReplaceInNoteInput` to the `vault-provider.js` type import.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/operations/fs-vault-provider/`
Expected: PASS, all cases.

- [ ] **Step 6: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/lib/obsidian/vault-provider.ts src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider/edit-note.test.ts
git commit -m "feat(operations): move in-place note edits onto the disk provider"
```

---
## Task 3: `edit_note` hands down an identifier

**Files:**
- Modify: `src/modules/operations/tools/edit-note.ts:50-96`
- Test: `test/operations/tools/edit-note.test.ts` (rewrite the rig and the envelope block)

**Interfaces:**
- Consumes: `provider.replaceInNote` / `.replaceFullBody` from Task 2; `resolveIdentifier(name, path): NoteIdentifier` from `src/modules/operations/tool-helpers.ts`.
- Produces: nothing new. After this task `entry.writer` has no consumer, which is what Task 4 deletes.

- [ ] **Step 1: Write the failing tests**

Replace the rig at the top of `test/operations/tools/edit-note.test.ts:1-21` with:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { registerTool } from '../../../src/lib/tool-registry.js';
import { buildEditNoteTool } from '../../../src/modules/operations/tools/edit-note.js';
import { FsVaultProvider } from '../../../src/modules/operations/fs-vault-provider.js';
import { callTool } from '../../_gate.js';
import { makeProvider, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildTool(
  overrides: {
    reader?: ReturnType<typeof makeReader>;
    provider?: ReturnType<typeof makeProvider>;
  } = {},
) {
  const reader = overrides.reader ?? makeReader();
  const provider = overrides.provider ?? makeProvider();
  const registry = makeTestRegistry([{ name: 'v', reader, provider }]);
  const tool = buildEditNoteTool({ registry });
  return { tool, reader, provider };
}
```

Then update every `expect(writer.replaceInNote).toHaveBeenCalledWith({ path: ... })` assertion to the identifier form, e.g. the first test becomes:

```typescript
  it('routes to provider.replaceInNote with a path identifier and returns { vault }', async () => {
    const { tool, provider } = buildTool();
    const result = await callTool(registerTool(tool), {
      path: 'Notes/x.md',
      content: 'new',
      replace: 'old',
    });
    expect(provider.replaceInNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      find: 'old',
      content: 'new',
    });
    expect(provider.replaceFullBody).not.toHaveBeenCalled();
    expect(result).toEqual({ vault: 'v' });
  });
```

Add the new case design §Risks calls for — the ordering change is deliberate, so pin it:

```typescript
  // The tool now validates its arguments before any disk I/O, so a malformed
  // `replace` is reported even when the identifier would not have resolved.
  // Previously `edit_note` resolved name -> path first and reported NOT_FOUND.
  it('rejects empty replace before resolving an unresolvable name', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue([]) });
    const { tool, provider } = buildTool({ reader });

    await expect(
      callTool(registerTool(tool), { name: 'Nope', content: 'y', replace: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'replace' } });
    expect(provider.replaceInNote).not.toHaveBeenCalled();
  });
```

And pin that name resolution now happens below the tool:

```typescript
  it('passes a name identifier down unresolved', async () => {
    const { tool, provider } = buildTool();
    await callTool(registerTool(tool), { name: '  Foo  ', content: 'body' });

    expect(provider.replaceFullBody).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'Foo' },
      content: 'body',
    });
  });
```

Delete the existing "rejects unresolved name with NOT_FOUND" test at `:97-103` — resolution is no longer the tool's job, and Task 2's `test/operations/fs-vault-provider/edit-note.test.ts` covers it where it now lives.

- [ ] **Step 2: Rebuild the envelope block against the provider**

Replace `buildWithFailingDisk` at `test/operations/tools/edit-note.test.ts:145-161` with:

```typescript
  function buildWithFailingDisk() {
    const provider = new FsVaultProvider({
      vaultRoot: '/vault',
      reader: makeReader(),
      readFile: vi.fn().mockResolvedValue('---\nx: y\n---\nold body\n'),
      writeFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }),
      ),
    });
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), provider }]);
    return registerTool(buildEditNoteTool({ registry }));
  }
```

Keep both `it(...)` bodies and both "Intentionally handler-direct" comments verbatim — their subject is still the `CallToolResult` envelope. Update the block comment above `buildWithFailingDisk` to say `FsVaultProvider` rather than `FsVaultWriter`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/operations/tools/edit-note.test.ts`
Expected: FAIL — the handler still calls `entry.writer`, so `provider.replaceInNote` is never called.

- [ ] **Step 4: Rewrite the handler**

Replace the handler body of `src/modules/operations/tools/edit-note.ts:50-79` with:

```typescript
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'edit_note' });
      const identifier = resolveIdentifier(input.name, input.path);

      if (input.replace !== undefined) {
        if (input.replace === '') {
          throw invalidArgument('replace must not be empty', 'replace');
        }
        await entry.provider.replaceInNote({
          identifier,
          find: input.replace,
          content: input.content,
        });
      } else {
        await entry.provider.replaceFullBody({ identifier, content: input.content });
      }

      return { vault: entry.name };
    },
```

Delete the `resolveToPath` function entirely (`:83-96`). Fix the imports: `import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';`, and drop the now-unused `normalizeNotePath`, `resolveNoteName`, and `VaultReader` imports.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/operations/tools/edit-note.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/modules/operations/tools/edit-note.ts test/operations/tools/edit-note.test.ts
git commit -m "refactor(edit-note): resolve the target identifier at one depth"
```

---

## Task 4: Delete `FsVaultWriter` and `IVaultEntry.writer`

**Files:**
- Delete: `src/lib/obsidian/vault-writer.ts`, `test/lib/obsidian/vault-writer.test.ts`
- Modify: `src/lib/vault-registry.ts:4,24,61,127,155`; `src/server.ts:11,94`; `test/operations/tools/_helpers.ts:5,28-34`; `test/lib/vault-registry.test.ts:29,209`; `test/operations/tools.test.ts:7,34`; `test/operations/operations-module.test.ts:7,31`; `test/operations/resources/vault-overview.test.ts:6`

**Interfaces:**
- Consumes: Task 3 removed the last consumer of `entry.writer`.
- Produces: an `IVaultEntry` with no `writer` and an `IVaultEntryDeps` with no `writerFactory`.

This is a type change. Every call site it breaks ships in the same commit — `npm run typecheck` is the gate that finds them, and splitting them across commits leaves the tree unbuildable.

- [ ] **Step 1: Write the failing test**

In `test/lib/vault-registry.test.ts`, replace the `expect(entry.writer).toBeDefined();` assertion at `:209` with:

```typescript
    expect('writer' in entry).toBe(false);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/vault-registry.test.ts`
Expected: FAIL — the entry still carries a `writer`.

- [ ] **Step 3: Strip the field from the registry**

In `src/lib/vault-registry.ts`: delete the `VaultWriter` type import (`:4`), the `writer: VaultWriter;` field (`:24`), the `writerFactory` member of `IVaultEntryDeps` (`:61`), the `const writer = deps.writerFactory(...)` line (`:127`), and `writer,` from the `entries.push({...})` literal (`:155`).

In `src/server.ts`: delete the `FsVaultWriter` import (`:11`) and the `writerFactory: ({ vaultRoot }) => new FsVaultWriter({ vaultRoot }),` line (`:94`).

- [ ] **Step 4: Delete the module and its unit test**

```bash
git rm src/lib/obsidian/vault-writer.ts test/lib/obsidian/vault-writer.test.ts
```

Every behaviour that file tested is covered by `test/operations/fs-vault-provider/edit-note.test.ts` from Task 2 — confirm that before deleting, case by case.

- [ ] **Step 5: Strip the field from every test rig**

In `test/operations/tools/_helpers.ts`: delete the `VaultWriter` type import (`:5`) and the whole `makeWriter` function (`:28-34`). Add the two new methods to `makeProvider` so the stub still satisfies the interface:

```typescript
export function makeProvider(overrides: Partial<VaultProvider> = {}): VaultProvider {
  return {
    createNote: vi.fn().mockResolvedValue({ path: '' }),
    readDaily: vi.fn().mockResolvedValue({ path: '', frontmatter: null, content: '' }),
    setProperty: vi.fn().mockResolvedValue(undefined),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    replaceInNote: vi.fn().mockResolvedValue(undefined),
    replaceFullBody: vi.fn().mockResolvedValue(undefined),
    listProperties: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
```

In `test/lib/vault-registry.test.ts:29` delete the `writerFactory` line. In `test/operations/tools.test.ts` (`:7,34`), `test/operations/operations-module.test.ts` (`:7,31`), and `test/operations/resources/vault-overview.test.ts` (`:6`) delete the `VaultWriter` imports, the `as unknown as VaultWriter` stubs, and the `writer:` entry fields.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS with zero references to `VaultWriter` remaining. If typecheck names a construction site not listed above, fix it in this same commit.

- [ ] **Step 7: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add -A src/lib src/server.ts test/
git commit -m "refactor(vault): delete the VaultWriter seam and IVaultEntry.writer"
```

---

## Task 5: `create_note` onto the one rule

**Files:**
- Modify: `src/lib/obsidian/vault-provider.ts` (`CreateNoteInput`)
- Modify: `src/modules/operations/fs-vault-provider.ts:62-115` (`createNote`, add `resolveNew`)
- Modify: `src/modules/operations/tools/create-note.ts:59-99`
- Test: `test/operations/fs-vault-provider/create-note.test.ts`, `test/operations/tools/create-note.test.ts`

**Interfaces:**
- Consumes: `resolveIdentifier` from `tool-helpers.ts`; `resolveExisting`'s sibling slot from Task 2.
- Produces: `CreateNoteInput = { identifier: NoteIdentifier; content?: string; overwrite?: boolean }`; private `resolveNew(identifier): Promise<string>`. This is the last write tool to move, so after it every write tool passes a `NoteIdentifier`.

Type change: the interface and both test files ship in one commit.

- [ ] **Step 1: Write the failing tests**

Add to `test/operations/tools/create-note.test.ts`:

```typescript
  it('reports the path field when both name and path are supplied', async () => {
    const provider = makeProvider();
    await expect(
      callTool(buildReg(provider), { name: 'A', path: 'a.md', content: '' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { field: 'path' },
    });
    expect(provider.createNote).not.toHaveBeenCalled();
  });

  it('uses the shared message when neither name nor path is supplied', async () => {
    const provider = makeProvider();
    await expect(callTool(buildReg(provider), { content: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Provide exactly one of name or path',
      details: { field: 'name' },
    });
  });

  it('passes an identifier down rather than a name/path pair', async () => {
    const provider = makeProvider();
    await callTool(buildReg(provider), { path: 'Notes/New', content: 'body' });

    expect(provider.createNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/New.md' },
      content: 'body',
    });
  });
```

Add to `test/operations/fs-vault-provider/create-note.test.ts`:

```typescript
  it('rejects a name that normalizes outside the vault on the name field', async () => {
    const root = await makeVault({});

    await expect(
      makeProvider(root).createNote({ identifier: byName('../escape') }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'name' } });
  });
```

Convert every existing call in that file from `provider.createNote({ path: 'x.md', ... })` / `{ name: 'X', ... }` to `provider.createNote({ identifier: byPath('x.md'), ... })` / `{ identifier: byName('X'), ... }`, importing `byName` / `byPath` from `./_helpers.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/operations/tools/create-note.test.ts test/operations/fs-vault-provider/create-note.test.ts`
Expected: FAIL — `details.field` is `"name"` for the both-supplied case, and `createNote` receives `{ path }` rather than `{ identifier }`.

- [ ] **Step 3: Narrow the input type**

In `src/lib/obsidian/vault-provider.ts` replace `CreateNoteInput` with:

```typescript
export interface CreateNoteInput {
  identifier: NoteIdentifier;
  content?: string;
  overwrite?: boolean;
}
```

- [ ] **Step 4: Add `resolveNew` and use it**

In `src/modules/operations/fs-vault-provider.ts`, replace the opening of `createNote` (`:62-79`) with:

```typescript
  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const relPath = await this.resolveNew(input.identifier);
    const absPath = path.join(this.vaultRoot, relPath);
```

and rename the remaining `relPath` references in the method's error messages accordingly (they already use `relPath`). Add beside `resolveExisting`:

```typescript
  /**
   * Resolve an identifier for a note being created. `kind: 'name'` cannot use
   * the basename index — the note does not exist yet — so it goes through the
   * vault's new-note-location convention instead (design D3). A name that
   * normalizes outside the vault is a caller error on the `name` field, the
   * same way the `path` branch reports on `path`.
   */
  private async resolveNew(identifier: NoteIdentifier): Promise<string> {
    if (identifier.kind === 'path') return normalizeNotePath(identifier.value);
    try {
      return normalizeNotePath((await this.newNoteDir(this.vaultRoot)) + identifier.value);
    } catch (err) {
      throw invalidArgument((err as Error).message, 'name');
    }
  }
```

- [ ] **Step 5: Rewrite the tool handler**

In `src/modules/operations/tools/create-note.ts`, replace `:59-99` with:

```typescript
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'create_note' });
      const identifier = resolveIdentifier(input.name, input.path);

      const passthrough: CreateNoteInput = { identifier };
      if (input.overwrite !== undefined) passthrough.overwrite = input.overwrite;

      const hasFrontmatter =
        input.frontmatter !== undefined && Object.keys(input.frontmatter).length > 0;

      if (hasFrontmatter) {
        // Merge any frontmatter the content carried with the param; the param
        // wins on key collisions. `splitFrontmatter` parses the content block
        // into an object (and returns the body); on malformed YAML it yields
        // `frontmatter: null`, so nothing is merged and the raw text stays in
        // the body.
        const { frontmatter: contentFm, content: body } = splitFrontmatter(input.content ?? '');
        const merged = { ...(contentFm ?? {}), ...input.frontmatter };
        passthrough.content = serializeFrontmatter(merged) + body;
      } else if (input.content !== undefined) {
        passthrough.content = input.content;
      }

      const result = await entry.provider.createNote(passthrough);
      return { vault: entry.name, ...result };
    },
```

Fix the imports: `import { resolveIdentifier } from '../tool-helpers.js';` (drop `invalidArgument`), `import type { CreateNoteInput } from '../../../lib/obsidian/vault-provider.js';` in place of the `CreateNoteToolInput` import, and drop the now-unused `normalizeNotePath` import.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/lib/obsidian/vault-provider.ts src/modules/operations/ test/operations/
git commit -m "refactor(create-note): resolve the target identifier at one depth"
```

---

## Task 6: PR 1 acceptance and handoff

**Files:** none modified — this task is verification and the PR.

- [ ] **Step 1: Prove the name ⊕ path rule has one implementation**

Run: `grep -rn "exactly one of name or path" src/`
Expected: exactly one hit, `src/modules/operations/tool-helpers.ts`.

Run: `grep -rn "input.name !== undefined && input.path !== undefined" src/`
Expected: no hits.

- [ ] **Step 2: Prove the write-error mapping is single**

Run: `grep -rn "WRITE_FAILED" src/`
Expected: exactly one construction site, `writeRaw` in `src/modules/operations/fs-vault-provider.ts`.

Run: `grep -rn "'NOT_FOUND'" src/modules/operations/fs-vault-provider.ts`
Expected: two — `readRaw` and `readDaily`. `readDaily` is a distinct message ("Today's daily note does not exist yet") that the `headless-vault-operations` spec pins; leaving it is correct.

- [ ] **Step 3: Prove the writer is gone**

Run: `grep -rn "VaultWriter\|writerFactory" src/ test/`
Expected: no hits.

- [ ] **Step 4: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all three pass.

- [ ] **Step 5: Open PR 1**

```bash
git push -u origin HEAD && gh pr create --base main --title "refactor(operations): fold FsVaultWriter into the disk provider" --body-file -
```

The body must state `Refs #114` and name the three behaviour changes explicitly, so a reviewer meets them here rather than in the diff: `create_note` with both `name` and `path` now reports `details.field: "path"` (was `"name"`); its both-missing message is now "Provide exactly one of name or path"; and `edit_note` with `replace: ''` plus an unresolvable `name` now fails `INVALID_ARGUMENT` before touching disk (was `NOT_FOUND`).

- [ ] **Step 6: Stop.** Do not begin Group 2 until PR 1 is reviewed and merged.

---
# Group 2 — Resize `VaultProvider` (PR 2)

Tasks 7–10. Sequential. Task 7 is additive; tasks 8 and 9 are type changes that ship with their call sites.

## Task 7: Reader-derived tag and property aggregates

**Files:**
- Create: `src/lib/obsidian/vault-aggregates.ts`
- Modify: `src/modules/operations/fs-vault-provider.ts:33-40,282-317` (delegate, drop the moved helpers)
- Test: `test/lib/obsidian/vault-aggregates.test.ts` (create)

**Interfaces:**
- Consumes: `VaultReader` (`scan()`, `readNotes()`), `extractTags` (`./query/note-record.js`), `extractInlineTags` (`./inline-tags.js`).
- Produces: `listTags(reader: VaultReader): Promise<AggregateEntry[]>` and `listProperties(reader: VaultReader): Promise<AggregateEntry[]>`, where `AggregateEntry = { name: string; count: number }`, both sorted by count desc then name asc. Tasks 8 and 9 call them.

This module lives under `src/lib/` because `computeVaultOverview` (Task 8) is under `src/lib/`, and nothing under `src/lib/` may import `src/modules/` (design D7).

- [ ] **Step 1: Write the failing test**

Create `test/lib/obsidian/vault-aggregates.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { listProperties, listTags } from '../../../src/lib/obsidian/vault-aggregates.js';
import type { ReadNotesItem, VaultReader } from '../../../src/lib/obsidian/vault-reader.js';

function readerOver(notes: Record<string, { frontmatter?: Record<string, unknown>; content?: string }>): VaultReader {
  return {
    scan: async () => Object.keys(notes),
    readNotes: async ({ paths }) =>
      paths.map(
        (p): ReadNotesItem => ({
          path: p,
          frontmatter: notes[p]?.frontmatter ?? {},
          content: notes[p]?.content ?? '',
        }),
      ),
  };
}

describe('listTags', () => {
  it('counts frontmatter tags across notes', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['alpha'] } },
      'b.md': { frontmatter: { tags: ['alpha'] } },
      'c.md': { frontmatter: { tags: ['alpha'] } },
    });

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 3 }]);
  });

  it('counts inline body tags', async () => {
    const reader = readerOver({ 'a.md': { content: 'text #beta more' } });

    expect(await listTags(reader)).toEqual([{ name: 'beta', count: 1 }]);
  });

  it('counts a tag once per note even when it appears in both places', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['gamma'] }, content: '#gamma and #gamma again' },
    });

    expect(await listTags(reader)).toEqual([{ name: 'gamma', count: 1 }]);
  });

  it('counts duplicated frontmatter entries once', async () => {
    const reader = readerOver({ 'a.md': { frontmatter: { tags: ['alpha', 'alpha'] } } });

    expect(await listTags(reader)).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('excludes non-tag # sequences', async () => {
    const reader = readerOver({
      'a.md': { content: '#123\n```\n#fenced\n```\n`#inline`\nhttps://e.com/#section\n## Heading\n' },
    });

    expect(await listTags(reader)).toEqual([]);
  });

  it('counts nested tags verbatim', async () => {
    const reader = readerOver({ 'a.md': { content: '#project/alpha' } });

    expect(await listTags(reader)).toEqual([{ name: 'project/alpha', count: 1 }]);
  });

  it('sorts by count desc then name asc', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { tags: ['zeta', 'alpha'] } },
      'b.md': { frontmatter: { tags: ['alpha'] } },
      'c.md': { frontmatter: { tags: ['beta'] } },
    });

    expect(await listTags(reader)).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 1 },
      { name: 'zeta', count: 1 },
    ]);
  });

  it('counts nothing for a vault the reader scans as empty', async () => {
    expect(await listTags(readerOver({}))).toEqual([]);
  });
});

describe('listProperties', () => {
  it('counts frontmatter keys across notes', async () => {
    const reader = readerOver({
      'a.md': { frontmatter: { status: 'open', due: '2026-01-01' } },
      'b.md': { frontmatter: { status: 'done' } },
    });

    expect(await listProperties(reader)).toEqual([
      { name: 'status', count: 2 },
      { name: 'due', count: 1 },
    ]);
  });

  it('counts nothing for a vault the reader scans as empty', async () => {
    expect(await listProperties(readerOver({}))).toEqual([]);
  });
});
```

Scope exclusion needs no case here: both functions read only what `reader.scan()` returns, so scope is the reader's property and is already pinned in `test/operations/fs-vault-provider/list-tags.test.ts` against a real scoped reader. Keep that file until Task 9.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/obsidian/vault-aggregates.test.ts`
Expected: FAIL — cannot resolve `vault-aggregates.js`.

- [ ] **Step 3: Create the module**

Create `src/lib/obsidian/vault-aggregates.ts`:

```typescript
import { extractInlineTags } from './inline-tags.js';
import { extractTags } from './query/note-record.js';
import type { ReadNotesItemSuccess, VaultReader } from './vault-reader.js';

export interface AggregateEntry {
  name: string;
  count: number;
}

/** Same batching pattern as query-notes.ts — bound memory, never hold every body at once. */
const READ_BATCH_SIZE = 32;

function sortCounts(counts: Map<string, number>): AggregateEntry[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Tag counts over the reader's scoped scan: the per-note union of frontmatter
 * `tags:` values and inline body `#tags`, each distinct tag counted at most
 * once per note. A note the vault's scope excludes never reaches `scan()`, so
 * it contributes nothing.
 */
export async function listTags(reader: VaultReader): Promise<AggregateEntry[]> {
  const counts = new Map<string, number>();
  const paths = await reader.scan();
  for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
    const slice = paths.slice(i, i + READ_BATCH_SIZE);
    const items = await reader.readNotes({ paths: slice, fields: ['frontmatter', 'content'] });
    for (const item of items) {
      if ('error' in item) continue;
      const noteTags = new Set([
        ...extractTags(item.frontmatter ?? {}),
        ...extractInlineTags(item.content),
      ]);
      for (const tag of noteTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return sortCounts(counts);
}

/** Frontmatter-key counts over the reader's scoped scan. */
export async function listProperties(reader: VaultReader): Promise<AggregateEntry[]> {
  const counts = new Map<string, number>();
  const paths = await reader.scan();
  const items = await reader.readNotes({ paths, fields: ['frontmatter'] });
  const frontmatters = items
    .filter((i): i is ReadNotesItemSuccess => !('error' in i))
    .map((i) => i.frontmatter ?? {});
  for (const fm of frontmatters) {
    for (const key of Object.keys(fm)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return sortCounts(counts);
}
```

- [ ] **Step 4: Delegate from the provider**

In `src/modules/operations/fs-vault-provider.ts`, replace the bodies of `listProperties` and `listTags` (`:282-307`) with delegations, and delete `sortCounts` (`:33-37`), `READ_BATCH_SIZE` (`:39-40`), `scanFrontmatter` (`:309-316`), and the now-unused `extractTags` / `extractInlineTags` / `ReadNotesItemSuccess` imports:

```typescript
  async listProperties(): Promise<PropertyListEntry[]> {
    return listProperties(this.reader);
  }

  async listTags(): Promise<TagListEntry[]> {
    return listTags(this.reader);
  }
```

with `import { listProperties, listTags } from '../../lib/obsidian/vault-aggregates.js';` — note the local method names shadow the imports inside the class body only, which is fine; if lint objects, import as `listPropertiesOverReader` / `listTagsOverReader`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — the new suite plus every existing `list-tags` / `list-properties` case, which now exercise the delegation.

- [ ] **Step 6: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/lib/obsidian/vault-aggregates.ts src/modules/operations/fs-vault-provider.ts test/lib/obsidian/vault-aggregates.test.ts
git commit -m "refactor(obsidian): derive tag and property aggregates from the reader"
```

---

## Task 8: `computeVaultOverview` takes three deps

**Files:**
- Modify: `src/lib/obsidian/vault-overview.ts:1-3,36-41,66-75`
- Modify: `src/modules/operations/tools/get-vault-overview.ts:15-22`
- Modify: `src/modules/operations/resources/vault-overview.ts:21-27`
- Test: `test/lib/obsidian/vault-overview.test.ts`, `test/operations/tools/get-vault-overview.test.ts`, `test/operations/resources/vault-overview.test.ts`

**Interfaces:**
- Consumes: `listTags` / `listProperties` from Task 7.
- Produces: `ComputeVaultOverviewDeps = { reader: VaultReader; graph: WikilinkGraphIndex; readConventions: () => Promise<string | null> }`. Task 9 relies on the overview no longer needing a provider.

- [ ] **Step 1: Write the failing test**

In `test/lib/obsidian/vault-overview.test.ts`, delete the inline `makeProvider` (`:23-33`) and the `VaultProvider` type import, then drive tags and properties through the reader instead. The empty-vault case becomes:

```typescript
  it('returns zeroed snapshot for an empty vault', async () => {
    const reader = makeReader();
    const graph = makeGraph();

    const result = await computeVaultOverview({ reader, graph, readConventions: noConventions });

    expect(result).toEqual({
      total_notes: 0,
      folders: [],
      top_tags: [],
      properties: [],
      top_by_backlinks: [],
    });
  });
```

and every case that previously stubbed `provider.listTags` / `listProperties` now stubs the reader, e.g.:

```typescript
  it('reports tags and properties derived from the reader', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi
        .fn()
        .mockResolvedValue([{ path: 'a.md', frontmatter: { tags: ['alpha'], status: 'open' }, content: '' }]),
    });

    const result = await computeVaultOverview({
      reader,
      graph: makeGraph(),
      readConventions: noConventions,
    });

    expect(result.top_tags).toEqual([{ name: 'alpha', count: 1 }]);
    expect(result.properties).toEqual([
      { name: 'status', count: 1 },
      { name: 'tags', count: 1 },
    ]);
  });
```

Note the `tags` key itself counts as a property — that is existing behaviour (`listProperties` counts every frontmatter key), so assert it rather than working around it.

Keep the `TOP_TAGS_LIMIT` / `TOP_PROPERTIES_LIMIT` truncation cases, feeding the reader enough distinct tags and keys to exceed both limits.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/obsidian/vault-overview.test.ts`
Expected: FAIL — `computeVaultOverview` still requires `provider`.

- [ ] **Step 3: Narrow the deps**

In `src/lib/obsidian/vault-overview.ts`, delete the `VaultProvider` type import, replace the deps interface:

```typescript
export interface ComputeVaultOverviewDeps {
  reader: VaultReader;
  graph: WikilinkGraphIndex;
  readConventions: () => Promise<string | null>;
}
```

and replace the destructure and the `Promise.all` at `:67-75` with:

```typescript
  const { reader, graph, readConventions } = deps;
  await graph.ensureFresh();

  const paths = await reader.scan();
  const [tags, props, conventions] = await Promise.all([
    listTags(reader),
    listProperties(reader),
    conventionsFields(readConventions),
  ]);
```

adding `import { listProperties, listTags } from './vault-aggregates.js';`.

- [ ] **Step 4: Update both callers in the same commit**

`src/modules/operations/tools/get-vault-overview.ts:16-21`:

```typescript
  return computeVaultOverview({
    reader: entry.reader,
    graph: entry.graph,
    readConventions: entry.readConventions,
  });
```

`src/modules/operations/resources/vault-overview.ts:22-27` — the same three fields.

- [ ] **Step 5: Update the two tool-level suites**

In `test/operations/tools/get-vault-overview.test.ts` and `test/operations/resources/vault-overview.test.ts`, drop `provider` from the entries passed to `makeTestRegistry` and drive `top_tags` / `properties` through `makeReader` as in Step 1. Keep the multi-vault fan-out cases — they now differ by reader, not by provider.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add src/lib/obsidian/vault-overview.ts src/modules/operations/ test/lib/obsidian/vault-overview.test.ts test/operations/
git commit -m "refactor(overview): compute the vault snapshot from reader and graph alone"
```

---

## Task 9: Drop the aggregates from `VaultProvider`

**Files:**
- Modify: `src/lib/obsidian/vault-provider.ts` (drop `PropertyListEntry`, `TagListEntry`, and the two interface members)
- Modify: `src/modules/operations/fs-vault-provider.ts` (drop the two delegating methods)
- Modify: `src/modules/operations/tools/list-tags.ts:18-21`, `src/modules/operations/tools/list-properties.ts:18-21`
- Modify: `test/operations/tools/_helpers.ts` (resize `makeProvider`)
- Delete: `test/operations/fs-vault-provider/list-tags.test.ts`, `test/operations/fs-vault-provider/list-properties.test.ts`
- Modify: `test/operations/tools/list-tags.test.ts`, `test/operations/tools/list-properties.test.ts`, `test/operations/fs-vault-provider/headless-overview.test.ts`

**Interfaces:**
- Consumes: `listTags` / `listProperties` from Task 7.
- Produces: the final `VaultProvider` — `createNote`, `readDaily`, `setProperty`, `removeProperty`, `replaceInNote`, `replaceFullBody`. Every member opens one note file over the vault root.

Type change: interface and every call site in one commit.

- [ ] **Step 1: Write the failing test**

In `test/operations/tools/list-tags.test.ts`, replace the provider stubs with readers. The first case becomes:

```typescript
  it('returns tag counts derived from the vault reader', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['a.md']),
      readNotes: vi.fn().mockResolvedValue([{ path: 'a.md', frontmatter: { tags: ['x'] }, content: '' }]),
    });
    const registry = makeTestRegistry([{ name: 'v', reader }]);

    const result = await callTool(registerTool(buildListTagsTool({ registry })), {});

    expect(result).toEqual({ vault: 'v', results: [{ name: 'x', count: 1 }] });
  });
```

Apply the same shape to `test/operations/tools/list-properties.test.ts`, including its multi-vault fan-out cases.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/operations/tools/list-tags.test.ts test/operations/tools/list-properties.test.ts`
Expected: FAIL — the tools still call `entry.provider.listTags()`, which the stubbed entries no longer provide.

- [ ] **Step 3: Rewire the two tools**

`src/modules/operations/tools/list-tags.ts:18-21`:

```typescript
async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await listTags(entry.reader);
  return { results };
}
```

with `import { listTags } from '../../../lib/obsidian/vault-aggregates.js';`. Mirror it in `list-properties.ts` with `listProperties`.

- [ ] **Step 4: Shrink the interface and the implementation**

In `src/lib/obsidian/vault-provider.ts`, delete `PropertyListEntry`, `TagListEntry`, and the `listProperties` / `listTags` members. The interface becomes:

```typescript
export interface VaultProvider {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  readDaily(): Promise<DailyNoteResult>;
  setProperty(input: SetPropertyInput): Promise<void>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  replaceInNote(input: ReplaceInNoteInput): Promise<void>;
  replaceFullBody(input: ReplaceFullBodyInput): Promise<void>;
}
```

In `src/modules/operations/fs-vault-provider.ts`, delete both delegating methods and the `vault-aggregates.js` import — the provider no longer aggregates anything. Update its class doc comment to say it owns every note-file read and write over the vault root.

- [ ] **Step 5: Resize the stub and retire the superseded suites**

In `test/operations/tools/_helpers.ts`, delete `listProperties` and `listTags` from `makeProvider`, leaving the six note-file methods.

```bash
git rm test/operations/fs-vault-provider/list-tags.test.ts test/operations/fs-vault-provider/list-properties.test.ts
```

Before deleting, confirm case-by-case that `test/lib/obsidian/vault-aggregates.test.ts` covers each — except the scope-exclusion case, which depends on a real `FsVaultReader` over a scoped temp vault. Move that one case into `test/operations/fs-vault-provider/headless-overview.test.ts` (which already builds a real reader over a temp vault) rather than losing it, and update that file's `makeProvider(root)` overview calls to the three-dep signature from Task 8.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
```

```bash
git add -A src/ test/
git commit -m "refactor(vault): resize VaultProvider to note-file operations"
```

---

## Task 10: PR 2 acceptance and handoff

**Files:** none modified.

- [ ] **Step 1: Prove the stub helpers collapsed**

Run: `grep -rn "function makeProvider" test/`
Expected: exactly two — the stub in `test/operations/tools/_helpers.ts` and the real-module builder in `test/operations/fs-vault-provider/_helpers.ts`. No third definition, and none inline in a test file.

- [ ] **Step 2: Prove the interface is resized**

Run: `grep -rn "implements VaultProvider" src/`
Expected: one hit, `FsVaultProvider`.

Run: `grep -rn "listTags\|listProperties" src/`
Expected: hits only in `src/lib/obsidian/vault-aggregates.ts`, `src/lib/obsidian/vault-overview.ts`, and the two list tools. None in `vault-provider.ts` or `fs-vault-provider.ts`.

- [ ] **Step 3: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all three pass.

- [ ] **Step 4: Open PR 2**

```bash
git push -u origin HEAD && gh pr create --base main --title "refactor(vault): resize VaultProvider to note-file operations" --body-file -
```

Body states `Refs #114` and confirms `list_tags`, `list_properties`, and `get_vault_overview` return identical payloads — only the call site moved.

- [ ] **Step 5: Stop.** Do not begin Group 3 until PR 2 is reviewed and merged.

---

# Group 3 — Record the decision (PR 3)

Tasks 11–15 touch disjoint files and are **parallel-safe** — dispatch them concurrently. Tasks 16–18 are sequential after them.

## Task 11: ADR-0016

**Files:**
- Create: `docs/adr/0016-<slug>.md` (from `docs/adr/0000-template.md`)
- Modify: `docs/adr/INDEX.md`

- [ ] **Step 1: Read the template and the two ADRs this one sits between**

Read `docs/adr/0000-template.md` for the required section structure, `docs/adr/0009-disk-direct-vault-operations.md` for what it left in place, and `docs/adr/0015-input-gate-owns-schema-validation.md` as the model for a refining ADR.

- [ ] **Step 2: Write the ADR**

Status: Accepted. Content per design D9 — one module owns note writes over a vault root; the `VaultWriter` seam is deleted rather than kept (single consumer, deletion test, and its divergence produced #113); what the surviving `VaultProvider` seam is actually for (a stub point for tool tests, not a plausible second backend); and the explicit non-goal that `FsVaultReader`'s errors-as-data convention is untouched, so "one module over the vault root" is not misread as covering batch reads. ADR-0009 stays Accepted — 0016 refines it.

- [ ] **Step 3: Add the INDEX rows**

Add the 0016 row to `docs/adr/INDEX.md`, and append "refined in part by 0016" to the 0009 row, matching the formatting the 0003 row already uses for its 0015 note.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/
git commit -m "docs(adr): record that one disk module owns note writes"
```

---

## Task 12: `docs/architecture/vault-provider.md`

**Files:**
- Modify: `docs/architecture/vault-provider.md`

- [ ] **Step 1: Correct the interface listing**

Replace the `interface VaultProvider` code block with the six note-file methods from Task 9.

- [ ] **Step 2: Correct the paragraph that is now false**

The "Note-body **batch reads** and **in-place edits** are not `VaultProvider` concerns … `edit_note` goes through `VaultWriter` (`FsVaultWriter`)" paragraph must be rewritten: batch reads are still `VaultReader`'s, but in-place edits are now the provider's. State what the interface is now cohesive around — every operation that opens one note file over the vault root — and that tag/property aggregation moved out to `vault-aggregates.ts`.

- [ ] **Step 3: Rewrite §Identifier shape**

Add the two resolution modes (design D3): `resolveExisting` for targets that must already exist, `resolveNew` for `create_note`. State that the name ⊕ path *validation* happens once at the tool layer in `resolveIdentifier`, and that resolution happens once, here.

- [ ] **Step 4: Correct §What it deliberately does not do**

The second bullet names `resolveIdentifierPath`, which no longer exists under that name, and says path normalization happens "one layer above … so the provider can stay a thin shell". Restate: every write tool now normalizes at the tool layer, uniformly, and the provider re-normalizes defensively on the `kind: 'path'` branch of both resolvers.

- [ ] **Step 5: Link the new ADR**

Add a reference to ADR-0016 alongside the existing ADR-0009 reference.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/vault-provider.md
git commit -m "docs(architecture): describe the consolidated vault provider"
```

---

## Task 13: `docs/architecture/disk-write-path.md`

**Files:**
- Modify: `docs/architecture/disk-write-path.md`

- [ ] **Step 1: Widen the opening paragraph**

It currently frames the file as "How `create_note` and `read_daily` behave". Widen it to every note write, including `edit_note`'s two modes and the property writes.

- [ ] **Step 2: Add a section on the two error taxonomies**

Document what design D5 decided: one `NOT_FOUND` / `READ_FAILED` / `WRITE_FAILED` mapping for notes that must already exist, and the distinct `NOTE_EXISTS` / `CREATE_FAILED` mapping for `create_note`, with why they are separate (different flags, and the create taxonomy is pinned by the `headless-vault-operations` spec). Note the injection seam and why it exists (design D6).

- [ ] **Step 3: Keep the existing sections**

`create_note`'s exact-path behaviour, the `read_daily` preflight, and the templates non-goal are all still accurate — leave them.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/disk-write-path.md
git commit -m "docs(architecture): cover every note write in the disk-write path"
```

---

## Task 14: `note-path-resolution.md` and `vault-registry.md`

**Files:**
- Modify: `docs/architecture/note-path-resolution.md`
- Modify: `docs/architecture/vault-registry.md:17,27`

- [ ] **Step 1: Fix §The rule**

It reads "before `FsVaultProvider`/`FsVaultReader`/`FsVaultWriter` ever touch the filesystem" — drop `FsVaultWriter`. Also correct the `normalizeNotePath` row's "which is what lets `resolveIdentifierPath` (`FsVaultProvider`) turn a bare name into a real vault-relative path" — that function is now `resolveNew`, and the bare-name case it describes is `create_note`'s, not the shared one.

- [ ] **Step 2: Fix §What `normalizeNotePath` does not do**

Its first bullet says "Existence is the reader's / writer's / provider's job" — there is no writer.

- [ ] **Step 3: Delete the `writer` registry row**

`docs/architecture/vault-registry.md:17` — remove the `| writer | always | FsVaultWriter — direct disk writes for in-place edits |` row entirely.

- [ ] **Step 4: Fix the enumeration at `:27`**

"built by `conventionsReaderFactory` and `existingPathFilterFactory` in `IVaultEntryDeps` the same way `reader`, `writer`, and `provider` are" — drop `writer`.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/note-path-resolution.md docs/architecture/vault-registry.md
git commit -m "docs(architecture): drop the writer from path resolution and the registry"
```

---

## Task 15: `obsidian-lib.md` and `module-structure.md`

**Files:**
- Modify: `docs/architecture/obsidian-lib.md:21,49`
- Modify: `docs/architecture/module-structure.md:71,86,90,92`

- [ ] **Step 1: Replace the `vault-writer.ts` bullet**

`obsidian-lib.md:21` describes a file that no longer exists. Replace it with a `vault-aggregates.ts` bullet — `listTags` / `listProperties` over a `VaultReader`, composed by `vault-overview.ts` and the two list tools — and fold the in-place-edit note into the `vault-provider.ts` entry.

- [ ] **Step 2: Fix the entry-construction sentence**

`obsidian-lib.md:49` lists "then `FsVaultWriter`, `WikilinkGraphIndex`, …" in the factory order. Remove `FsVaultWriter`.

- [ ] **Step 3: Fix the mermaid diagram**

`module-structure.md:71` declares `Writer[FsVaultWriter<br/>fs/promises]` and `:86` declares its `Writer -. fs read/write .-> Vault` edge. Delete both; the provider node already carries the fs edge.

- [ ] **Step 4: Fix the two prose paragraphs**

`:90` says each entry "bundles a reader, writer, provider, wikilink graph" — drop `writer`. `:92` says "`FsVaultReader` for batch reads (`read_notes`, `query_notes`), `FsVaultWriter` for in-place edits (`edit_note`), and `FsVaultProvider` for everything else" — rewrite as `FsVaultReader` for batch reads and `FsVaultProvider` for every note write plus the daily read, with tag/property aggregation derived from the reader.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/obsidian-lib.md docs/architecture/module-structure.md
git commit -m "docs(architecture): remove the writer from the module map"
```

---

## Task 16: Full docs sweep

**Files:** whatever the greps find.

- [ ] **Step 1: Sweep for the deleted module**

Run: `grep -rn "VaultWriter\|vault-writer" docs/ README.md AGENTS.md`
Expected after fixes: hits only inside `docs/adr/0007-*.md` and `docs/adr/0009-*.md`, which are historical records and must not be rewritten.

- [ ] **Step 2: Sweep for the moved aggregates**

Run: `grep -rn "provider.listTags\|provider.listProperties\|VaultProvider" docs/`
Fix any prose still describing the aggregates as provider methods. An architecture-scoped grep alone misses `docs/guide/` — this sweep must cover all of `docs/`.

- [ ] **Step 3: Sweep for the resolution story**

Run: `grep -rn "resolveIdentifierPath\|resolveToPath" docs/`
Expected: no hits — both names are gone.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: sweep remaining references to the deleted writer seam"
```

---

## Task 17: Spec sync and validation

**Files:**
- Modify: `openspec/specs/headless-vault-operations/spec.md` (after archive)

- [ ] **Step 1: Validate the change artifacts**

Run: `npx openspec validate --all`
Expected: `change/consolidate-vault-writes` passes along with every spec.

- [ ] **Step 2: Full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all three pass.

- [ ] **Step 3: Archive, then fix the Purpose block**

Run `/opsx:archive`, which syncs the delta into `openspec/specs/headless-vault-operations/spec.md`. Then hand-edit that file's `## Purpose` paragraph to include `edit_note` in its tool enumeration. The Purpose block is not expressible as a requirement delta, so this edit is deliberate rather than a sync gap — say so in the commit message.

- [ ] **Step 4: Re-validate**

Run: `npx openspec validate --all`
Expected: pass.

---

## Task 18: Verify, retrospect, and open PR 3

**Files:**
- Create: `openspec/changes/consolidate-vault-writes/verify.md`, `retrospective.md`

- [ ] **Step 1: Run `/opsx:verify`**

Confirm every requirement in `specs/headless-vault-operations/spec.md` has a test that exercises it, and that each of the issue's four acceptance bullets holds — re-run the greps from Tasks 6 and 10 against the merged tree, not against a stale branch.

- [ ] **Step 2: Write the retrospective**

Record at minimum: whether folding `FsVaultWriter` in surfaced any behaviour the deletion test missed; whether the three `INVALID_ARGUMENT` / ordering changes drew review comment; and whether the two-resolution-mode split held up or wanted to be one function after all.

- [ ] **Step 3: Archive**

Run `/opsx:archive` (already done in Task 17 Step 3 if that is where it fell — do not run it twice).

- [ ] **Step 4: Open PR 3**

```bash
git push -u origin HEAD && gh pr create --base main --title "docs(vault): record the consolidated write path and archive the change" --body-file -
```

Body states `Closes #114`.

---

## Self-Review Notes

- **Spec coverage.** `specs/headless-vault-operations/spec.md` ADDED "Note writes resolve one identifier rule at one depth" → Tasks 3, 5 (tool-level) and 2, 5 (module-level resolution modes); its four scenarios map to the tests in Task 3 Step 1, Task 5 Step 1, and Task 2 Step 1. ADDED "Operations on an existing note share one failure taxonomy" → Task 1 (the mapping and its three scenarios) plus Task 2 (`replaceInNote` / `replaceFullBody` reaching it). MODIFIED "Vault operations run without Obsidian" → no code change; its widened enumeration is documentation-level and is pinned by the existing headless suites. MODIFIED "Write methods edit vault files directly" → its new "Body edits leave the frontmatter untouched" scenario is the first test in Task 2 Step 1, and the single-module clause is proven by Task 6's greps.
- **Type consistency.** `resolveExisting` (Task 2) and `resolveNew` (Task 5) are used under exactly those names in Tasks 12 and 14. `AggregateEntry` (Task 7) is the return element in Tasks 8 and 9. `readRaw` / `writeRaw` (Task 1) are consumed under those names in Tasks 2 and 6. `makeProvider(root, fs?)` (Task 1 Step 3) is the two-argument form used in Tasks 1 and 2.
- **Known gap, deliberately placed.** The scope-exclusion case for `listTags` cannot move to `test/lib/obsidian/vault-aggregates.test.ts` — it needs a real `FsVaultReader` over a scoped temp vault. Task 9 Step 5 relocates it to `headless-overview.test.ts` rather than deleting it; do not skip that step when retiring the two superseded suites.
