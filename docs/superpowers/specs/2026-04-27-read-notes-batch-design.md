# Batch `read_notes` (replacing `read_note`) — Design

**Date:** 2026-04-27
**Status:** Draft
**Source task:** `Add batch read_notes to neuro-vault` (`/Users/most/Obsidian/My default vault/Tasks/Add batch read_notes to neuro-vault.md`)
**Related specs:**

- [2026-04-25-vault-operations-module-design.md](./2026-04-25-vault-operations-module-design.md) — Batch 1 (which introduced `read_note`)
- [2026-04-26-properties-and-tags-tools-design.md](./2026-04-26-properties-and-tags-tools-design.md) — Batch 2

## Goal

Replace the single-note `read_note` tool with a batch tool `read_notes(paths, fields?)` that reads up to 50 notes per MCP call **directly from disk**, bypassing the Obsidian CLI for read operations. Eliminates the dominant N+1 patterns observed in real sessions (`read_note × N` after `search_notes` / wikilink walks; `read_property × N` for "look up `status` on a list of files"), and removes the requirement that Obsidian be running for read-only workflows.

## Scope

### In scope

- New MCP tool `read_notes` with `paths: string[]` (1..50, deduped) and `fields?: ("frontmatter" | "content")[]` (default `["frontmatter", "content"]`).
- **Removal** of the `read_note` tool, its handler, its `VaultProvider.readNote` method, its `ReadNoteToolInput` / `ReadNoteResult` types, and its provider implementation in `ObsidianCLIProvider`.
- New `VaultReader` abstraction (separate from `VaultProvider`) implemented by `FsVaultReader` — pure `node:fs/promises.readFile` + reuse of existing `splitFrontmatter`. Vault root is taken from the existing `config.vaultPath` (already required via `--vault`).
- Per-item failure tolerance: one missing/unreadable path does not fail the others; the failed item carries a structured `error` field, the rest succeed.
- Order preservation: results are returned in input order with duplicates removed in-place.
- New `OperationsErrorCode` value `READ_FAILED` (for non-`ENOENT` fs errors). Reuses existing `INVALID_ARGUMENT` and `NOT_FOUND`.
- Major version bump → **2.0.0**, justified by the breaking removal of `read_note` from the MCP surface.
- Documentation updates: README tools matrix and Vault Operations section, `docs/architecture/module-structure.md` (tool list & total count phrasing), `docs/architecture/vault-provider.md` (note that reads have moved out), and a new `docs/architecture/vault-reader.md` describing the new abstraction.

### Out of scope

- Wikilink-based reads. `read_notes` accepts `paths` only — no `name` alias. After `read_note` is removed, there is no MCP path to read by wikilink. If that workflow comes back as a real need, it gets a separate `resolve_wikilink(name) → path` tool or a follow-up `names` parameter; both are explicit decisions, not silent feature creep.
- `mtime`, inline-body `tags`, or any other projection field. Frontmatter `tags:` is already part of `frontmatter`, so the source task's `fields: [..., "tags", "mtime"]` is reduced to `frontmatter | content` only. Inline body tags and `mtime` are deferred to a future change, ideally landing with `VaultIndex`.
- Migrating `read_daily` to fs. Daily notes go through a different concept (date-based resolution that the CLI already implements via `daily:path` / `daily:read`). Out of scope here; revisit if/when `VaultIndex` provides a daily-name resolver.
- Bounded concurrency / semaphore. With `node:fs/promises`, the OS handles parallel reads natively; 50 concurrent `readFile` calls finish in tens of ms on any modern disk. No `p-limit` or hand-rolled semaphore.
- Caching. Deferred to `VaultIndex`.
- Stream API for `paths.length > 50`. Caller paginates; the 50-cap is a deliberate guardrail against pathological calls.
- Glob-shaped input (`paths: ["Tasks/*.md"]`). That is `query_notes` work, tracked separately.
- Auto-detecting vault root. The existing required `--vault <path>` already provides it; no new flag.

## Architecture

### File-level layout

