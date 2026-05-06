# Add in-place edit support to `edit_note`

## Goal

Extend `edit_note` beyond `append` / `prepend` so MCP clients can fix wording
or rewrite a note's body without falling back to a filesystem `Edit` tool.
Today any non-trivial mid-file edit forces a hybrid access pattern (MCP for
some writes, raw filesystem for others), which breaks the promise that this
server is the complete vault-write interface.

Source of the problem: session 2026-05-01, where a freshly-created reflection
note had a wrong sentence in `## Контекст` and `edit_note` could not fix it.

## Scope

Add two new values to `position` on `edit_note`:

- `replace` — exact-string find/replace inside the note body.
- `replace_full` — overwrite the entire note body, leaving frontmatter intact.

`append` and `prepend` are unchanged (back-compat).

The full `position` union becomes:
`"append" | "prepend" | "replace" | "replace_full"`.

Section-level rewrites (e.g. "rewrite `## Status`") are deliberately not a
dedicated mode. The caller composes them: `read_notes` → modify the section
locally → `replace_full`. Less API surface, no heading-boundary parser, and
the LLM already excels at whole-body rewrites once it has the full text.

### `position: "replace"`

```ts
{
  name?: string,            // wikilink-style identifier
  path?: string,            // vault-relative POSIX path (one of name/path required)
  position: "replace",
  find: string,             // exact match, case-sensitive, whitespace-sensitive
  content: string,          // replacement (may be empty string to delete)
  replace_all?: boolean     // default false
}
```

Behaviour:

- Match is performed against the note **body** only — frontmatter (the
  `---\n…\n---\n` block at the start of the file) is never touched, even
  if `find` matches text inside it.
- If `find` does not appear in the body → `NOT_FOUND`.
- If `find` appears more than once and `replace_all` is false →
  `AMBIGUOUS_MATCH`, with `details.matches` listing the 1-based line
  number of each occurrence (relative to the start of the body).
- If `replace_all` is true, every occurrence is replaced.
- An empty `find` → `INVALID_ARGUMENT` (would otherwise match everywhere).
- An empty `content` is allowed (it deletes the matched text).

### `position: "replace_full"`

```ts
{
  name?: string,
  path?: string,
  position: "replace_full",
  content: string           // new note body (empty string allowed)
}
```

Behaviour:

- Replaces everything **after** the frontmatter block with `content`. The
  frontmatter prefix (`---\n…\n---\n`, including its trailing newline) is
  preserved byte-for-byte.
- If the note has no frontmatter, the entire file is replaced with
  `content`.
- `content` is written verbatim — the implementation does not add or strip
  trailing newlines. Callers that want a trailing newline include one in
  `content`.
- An empty `content` truncates the body to zero length (frontmatter, if
  present, remains).
- The note must already exist; missing path → `NOT_FOUND`. (For new notes,
  use `create_note`.)

### Out of scope

- Regex-based replace.
- Section-aware rewrites driven by heading boundaries.
- Editing frontmatter (use `set_property` / `remove_property`).
- Insert at arbitrary line number.
- Block-reference based edits.
- CRLF line-ending preservation — LF is assumed.

## Architecture

### New abstraction: `VaultWriter`

Direct filesystem writes get their own interface, mirroring `VaultReader`.
The user has an explicit goal of moving off the obsidian-cli over time, and
this is the foundation for that migration.

```ts
// src/lib/obsidian/vault-writer.ts
export interface VaultWriter {
  replaceInNote(input: ReplaceInNoteInput): Promise<void>;
  replaceFullBody(input: ReplaceFullBodyInput): Promise<void>;
}

export interface ReplaceInNoteInput {
  path: string; // vault-relative POSIX path
  find: string;
  content: string;
  replaceAll: boolean;
}

export interface ReplaceFullBodyInput {
  path: string;
  content: string;
}
```

Default implementation `FsVaultWriter` lives next to `FsVaultReader` and
takes the same `vaultRoot` plus injectable `readFile` / `writeFile` for
tests. The transform keeps the raw frontmatter prefix as a string slice so
its formatting (key order, comments, blank lines) is preserved byte-for-byte
— it is never re-serialised through a YAML library.

Writes are non-atomic single `fs.writeFile` calls. The vault is
single-writer per-MCP-call and notes are small; the upgrade to
write-temp-then-rename is a future concern.

### Wiring

`createOperationsModule` gets a third optional factory:

```ts
vaultWriterFactory?: (opts: { vaultRoot: string }) => VaultWriter;
```

`OperationsToolDeps` grows a `writer: VaultWriter` field.

### `edit_note` dispatch

The tool handler branches on `position`:

- `append` / `prepend` → `provider.editNote(...)` (unchanged path through
  obsidian-cli).