```
src/modules/operations/
  vault-reader.ts            # NEW — VaultReader interface + FsVaultReader
  vault-provider.ts          # remove ReadNoteInput, ReadNoteResult, readNote()
  obsidian-cli-provider.ts   # remove readNote() implementation
  tool-handlers.ts           # remove readNote handler, add readNotes handler
  tools.ts                   # remove read_note registration, add read_notes
  types.ts                   # remove ReadNoteToolInput, add ReadNotesToolInput / output types,
                             # add 'READ_FAILED' to OperationsErrorCode
  index.ts                   # createOperationsModule wires both VaultProvider AND VaultReader
src/types.ts                 # unchanged — config.vaultPath already exists
src/cli.ts / src/config.ts   # unchanged — --vault already required

test/operations/
  vault-reader.test.ts            # NEW
  tool-handlers.test.ts           # delete readNote tests; add readNotes tests
  tools.test.ts                   # name list update (read_note → read_notes)
  obsidian-cli-provider.test.ts   # delete readNote tests
test/server-modules.test.ts       # tool count stays 15; tool name change reflected
```

`splitFrontmatter` (`src/modules/operations/frontmatter.ts`) is reused 1:1.

### Why a separate `VaultReader`, not a method on `VaultProvider`

`VaultProvider` describes operations that go through the Obsidian app (CLI). Read-batch is a different backend (file system). Putting both behind one interface forces every implementer to either implement both backends or stub one — the abstraction stops being honest. Two parallel small interfaces — `VaultProvider` for app-mediated ops, `VaultReader` for fs-direct reads — are clearer for both readers and tests.

The handler depends on both. The module's `index.ts` constructs and injects both.

### `VaultReader` interface

```typescript
// src/modules/operations/vault-reader.ts

export type ReadNotesField = 'frontmatter' | 'content';

export interface ReadNotesItemSuccess {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  content?: string;
}

export interface ReadNotesItemError {
  path: string;
  error: {
    code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'READ_FAILED';
    message: string;
  };
}

export type ReadNotesItem = ReadNotesItemSuccess | ReadNotesItemError;

export interface ReadNotesInput {
  paths: string[]; // already validated/deduped/normalized by handler
  fields: ReadNotesField[]; // resolved to default by handler before reaching reader
}

export interface VaultReader {
  readNotes(input: ReadNotesInput): Promise<ReadNotesItem[]>;
}
```

The reader **always reads both** frontmatter and content from disk; the handler applies field projection. Reading both is essentially free (one `readFile` per path), and keeping projection in the handler makes the reader simpler and easier to test.

### `FsVaultReader` implementation

```typescript
export interface FsVaultReaderOptions {
  vaultRoot: string; // absolute path; from config.vaultPath
  readFile?: (absPath: string, encoding: 'utf8') => Promise<string>; // DI for tests
}

export class FsVaultReader implements VaultReader {
  // For each path:
  //   abs = path.join(vaultRoot, path)
  //   try { stdout = await readFile(abs, 'utf8'); }
  //   catch (err) {
  //     err.code === 'ENOENT' → { path, error: { code: 'NOT_FOUND', message } }
  //     else                  → { path, error: { code: 'READ_FAILED', message } }
  //   }
  //   { frontmatter, content } = splitFrontmatter(stdout)
  //   → { path, frontmatter, content }
  // Promise.all over the array, no concurrency cap.
}
```

`readFile` is DI'd for unit tests; the default is `node:fs/promises.readFile`. No `vaultRoot` existence check at construction — fail-on-first-read keeps construction synchronous and avoids a startup stat that would diverge between modules.

### Module wiring

```typescript
// src/modules/operations/index.ts (delta)

export function createOperationsModule(config, deps) {
  const provider = deps.provider ?? new ObsidianCLIProvider({ ... });
  const reader = deps.reader ?? new FsVaultReader({ vaultRoot: config.vaultPath });
  const handlers = createOperationsHandlers({ provider, reader });
  return { tools: buildOperationsTools(handlers) };
}
```

`OperationsHandlerDependencies` gains `reader: VaultReader`. Test fixtures pass fakes for both.

## Tool surface

### Schema (`tools.ts`)

```typescript
const readNotesFieldSchema = z.enum(['frontmatter', 'content']);

const readNotesSchema = z.object({
  paths: z.array(z.string()).min(1).max(50),
  fields: z.array(readNotesFieldSchema).min(1).optional(),
});
```

### Tool description

> "Read multiple notes in one call. `paths` is an array of 1–50 vault-relative POSIX paths; duplicates are de-duplicated and results returned in input order. `fields` projects which parts of each note to return — choose from `frontmatter` and `content`; default `['frontmatter','content']`. One missing or unreadable path does not fail the others — per-item errors are returned inline. Prefer this over N `read_note` calls: a single MCP roundtrip and parallel disk reads. Reads are direct from disk and do not require Obsidian to be running."

### Output shape

```jsonc
{
  "results": [
    {
      "path": "Projects/neuro-vault.md",
      "frontmatter": { "type": "project", "status": "active" },
      "content": "## Goal\n…",
    },
    {
      "path": "Tasks/missing.md",
      "error": { "code": "NOT_FOUND", "message": "Note not found: Tasks/missing.md" },
    },
  ],
  "count": 2,
  "errors": 1,
}
```

`count === results.length`, `errors === results.filter(r => 'error' in r).length`. The redundancy is intentional: the LLM reads `errors` at a glance to decide whether to ask the user before continuing.

## Handler logic

In `tool-handlers.ts`, the new `readNotes` handler:

1. **Parse via zod.** Out-of-range `paths.length`, empty `fields`, unknown field name → top-level `INVALID_ARGUMENT`.
2. **Dedupe** preserving first-occurrence order: `Array.from(new Set(input.paths))`. The dedupe happens once and downstream code sees only unique paths.
3. **Per-path validate**: run the existing `normalizePath`. If it throws (absolute path, `..` segments, empty after trim, Windows-absolute) → produce a per-item `{ path: original, error: { code: 'INVALID_ARGUMENT', message } }` and **do not** include this path in the reader call. Other valid paths still go to the reader.
4. **Resolve `fields`** to the default `['frontmatter','content']` if absent.
5. **Call reader** with the surviving `{ paths: validPaths, fields: resolvedFields }`. The reader returns one item per input path (success or per-item error).
6. **Project fields** in the handler: for each successful item, strip `content` if `fields` does not include `content`, strip `frontmatter` if it does not include `frontmatter`.
7. **Stitch** the invalid-path errors back into the result array so the final order matches the deduped input order.
8. **Return** `{ results, count: results.length, errors: results.filter(r => 'error' in r).length }`.

### Per-item error code mapping

| Signal                                       | `code`               |
| -------------------------------------------- | -------------------- |
| `normalizePath` rejects (abs / `..` / empty) | `INVALID_ARGUMENT`   |
| `fs.readFile` ENOENT                         | `NOT_FOUND`          |
| `fs.readFile` EACCES / EISDIR / EIO / other  | `READ_FAILED`        |
| `splitFrontmatter` failure                   | n/a — returns `null` |

The source task's `NOTE_NOT_FOUND` / `INVALID_PATH` codes are intentionally collapsed into the existing module-wide `NOT_FOUND` / `INVALID_ARGUMENT` to stay consistent with Batch 2. Functionally equivalent; cheaper to keep a small union.

### Top-level error codes

Top-level `INVALID_ARGUMENT` covers `paths.length` out of `[1,50]`, missing `paths`, empty `fields` array, or unknown `fields` value. Source task's `INVALID_PARAMS` is renamed to `INVALID_ARGUMENT` for the same consistency reason.

## Configuration

**No new CLI flag.** `--vault <path>` is already required (verified in `src/config.ts:18-20` — `demandOption: true`) and exposed as `config.vaultPath: string`. The operations module will pass that through to `FsVaultReader`. Existing setups continue to work unchanged.

## Testing

### `vault-reader.test.ts` (new)

`FsVaultReader` constructed with a fake `readFile`:

- One path, frontmatter present → returns `{ path, frontmatter, content }` with both fields populated.
- One path, no frontmatter → `frontmatter: null`, `content` is the full body.
- Malformed YAML → `frontmatter: null`, `content` is the full body (matches existing `splitFrontmatter` contract).
- Multiple paths → returns one item per input path, in input order. Order preserved even when reads finish out of order (simulate by varied async delays in fake).
- ENOENT on one path → that item carries `error: { code: 'NOT_FOUND' }`, others succeed.
- EACCES on one path → `error: { code: 'READ_FAILED' }`.
- `path.join(vaultRoot, p)` actually used — verified by inspecting the fake's call args.
- Reader does not project fields (always returns both frontmatter and content for successes).

### `tool-handlers.test.ts` (delta)

Drop the existing `readNote` block. Add `readNotes` with a fake `VaultReader`:

- One path → output equivalent to the old `read_note` shape (regression check that nothing downstream relied on the old structure).
- 50 paths → ok; 51 paths → top-level `INVALID_ARGUMENT`.
- Empty `paths: []` → top-level `INVALID_ARGUMENT`.
- Duplicates `['a','b','a']` → reader called with `['a','b']`; final results length 2; order preserved.
- `fields: ['frontmatter']` → success items have `frontmatter`, do **not** have `content`.
- `fields: ['content']` → mirror.
- `fields: []` → top-level `INVALID_ARGUMENT`.
- Invalid path `'../etc/passwd'` mixed with valid → invalid surfaces per-item `INVALID_ARGUMENT`, valid items proceed; reader receives only the valid paths.
- Reader returns `NOT_FOUND` for one path → that item's error passes through unchanged; `errors === 1`.
- **`read_property × N` scenario regression**: 8 paths + `fields: ['frontmatter']` → 8 successful items each with `frontmatter`, no `content`; demonstrates one MCP call replaces 8 `read_property` calls.

### `tools.test.ts` (delta)

- `buildOperationsTools(...)` returns 11 registrations, with `read_notes` present and `read_note` absent.
- Description contains the substrings `"1–50"` (or `"1-50"`), `"duplicates"`, `"per-item errors"`, `"vault-relative"`, `"do not require Obsidian"`.

### `obsidian-cli-provider.test.ts` (delta)

- Drop the `readNote` test block. Existing tests for the other 10 provider methods are unaffected.

### `server-modules.test.ts` (delta)

- Both modules on → 4 + 11 = **15** tools (unchanged).
- The `read_note` name is no longer in the list; `read_notes` is.
- `--no-operations` → 4 tools.
- `--no-semantic` → 11 tools.

### Manual smoke (pre-publish)

On a real vault, with **Obsidian closed** (this is the new and important property):

- 10 mixed real paths → all return correctly.
- One missing path among 10 → per-item `NOT_FOUND`, others succeed.
- 50 real paths → all return; latency clearly sub-100ms cold.
- `fields: ['frontmatter']` over a list of project notes → frontmatters returned, no `content`.
- Confirm via process list / Activity Monitor that no `obsidian` CLI is invoked.

## Architecture documentation deltas

### `docs/architecture/module-structure.md`

- Operations module tool count phrasing: still 11, but `read_note` → `read_notes`. Adjust the inline tool list.
- A new sentence under "End-to-end shape": "Reads (`read_notes`) go directly to the file system via `FsVaultReader`; everything else goes through the Obsidian CLI via `ObsidianCLIProvider`."

### `docs/architecture/vault-provider.md`

- Remove `readNote` from the interface listing.
- Update the "What it deliberately does not do" section's exception (#2) — the frontmatter-split exception now lives in `VaultReader`, not `VaultProvider`. `readDaily` keeps its own (it still parses CLI output).

### `docs/architecture/vault-reader.md` (new)

- One file per architectural concept, per `AGENTS.md` convention. Describes: what `VaultReader` is, why it exists separately from `VaultProvider`, what `FsVaultReader` reads and how it maps fs errors, why projection lives in the handler, and what would have to change for v2 (`VaultIndex` to back `frontmatter`-only reads without disk).

## README

- Tools matrix: replace `read_note` row with `read_notes`.
- Vault Operations section: a `read_notes` example showing both the full read and a `fields: ['frontmatter']` projection.
- Configuration table: unchanged (no new flag).
- A short **Migration to 2.0** subsection: "`read_note` has been removed. Use `read_notes(paths: ['Path/To/Note.md'])` for the single-note case as well. Reads no longer require Obsidian to be running."

## Definition of Done

- `read_notes` tool published and registered; `read_note` removed from the MCP surface.
- `FsVaultReader` is the only path that performs note-body reads; `ObsidianCLIProvider` no longer implements `readNote`.
- `npm test`, `npm run lint`, and `npx tsc --noEmit` all clean.
- Manual smoke test passed on a real vault, **with Obsidian closed**.
- README and architecture docs (`module-structure.md`, `vault-provider.md`, new `vault-reader.md`) updated in the same change.
- 2.0.0 released via `npm run release` from `main` (after merge), tag pushed via `git push --follow-tags`. `npm publish` after explicit user approval.
- Source task and `[[Build Vault Operations MCP Tools]]` master task updated by the user (not by the agent).