- `replace` / `replace_full` → resolve identifier to a path, then call
  `writer.replaceInNote(...)` or `writer.replaceFullBody(...)`.

#### Identifier resolution for write path

Direct-fs writes need a vault-relative path. When the caller supplies
`name`, the tool resolves it via `BasenameIndex` (from
`src/lib/obsidian/link-resolver.ts`) built from `reader.scan()`.
Behaviour:

- `name` resolves to exactly one path → use it.
- `name` resolves to more than one path → `AMBIGUOUS_MATCH` with
  `details.matches` listing candidate paths.
- Unresolved → `NOT_FOUND`.

When the caller supplies `path` directly, no resolution is needed; the
writer fails with `NOT_FOUND` if the file is missing.

The basename index is rebuilt per call. The vaults this tool targets are
small enough that this is fine; if it ever isn't, we'll memoise.

### Pure transform module

The replace logic lives in a pure module
`src/lib/obsidian/in-place-edit.ts`:

```ts
export interface FrontmatterSplit {
  prefix: string; // raw "---\n…\n---\n" or empty string
  body: string;
}

export function splitRawFrontmatter(raw: string): FrontmatterSplit;

export function applyReplace(
  body: string,
  find: string,
  replacement: string,
  replaceAll: boolean,
): { body: string } | { error: 'NOT_FOUND' } | { error: 'AMBIGUOUS_MATCH'; lines: number[] };
```

`FsVaultWriter.replaceInNote` reads the file, calls these pure functions,
and writes back `prefix + newBody`. `FsVaultWriter.replaceFullBody`
reads, calls `splitRawFrontmatter`, and writes `prefix + content`. All
non-trivial logic lives in the pure module so it can be tested without
touching disk.

## Errors

Mapped to `ToolHandlerError` codes already in use elsewhere:

| Condition                                       | Code               |
| ----------------------------------------------- | ------------------ |
| `find` empty / both `name` and `path` / neither | `INVALID_ARGUMENT` |
| Note path / wikilink does not resolve           | `NOT_FOUND`        |
| `find` text not present                         | `NOT_FOUND`        |
| Multiple `find` matches without `replace_all`   | `AMBIGUOUS_MATCH`  |
| Multiple paths resolve from a single `name`     | `AMBIGUOUS_MATCH`  |

`AMBIGUOUS_MATCH` is a new code; add to the existing error-code list.

## Tool description and server instructions

`edit_note.description` is rewritten to cover all four positions, with one
short example per mode. Server instructions (`src/server.ts` system prompt)
add: _"Use `replace` to fix exact wording, `replace_full` to rewrite the
whole body. Both leave frontmatter untouched."_

## Testing

Unit tests on the pure module (`in-place-edit.ts`):

- `splitRawFrontmatter` — with frontmatter, without, malformed (no closing
  `---`), and the empty-file edge case.
- `applyReplace` — happy single match; multiple matches without
  `replace_all` → `AMBIGUOUS_MATCH` with correct 1-based line numbers;
  with `replace_all` → all replaced; not found → `NOT_FOUND`; replacement
  containing the same text as `find` does not match itself recursively
  when `replace_all` is true.

Integration tests on `FsVaultWriter` against a temp-dir vault:

- `replaceInNote` round-trip preserving an exotic frontmatter block
  (commented YAML, key order, blank lines).
- `replaceFullBody` preserves frontmatter byte-for-byte.
- `replaceFullBody` on a note with no frontmatter overwrites the entire
  file.
- `replaceFullBody` with empty `content` leaves an empty body.

Tool-layer tests (`edit_note`):

- `append` / `prepend` regression: still calls `provider.editNote`.
- `replace` end-to-end via in-memory writer (DI).
- `replace_full` end-to-end via in-memory writer.
- Identifier resolution: `name` → unique path; `name` → ambiguous; `name`
  → unresolved; `path` directly; both `name` and `path` →
  `INVALID_ARGUMENT`; neither → `INVALID_ARGUMENT`.

## Definition of Done

- `position` union accepts `replace` and `replace_full`.
- `VaultWriter` interface and `FsVaultWriter` implementation landed,
  wired through `createOperationsModule` with a factory override.
- Pure transform module covered by unit tests; tool layer covered by
  integration tests; `npm test`, `npm run lint`, `npx tsc --noEmit` all
  green.
- Tool description updated with one example per mode.
- Server instructions mention the new modes once.
- README's edit-note coverage lists all four positions.
- Conventional Commit: `feat(edit_note): support in-place replace and replace_full`.
- Released as a minor version on `main` per the standard release flow.

## Connections

- Vault task note: `Tasks/Add in-place edit support to edit_note.md`
  (note: original task included `replace_section`; this spec collapses it
  into `replace_full` per 2026-05-06 brainstorming).
- Source incident: `Reflections/2026-05-01 — early exits.md`.
